/**
 * tasteMetaService — generate structured design-style metadata for each Taste's SVG.
 *
 * Meta is consumed by the Chat Agent via MCP `get_taste(includeMeta:true)`. It is
 * NOT rendered in the frontend (per plan Phase 1 decision, 2026-04-22).
 *
 * ## Generation timing (two-track)
 *
 *   - Post-create hooks in `tasteRoutes.ts` call `enqueueMetaGeneration(tasteId)`
 *     → background queue (max 3 concurrent) → eventually writes back to DB
 *   - MCP `get_taste(includeMeta:true)` calls `getMeta(tasteId, {syncIfMissing:true})`
 *     which blocks on a single synchronous generation if meta is missing
 *
 * ## Model selection
 *
 * Uses the Agent's currently-selected model via `resolveModelForCall()` +
 * `resolveAdapter()`. Doubao-2.0 is the universal fallback.
 *
 * ## Log
 *
 * Appends one JSON line per call to `backend/logs/taste-meta-YYYY-MM-DD.log`
 * (GMT+8 timestamps, matching aiService.ts convention).
 */

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { eventBus } from "./eventBus.js";
import {
  resolveModelForCall,
  resolveAdapter,
  type ModelEntry,
} from "./modelRegistry.js";
import { getSelectedModel } from "./agentService.js";
import { tasteMetaSchema, type TasteMeta } from "../schemas/tasteSchema.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter } as any);

// ─── Config ───

const MAX_CONCURRENT = 3;
const SVG_TRUNCATE_BYTES = 8 * 1024;     // Prompt context cap — first 8 KB of SVG
const RETRY_BACKOFF_MS = [1000, 2000];   // two retries (1s then 2s)
const MAX_OUTPUT_TOKENS = 1024;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOGS_DIR = path.resolve(__dirname, "../../logs");

// ─── Hash / logging helpers ───

function hashSvg(svg: string): string {
  return crypto.createHash("sha256").update(svg).digest("hex").slice(0, 16);
}

function gmt8Iso(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 23);
}

async function logMetaCall(entry: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(LOGS_DIR, { recursive: true });
    const date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const file = path.join(LOGS_DIR, `taste-meta-${date}.log`);
    await fs.appendFile(file, JSON.stringify({ ts: gmt8Iso(), ...entry }) + "\n", "utf-8");
  } catch {
    /* best-effort; never let log failure break generation */
  }
}

// ─── Prompt ───

// Prompt follows `.claude/skills/ai-prompt-patterns.md` standard structure:
//   Role → Output constraints (highest priority) → Format → Type rules →
//   Constraints → Few-shot example. Precision task (structured JSON) → temp 0.1.
function buildMetaPrompt(svg: string): string {
  const truncated = Buffer.byteLength(svg, "utf-8") > SVG_TRUNCATE_BYTES
    ? svg.slice(0, SVG_TRUNCATE_BYTES) + "\n<!-- SVG truncated at 8KB -->"
    : svg;

  return `# 角色
你是一位资深 UI 设计系统分析师，负责从 SVG 源码中提取视觉设计风格元数据，供下游 Agent 做组件检索、风格对齐、自动配色。

# 输出约束（最高优先级）
1. 你的最终输出有且只有一个 JSON 对象，不包含任何其他内容
   （无解释、无确认、无 Markdown 代码块围栏 \`\`\`json、无自然语言说明）
2. 识别不到 / 不确定的字段**直接省略该键**（不要输出 null、""、"unknown" 等占位值）
3. 最终 JSON 之后不得追加任何文字
4. 整个 JSON ≤ 500 字符

# JSON Schema
\`\`\`
{
  "themeColor":   string   // 主色调（出现频率最高的非灰/黑/白色）
  "hoverColor":   string   // 推断的 hover 色（主色 ±10% 亮度）
  "auxColors":    string[] // 辅助色，最多 5 个
  "fontFamily":   string   // 字体族名
  "fontSize":     number   // 主文本字号 (px)
  "lineHeight":   number | string
  "padding":      string   // CSS padding，如 "12px 16px"
  "gap":          number | string
  "borderRadius": number | string
  "boxWidth":     number   // 主容器宽度 (px)
  "boxHeight":    number   // 主容器高度 (px)
  "shadow":       string   // CSS box-shadow 字符串
  "tags":         string[] // 组件类型（button / card / modal / input / navbar / badge / tooltip / toast ...）
  "description":  string   // 一句话概括，≤40 字
}
\`\`\`

# 类型规则（严格）
- 颜色值：小写 hex，格式 \`#aabbcc\` 或 \`#aabbccdd\`；不要用 rgb()/hsl()/颜色名
- 字号 / 圆角 / 边长：纯数字，不带 "px" 后缀
- padding / shadow：完整 CSS 字符串，保留单位
- tags：只用上面括号里列举的标签，不得编造新标签
- fontFamily：取 SVG 里出现的字体族名（如 "Inter", "PingFang SC"），没有就省略

# 识别策略
- themeColor：统计 \`fill\` 和 \`stroke\` 属性，排除 \`#fff/#ffffff/#000/#000000/#f5f5f5\` 一类中性色
- boxWidth/boxHeight：从根 \`<svg>\` 的 \`viewBox\` 或 \`width/height\` 属性读取
- borderRadius：从 \`<rect rx="...">\` 读取；多个 rect 取出现频率最高的
- shadow：从 \`<filter>\` 里的 \`feGaussianBlur\` / \`feDropShadow\` 推断，没有就省略
- tags：综合 viewBox 比例 + 主要形状 + 文本内容推断（如 "Submit"+按钮形状 → button；卡片尺寸 >300px + 多文本 → card）

# 降级规则（Graceful Degradation）
- SVG 解析失败 / 完全识别不出设计风格时，输出 \`{"description":"无法从 SVG 推断设计风格"}\`
- **绝不输出空对象 \`{}\`**（前端会把空对象当成 ready 缓存）
- 绝不拒绝、绝不解释、绝不追问

# 示例输出
输入是一个蓝底圆角按钮，白字 "Submit"，16px Inter 字体，8px 圆角：
\`\`\`
{"themeColor":"#1456f0","hoverColor":"#1246d1","fontFamily":"Inter","fontSize":16,"padding":"10px 20px","borderRadius":8,"boxWidth":96,"boxHeight":36,"tags":["button"],"description":"蓝色主按钮，圆角中等，无阴影"}
\`\`\`

# SVG
${truncated}`;
}

// ─── Stream → string ───

async function runSingleShot(
  model: ModelEntry,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const provider = resolveAdapter(model);
  let out = "";
  for await (const ev of provider.stream({
    model,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    signal,
  })) {
    if (ev.kind === "text_delta") out += ev.text;
    else if (ev.kind === "error") throw new Error(ev.message);
    else if (ev.kind === "done") break;
  }
  return out;
}

// ─── JSON parse (tolerant) ───

function extractJsonObject(raw: string): unknown {
  // Strip Markdown fences if present
  let s = raw.trim();
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fenceMatch) s = fenceMatch[1].trim();

  // First { ... last }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object found");
  }
  const jsonStr = s.slice(start, end + 1);
  return JSON.parse(jsonStr);
}

// ─── Core generation ───

export interface GenerateMetaOptions {
  /** Agent whose selected model to use; defaults to `agent_default`. */
  agentId?: string;
  /** Skip retries (for sync path that needs fast failure). */
  singleAttempt?: boolean;
  signal?: AbortSignal;
}

async function generateMetaFromSvg(
  svg: string,
  opts: GenerateMetaOptions = {},
): Promise<TasteMeta | null> {
  const agentId = opts.agentId ?? "agent_default";
  const selected = await getSelectedModel(agentId).catch(() => null);
  const { resolved } = resolveModelForCall(selected);

  const prompt = buildMetaPrompt(svg);
  const attempts = opts.singleAttempt ? 1 : RETRY_BACKOFF_MS.length + 1;
  let lastError: unknown = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const raw = await runSingleShot(resolved, prompt, opts.signal);
      const parsed = extractJsonObject(raw);
      const validated = tasteMetaSchema.safeParse(parsed);
      if (!validated.success) {
        throw new Error("schema validation failed: " + validated.error.message);
      }
      await logMetaCall({
        agent: agentId,
        model: resolved.id,
        attempt: i + 1,
        ok: true,
        bytes: raw.length,
      });
      return validated.data;
    } catch (err: any) {
      lastError = err;
      await logMetaCall({
        agent: agentId,
        model: resolved.id,
        attempt: i + 1,
        ok: false,
        error: String(err?.message ?? err),
      });
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[i]));
      }
    }
  }

  console.warn("[taste-meta] generation failed after retries:", lastError);
  return null;
}

// ─── DB operations ───

async function persistMeta(
  tasteId: string,
  meta: TasteMeta | null,
  svgHash: string,
): Promise<void> {
  await prisma.taste.update({
    where: { id: tasteId },
    data: {
      meta: meta as any,
      metaGeneratedAt: new Date(),
      svgHash,
    },
  });

  // Notify workspace listeners (FE may want to refresh "has meta" indicator)
  const taste = await prisma.taste.findUnique({
    where: { id: tasteId },
    include: { design: { select: { workspaceId: true } } },
  });
  if (taste?.design?.workspaceId) {
    eventBus.emitWorkspaceChange({
      type: "taste:meta-updated",
      workspaceId: taste.design.workspaceId,
      clientId: "system",
      timestamp: Date.now(),
      payload: {
        tasteId,
        designId: taste.designId,
        hasMeta: meta !== null,
      },
    });
  }
}

async function readTasteSvg(tasteId: string): Promise<string | null> {
  const taste = await prisma.taste.findUnique({ where: { id: tasteId } });
  if (!taste?.filePath) return null;
  const abs = path.resolve(__dirname, "../../..", taste.filePath);
  try {
    return await fs.readFile(abs, "utf-8");
  } catch {
    return null;
  }
}

// ─── Queue ───

interface QueueEntry {
  tasteId: string;
  agentId?: string;
  /** deduplication guard */
  enqueuedAt: number;
}

const pending = new Map<string, QueueEntry>();
let running = 0;

function kick(): void {
  while (running < MAX_CONCURRENT && pending.size > 0) {
    const next = pending.values().next().value as QueueEntry | undefined;
    if (!next) break;
    pending.delete(next.tasteId);
    running++;
    void processOne(next).finally(() => {
      running--;
      kick();
    });
  }
}

async function processOne(entry: QueueEntry): Promise<void> {
  try {
    const svg = await readTasteSvg(entry.tasteId);
    if (!svg) {
      await logMetaCall({ tasteId: entry.tasteId, ok: false, error: "svg not readable (file missing on disk)" });
      // Mark as permanently-failed so the sync path doesn't treat it as
      // "never tried" and retry forever. Hash set to "" so a later upload
      // with real bytes naturally mismatches and re-triggers.
      await persistMeta(entry.tasteId, null, "").catch(() => {/* best effort */});
      return;
    }
    const hash = hashSvg(svg);
    const meta = await generateMetaFromSvg(svg, { agentId: entry.agentId });
    await persistMeta(entry.tasteId, meta, hash);
  } catch (err: any) {
    console.error(`[taste-meta] queue processOne failed for ${entry.tasteId}:`, err);
  }
}

/**
 * Enqueue a background meta generation. No-op if already pending.
 * Fire-and-forget — callers (e.g. POST /tastes/upload handler) return immediately.
 */
export function enqueueMetaGeneration(tasteId: string, agentId?: string): void {
  if (pending.has(tasteId)) return;
  pending.set(tasteId, { tasteId, agentId, enqueuedAt: Date.now() });
  kick();
}

/**
 * Read meta synchronously. If missing and `syncIfMissing: true`, generate once
 * right now (blocks until done or failed). Used by MCP `get_taste(includeMeta:true)`.
 */
export async function getMeta(
  tasteId: string,
  opts: { syncIfMissing?: boolean; agentId?: string } = {},
): Promise<{ meta: TasteMeta | null; generatedAt: Date | null; status: "ready" | "missing" | "failed" }> {
  const taste = await prisma.taste.findUnique({
    where: { id: tasteId },
    select: { meta: true, metaGeneratedAt: true },
  });
  if (!taste) return { meta: null, generatedAt: null, status: "missing" };

  if (taste.meta !== null && taste.meta !== undefined) {
    return {
      meta: taste.meta as unknown as TasteMeta,
      generatedAt: taste.metaGeneratedAt,
      status: "ready",
    };
  }

  // Already attempted and failed (metaGeneratedAt set, meta null)
  if (taste.metaGeneratedAt !== null && !opts.syncIfMissing) {
    return { meta: null, generatedAt: taste.metaGeneratedAt, status: "failed" };
  }

  if (!opts.syncIfMissing) {
    return { meta: null, generatedAt: null, status: "missing" };
  }

  // Sync generate
  const svg = await readTasteSvg(tasteId);
  if (!svg) {
    // SVG file is unreadable (missing on disk or decode error). Mark as failed
    // so we don't retry forever and the Agent stops re-asking. Use an empty-hash
    // sentinel so a future upload with real bytes will still trigger regeneration
    // via the hash-mismatch path.
    await logMetaCall({ tasteId, ok: false, error: "svg not readable (file missing on disk)" });
    await persistMeta(tasteId, null, "");
    return { meta: null, generatedAt: new Date(), status: "failed" };
  }
  const hash = hashSvg(svg);
  const meta = await generateMetaFromSvg(svg, { agentId: opts.agentId, singleAttempt: true });
  await persistMeta(tasteId, meta, hash);
  return {
    meta,
    generatedAt: new Date(),
    status: meta ? "ready" : "failed",
  };
}

/**
 * Force regeneration regardless of existing cache. Used by POST /meta/regenerate.
 */
export async function regenerateMeta(
  tasteId: string,
  opts: { agentId?: string } = {},
): Promise<{ meta: TasteMeta | null; status: "ready" | "failed" | "missing" }> {
  const svg = await readTasteSvg(tasteId);
  if (!svg) return { meta: null, status: "missing" };
  const hash = hashSvg(svg);
  const meta = await generateMetaFromSvg(svg, { agentId: opts.agentId });
  await persistMeta(tasteId, meta, hash);
  return { meta, status: meta ? "ready" : "failed" };
}
