/**
 * workspaceSummaryService —— 为每个 workspace 生成 AI 摘要 + slogan，写入
 * Workspace.aiSummary / aiSlogan / aiSummaryAt。TopBar 第二行渲染这两段文字。
 *
 * 触发节奏：
 *   - 每天 UTC+8 04:00 之后的第一次 heartbeat tick 触发一次全量刷新（每个
 *     workspace 一次 LLM 调用）。
 *   - 实现上 heartbeat onTick 是每个 agent 都跑一次（5min/tick × N agents），
 *     所以本服务用一个 module-level `lastRunAt` 做"今天是否已经跑过"的去重，
 *     第一个 agent 触发后剩下的 agent 在同一天内全部跳过。
 *   - 失败不抛 —— 摘要丢一两次不能阻塞 heartbeat 主流程，silently log。
 *
 * Token 记账：通过 provider adapter 的 `recordContext`，feature="workspace-summary"。
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { resolveAdapter, resolveModelForCall } from "./modelRegistry.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Run-once-per-day guard ──────────────────────────────────────────────

/** ISO date string (yyyy-mm-dd in UTC+8) of the most recent run. */
let lastRunDayKey: string | null = null;
/** True while a refresh pass is mid-flight; prevents concurrent kicks. */
let inflight = false;

/** UTC+8 calendar date as yyyy-mm-dd. Used as the "today" key. */
function utc8DayKey(d: Date = new Date()): string {
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** UTC+8 hour 0-23. Used to gate "after 04:00" trigger. */
function utc8Hour(d: Date = new Date()): number {
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return shifted.getUTCHours();
}

// ─── Prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `# 角色
你是飞书多维表格（Lark Base）的工作区编辑助手。你的任务是基于工作区里的数据表 / 灵感文档 / 画布的名称列表，给这个工作区写一段简短的"中性介绍"和一句"slogan"。

# 输出
必须输出且仅输出一个 JSON 对象，格式：
{ "summary": "...", "slogan": "..." }

# 要求
- summary：50 字以内的中文短语，一句话客观介绍这个工作区的内容主题，不夸张、不带情绪标签。
- slogan：20 字以内的中文短句，富有创意但落地，能呼应实际内容（不要套用空话）。
- 工作区为空时，summary 写"刚开始的空白工作区"，slogan 写"未来从一张空表开始"。
- 严禁加 Markdown 代码块、严禁解释、严禁追问。`;

function buildUserPrompt(input: {
  name: string;
  description: string | null;
  tableNames: string[];
  ideaTitles: string[];
  designNames: string[];
}): string {
  const lines: string[] = [];
  lines.push(`# 工作区名称\n${input.name}`);
  if (input.description) lines.push(`# 工作区描述\n${input.description}`);
  lines.push(
    `# 数据表（${input.tableNames.length}）\n${input.tableNames.slice(0, 30).join("、") || "（无）"}`,
  );
  lines.push(
    `# 灵感文档（${input.ideaTitles.length}）\n${input.ideaTitles.slice(0, 30).join("、") || "（无）"}`,
  );
  lines.push(
    `# 画布（${input.designNames.length}）\n${input.designNames.slice(0, 30).join("、") || "（无）"}`,
  );
  lines.push("\n请输出 JSON。");
  return lines.join("\n\n");
}

// ─── Single workspace generation ─────────────────────────────────────────

interface SummaryResult {
  summary: string;
  slogan: string;
}

function tryParseSummary(raw: string): SummaryResult | null {
  let s = raw.trim();
  // Strip Markdown fence
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  // Find first { ... last }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    const slogan = typeof obj.slogan === "string" ? obj.slogan.trim() : "";
    if (!summary || !slogan) return null;
    return { summary, slogan };
  } catch {
    return null;
  }
}

async function generateForWorkspace(workspaceId: string): Promise<void> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      description: true,
      createdById: true,
    },
  });
  if (!ws) return;

  const [tables, ideas, designs] = await Promise.all([
    prisma.table.findMany({ where: { workspaceId }, select: { name: true } }),
    prisma.idea.findMany({ where: { workspaceId }, select: { name: true } }),
    prisma.design.findMany({ where: { workspaceId }, select: { name: true } }),
  ]);

  const userPrompt = buildUserPrompt({
    name: ws.name,
    description: ws.description,
    tableNames: tables.map((t) => t.name),
    ideaTitles: ideas.map((i) => i.name),
    designNames: designs.map((d) => d.name),
  });

  // 用 doubao-2.0 兜底（最便宜也最稳定，summary 是非交互场景，不需要 Claude）
  const { resolved } = resolveModelForCall("doubao-2.0");
  const provider = resolveAdapter(resolved);

  let raw = "";
  try {
    for await (const ev of provider.stream({
      model: resolved,
      input: [
        { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
        { role: "user", content: [{ type: "input_text", text: userPrompt }] },
      ],
      recordContext: {
        userId: ws.createdById,
        workspaceId: ws.id,
        feature: "workspace-summary",
      },
    })) {
      if (ev.kind === "text_delta") raw += ev.text;
      else if (ev.kind === "error") {
        console.warn(`[workspaceSummary] ${workspaceId}: error event ${ev.message}`);
        return;
      } else if (ev.kind === "done") {
        break;
      }
    }
  } catch (err) {
    console.warn(`[workspaceSummary] ${workspaceId}: stream failed`, err);
    return;
  }

  const parsed = tryParseSummary(raw);
  if (!parsed) {
    console.warn(`[workspaceSummary] ${workspaceId}: parse failed; raw=${raw.slice(0, 200)}`);
    return;
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      aiSummary: parsed.summary,
      aiSlogan: parsed.slogan,
      aiSummaryAt: new Date(),
    },
  });
  console.log(`[workspaceSummary] ${workspaceId}: refreshed (${parsed.summary.length} / ${parsed.slogan.length} chars)`);
}

// ─── Public entry: heartbeat-driven daily refresh ────────────────────────

/**
 * heartbeat onTick 调用入口。检查"今天 UTC+8 04:00 之后是否已经跑过一次"，
 * 没跑过就刷新所有 workspace。失败不抛。
 *
 * 因为 heartbeat 是 per-agent 的（每个 tick 多个 agent 都会调用一次本函数），
 * 这里用 lastRunDayKey 做去重，第一个进入的 agent 触发，剩下的全部跳过。
 *
 * `force=true` 跳过日期 / 小时的早退，并把所有 workspace 视作"今天还没跑过"
 * （清掉 aiSummaryAt 是不破坏性的：哪个 workspace 已经有最新摘要就重新生成
 * 一遍而已）。boot-time / 一次性 admin 操作用。
 */
export async function maybeRefreshDailySummaries(
  now: Date = new Date(),
  opts: { force?: boolean } = {},
): Promise<void> {
  const dayKey = utc8DayKey(now);
  const hour = utc8Hour(now);
  const force = opts.force === true;

  // 还没到 04:00（UTC+8）就跳过 —— 留给凌晨过后第一次 tick。
  if (!force && hour < 4) return;
  if (!force && lastRunDayKey === dayKey) return;
  if (inflight) return;

  inflight = true;
  if (!force) lastRunDayKey = dayKey; // force 模式不要污染 daily 去重
  try {
    const workspaces = await prisma.workspace.findMany({
      select: { id: true, aiSummaryAt: true },
    });
    let refreshed = 0;
    for (const ws of workspaces) {
      if (!force) {
        const lastRun = ws.aiSummaryAt ? utc8DayKey(ws.aiSummaryAt) : null;
        if (lastRun === dayKey) continue;
      }
      try {
        await generateForWorkspace(ws.id);
        refreshed++;
      } catch (err) {
        console.warn(`[workspaceSummary] ${ws.id}: generate failed`, err);
      }
    }
    console.log(`[workspaceSummary] ${force ? "force" : "daily"} refresh ${dayKey} done — ${refreshed} workspaces refreshed`);
  } catch (err) {
    console.warn(`[workspaceSummary] daily refresh failed:`, err);
    if (!force) lastRunDayKey = null; // 失败时回滚 dayKey 以便下次 tick 重试
  } finally {
    inflight = false;
  }
}

/**
 * 在 workspace 刚创建时调一次 —— 不等到 heartbeat 04:00 才有内容显示。
 * 失败不抛。authService.createUserWithWorkspace 里调用。
 */
export async function generateInitialSummary(workspaceId: string): Promise<void> {
  try {
    await generateForWorkspace(workspaceId);
  } catch (err) {
    console.warn(`[workspaceSummary] initial gen failed for ${workspaceId}:`, err);
  }
}

/**
 * Boot-time 一次性补全 —— 扫描所有 aiSummary IS NULL 的 workspace 并生成。
 * 已有摘要的 workspace 直接跳过（幂等：重启不浪费 token,不覆盖已有内容）。
 * 失败不抛,顺序串行（避免一次性打太多模型请求）。
 */
export async function regenerateMissingSummaries(): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const workspaces = await prisma.workspace.findMany({
      where: { aiSummary: null },
      select: { id: true },
    });
    if (workspaces.length === 0) return;
    let done = 0;
    for (const ws of workspaces) {
      try {
        await generateForWorkspace(ws.id);
        done++;
      } catch (err) {
        console.warn(`[workspaceSummary] missing-fill failed for ${ws.id}:`, err);
      }
    }
    console.log(`[workspaceSummary] missing-fill done — ${done}/${workspaces.length} workspaces generated`);
  } finally {
    inflight = false;
  }
}
