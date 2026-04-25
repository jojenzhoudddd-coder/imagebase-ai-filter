/**
 * tokenUsageService —— 记录每次 LLM 调用的 token 消耗，写入 token_usage 表。
 *
 * 写入路径（业务层 → provider adapter → 本服务）：
 *   chat / aiFilter / fieldSuggest / tasteMeta / workspaceSummary 等业务在
 *   构建 ProviderStreamParams 时传入 `recordContext = { userId, workspaceId,
 *   feature }`；provider adapter 在 stream 完成、解析到 usage 时调
 *   recordTokenUsage(...)。
 *
 * 失败不抛 —— 记账丢一两条不能阻塞主流程，silently log 即可。
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/** Provider stream 完成时透传给本服务的 usage 数据（统一内部格式）。 */
export interface UsageReport {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs?: number;
}

/** 业务在调 provider 时附带的"我是谁"上下文 —— 写到 token_usage 行里。 */
export interface RecordContext {
  /** 哪个 user 触发的调用 —— null 时（如系统启动期）会丢弃记录（无意义）。 */
  userId: string | null;
  /** 工作区上下文，可空（譬如登录后立即触发的全局 prompt suggestion）。 */
  workspaceId?: string | null;
  /** 调用场景标签，详见 schema 注释。 */
  feature: string;
  /** 模型实际名（"doubao-2.0" / "claude-opus-4.7" 等），由 adapter 填。 */
  model: string;
  /** Provider 标签 —— "ark" | "oneapi-anthropic" | "oneapi-openai"。 */
  provider: string;
}

/**
 * 写一条 token usage。失败不抛，log 即可。
 * 调用方一般在 provider adapter 的 done event 里执行。
 */
export async function recordTokenUsage(
  ctx: RecordContext,
  usage: UsageReport,
): Promise<void> {
  if (!ctx.userId) {
    // 没有 user 上下文（应不该发生 —— 但 boot 期 / cron 可能）。silently 跳过。
    return;
  }
  if (usage.totalTokens <= 0) return;
  try {
    await prisma.tokenUsage.create({
      data: {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId ?? null,
        provider: ctx.provider,
        model: ctx.model,
        feature: ctx.feature,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        durationMs: usage.durationMs ?? null,
      },
    });
  } catch (err) {
    console.warn("[tokenUsage] record failed (non-fatal):", err);
  }
}
