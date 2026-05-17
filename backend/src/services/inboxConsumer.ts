/**
 * inboxConsumer — consume fired cron inbox messages by running the Agent.
 *
 * When `evaluateCron` fires a habit, it writes an InboxMessage to inbox.jsonl.
 * This module picks up those messages, creates a headless conversation, runs
 * `runAgent` with the habit's prompt, and marks the message as read.
 *
 * Called fire-and-forget from the heartbeat onTick so LLM latency doesn't
 * block the re-entrancy guard. A module-level lock prevents overlapping runs.
 */

import { appendMessage, createConversation, findConversationByAnchor } from "./conversationStore.js";
import { ackInboxMessage, readInbox, getAgent, type InboxMessage } from "./agentService.js";
import { listUserWorkspaces } from "./authService.js";
import { listCronJobs } from "./cronScheduler.js";
import { runAgent, type AgentContext } from "./chatAgentService.js";
import { generateForWorkspace } from "./workspaceSummaryService.js";
import {
  formatTodoSuggestionRun,
  refreshSuggestions,
  refreshGoalSuggestions,
  SUGGESTION_MODEL_ID,
} from "./suggestionService.js";
import type { EvaluateCronResult } from "./cronScheduler.js";

/**
 * Resolve which workspace a habit run should land in. Old code hard-coded
 * `doc_default` as fallback,但所有非 default 用户的 agent 也会 fall back,
 * 把他们的 habit 对话都倒进 user_default 的 doc_default workspace —— 用户
 * 在自己的 chat 里看到一堆别人 agent 的"Habit: ..."conv,且自己历史对话
 * 被淹没。修复:走 agent → owning user → user 的第一个 workspace 链路。
 */
async function resolveWorkspaceIdForAgent(
  agentId: string,
  inboxMeta: InboxMessage["meta"],
): Promise<string | null> {
  // 1. inbox.meta.workspaceId 优先(如果 cron job 显式指定了)
  const fromMeta = inboxMeta?.workspaceId;
  if (typeof fromMeta === "string" && fromMeta) return fromMeta;
  // 2. agent → user → user's primary workspace
  try {
    const agent = await getAgent(agentId);
    if (!agent) return null;
    const wss = await listUserWorkspaces(agent.userId);
    return wss[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Per-agent guard — same agent serializes(避免一个 agent 并发跑多 habit
 *  把 LLM 打爆),不同 agent 互不阻塞。
 *
 *  历史 bug:之前是 module-level 单 boolean,Testtenant 跑 suggest 30+ 秒
 *  期间,agent_default 的 cron tick 在另一个时区点 fire,evaluateCron 已经
 *  把 lastFiredAt 写进 cron.json,但 consumeFiredJobs 看到 consuming=true
 *  直接 skip → 任务永久丢失(下次 tick 因为 lastFiredAt 已设而不再 fire)。
 *  日志里翻出来 18 条 "skipped: previous batch still running",对应 18 个
 *  被永远丢失的 habit 触发。 */
const consumingByAgent = new Set<string>();

export interface FiredJob {
  job: EvaluateCronResult["fired"][number]["job"];
  inboxMessage: InboxMessage;
}

/**
 * Recovery: pick up cron inbox messages that are still unread —— previous
 * heartbeat ticks that got blocked by the per-agent lock would write inbox
 * + bump lastFiredAt but never consume. Without this recovery,evaluateCron
 * won't re-fire (lastFiredAt is set),the message is permanently orphaned.
 *
 * Called from the same heartbeat onTick that calls consumeFiredJobs(fired)
 * for the freshly-fired batch. We merge the orphans in BEFORE the fresh
 * batch so they're processed first.
 */
export async function recoverOrphanedJobs(agentId: string): Promise<FiredJob[]> {
  try {
    const [inbox, jobs] = await Promise.all([
      readInbox(agentId, { onlyUnread: true, limit: 50 }),
      listCronJobs(agentId),
    ]);
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const orphans: FiredJob[] = [];
    for (const msg of inbox) {
      if (msg.source !== "cron") continue;
      const cronJobId = (msg.meta?.cronJobId as string) || null;
      if (!cronJobId) continue;
      const job = jobById.get(cronJobId);
      if (!job) continue; // job was deleted; skip orphan
      orphans.push({ job: job as FiredJob["job"], inboxMessage: msg });
    }
    return orphans;
  } catch (err) {
    console.error(`[inbox-consumer] recoverOrphanedJobs failed for ${agentId}:`, err);
    return [];
  }
}

/**
 * Consume fired cron jobs by running the Agent headlessly.
 * Jobs are executed serially within an agent to avoid parallel LLM pressure;
 * different agents run concurrently. Errors in one job don't block the others.
 */
export async function consumeFiredJobs(
  agentId: string,
  fired: FiredJob[],
): Promise<void> {
  if (fired.length === 0) return;
  if (consumingByAgent.has(agentId)) {
    console.warn(`[inbox-consumer] agent ${agentId}: previous batch still running, skipping`);
    return;
  }
  consumingByAgent.add(agentId);
  try {
    for (const { job, inboxMessage } of fired) {
      await consumeOne(agentId, job, inboxMessage);
    }
  } finally {
    consumingByAgent.delete(agentId);
  }
}

async function consumeOne(
  agentId: string,
  job: FiredJob["job"],
  inboxMessage: InboxMessage,
): Promise<void> {
  const jobId = job.id;
  const prompt = inboxMessage.body || inboxMessage.subject;
  const workspaceId = await resolveWorkspaceIdForAgent(agentId, inboxMessage.meta);
  if (!workspaceId) {
    console.warn(
      `[inbox-consumer] habit "${jobId}" agent=${agentId}: no resolvable workspace, skipping`,
    );
    // Ack the message so we don't keep retrying — the agent has no workspace
    // (orphaned account?) and there's nothing to do.
    await ackInboxMessage(agentId, inboxMessage.id).catch(() => undefined);
    return;
  }
  const displayName =
    (job as any).displayName || jobId;

  // Special case: slogan habit doesn't go through the chat agent — it just
  // calls the workspace summary service directly (one LLM call, JSON-out,
  // writes Workspace.aiSlogan). Going through the chat loop would be
  // overkill (multi-round tool calls, conversation persistence) and also
  // wouldn't correctly write to the DB without a new MCP tool.
  // 刷新 agent 拥有的所有 workspace 的 slogan,不只是 [0] —— 一个用户可能
  // 有多个 workspace 但 TopBar 在不同 workspace 之间会切换。
  if (jobId === "habit_system_slogan") {
    console.log(`[inbox-consumer] executing slogan habit "${jobId}"`);
    try {
      const agent = await getAgent(agentId);
      const workspaces = agent ? await listUserWorkspaces(agent.userId) : [];
      let refreshed = 0;
      for (const ws of workspaces) {
        try {
          await generateForWorkspace(ws.id);
          refreshed++;
        } catch (err) {
          console.warn(`[inbox-consumer] slogan ws=${ws.id} failed:`, err);
        }
      }
      console.log(`[inbox-consumer] slogan habit done — ${refreshed}/${workspaces.length} workspaces refreshed`);
    } catch (err) {
      console.error(`[inbox-consumer] slogan habit failed:`, err);
    }
    await ackInboxMessage(agentId, inboxMessage.id).catch(() => undefined);
    return;
  }

  // Special case: suggest habit directly refreshes the suggestion + goal caches
  // instead of going through the chat agent loop. Same rationale as slogan:
  // the chat loop would produce conversation messages that never reach the
  // in-memory cache the welcome page reads from.
  if (jobId === "habit_system_suggest") {
    console.log(`[inbox-consumer] executing suggest habit "${jobId}"`);
    try {
      const agent = await getAgent(agentId);
      const workspaces = agent ? await listUserWorkspaces(agent.userId) : [];
      let refreshed = 0;
      for (const ws of workspaces) {
        const startedAt = Date.now();
        try {
          const suggestions = await refreshSuggestions(ws.id, { force: true });
          const goals = await refreshGoalSuggestions(ws.id, { force: true });
          let conv = await findConversationByAnchor({
            agentId,
            workspaceId: ws.id,
            attachedToType: "habit",
            attachedToId: jobId,
          });
          if (!conv) {
            conv = await createConversation(
              ws.id,
              `Habit: ${displayName}`,
              agentId,
              { type: "habit", id: jobId },
            );
          }
          await appendMessage(conv.id, {
            role: "user",
            content: prompt,
            source: `habit:${jobId}`,
          });
          await appendMessage(conv.id, {
            role: "assistant",
            content: formatTodoSuggestionRun({
              workspaceId: ws.id,
              generatedAt: new Date().toISOString(),
              suggestions,
              goals,
            }),
            durationMs: Date.now() - startedAt,
            modelId: SUGGESTION_MODEL_ID,
            source: `habit:${jobId}`,
          });
          refreshed++;
        } catch (err) {
          console.warn(`[inbox-consumer] suggest ws=${ws.id} failed:`, err);
        }
      }
      console.log(`[inbox-consumer] suggest habit done — ${refreshed}/${workspaces.length} workspaces refreshed`);
    } catch (err) {
      console.error(`[inbox-consumer] suggest habit failed:`, err);
    }
    await ackInboxMessage(agentId, inboxMessage.id).catch(() => undefined);
    return;
  }

  console.log(`[inbox-consumer] executing habit "${displayName}" (${jobId})`);

  try {
    // 1. Reuse the same per-habit conversation across fires —— 用户期望:
    //    每个 habit 一条长对话,跨天积累上下文(类似 Slack 频道)。除非用户
    //    手动删了对话(delete cascade),否则永远 reuse。新 habit / 删除后
    //    重新触发 → 会落到 createConversation 创建新的。
    let conv = await findConversationByAnchor({
      agentId,
      workspaceId,
      attachedToType: "habit",
      attachedToId: jobId,
    });
    if (!conv) {
      conv = await createConversation(
        workspaceId,
        `Habit: ${displayName}`,
        agentId,
        { type: "habit", id: jobId },
      );
    }

    // 2. Build headless AgentContext (no HTTP request, no auth token)
    const ctx: AgentContext = {
      conversationId: conv.id,
      workspaceId,
      agentId,
    };

    // 3. Run agent — drain the async generator (no SSE consumer)
    for await (const _event of runAgent(ctx, prompt)) {
      // discard — no frontend to stream to
    }

    // 4. Mark inbox message as read
    await ackInboxMessage(agentId, inboxMessage.id);

    console.log(
      `[inbox-consumer] habit "${displayName}" completed (conv=${conv.id})`,
    );
  } catch (err) {
    console.error(
      `[inbox-consumer] habit "${displayName}" failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}
