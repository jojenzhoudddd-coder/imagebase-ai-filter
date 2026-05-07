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

import { createConversation, findConversationByAnchor } from "./conversationStore.js";
import { ackInboxMessage, type InboxMessage } from "./agentService.js";
import { runAgent, type AgentContext } from "./chatAgentService.js";
import type { EvaluateCronResult } from "./cronScheduler.js";

const DEFAULT_WORKSPACE_ID = "doc_default";

/** Module-level guard — skip if a previous consume batch is still running. */
let consuming = false;

export interface FiredJob {
  job: EvaluateCronResult["fired"][number]["job"];
  inboxMessage: InboxMessage;
}

/**
 * Consume fired cron jobs by running the Agent headlessly.
 * Jobs are executed serially to avoid parallel LLM pressure.
 * Errors in one job don't block the others.
 */
export async function consumeFiredJobs(
  agentId: string,
  fired: FiredJob[],
): Promise<void> {
  if (fired.length === 0) return;
  if (consuming) {
    console.warn("[inbox-consumer] skipped: previous batch still running");
    return;
  }
  consuming = true;
  try {
    for (const { job, inboxMessage } of fired) {
      await consumeOne(agentId, job, inboxMessage);
    }
  } finally {
    consuming = false;
  }
}

async function consumeOne(
  agentId: string,
  job: FiredJob["job"],
  inboxMessage: InboxMessage,
): Promise<void> {
  const jobId = job.id;
  const prompt = inboxMessage.body || inboxMessage.subject;
  const workspaceId =
    (inboxMessage.meta?.workspaceId as string) || DEFAULT_WORKSPACE_ID;
  const displayName =
    (job as any).displayName || jobId;

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
