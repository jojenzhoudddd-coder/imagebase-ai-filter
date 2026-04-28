/**
 * Prisma-backed UserSkill store (Skill Creator V1).
 *
 * 职责：
 *   - 存取 user_skills 表的 CRUD（含 owner-scoped list / get / update / delete）
 *   - 入库前跑 validateName / validateTriggers / validateAssetPresence /
 *     validateWorkflowDocs 四类校验，拒收非法 input
 *   - 提供 toggleEnabled / recordInvocation 两个状态变更助手
 *
 * 不负责的事：
 *   - 把 UserSkill 适配成 SkillDefinition (那是 PR2 toSkillDefinition() 的活)
 *   - MCP 工具入口 (那是 PR3 skillMetaTools.ts)
 *
 * 详见 docs/skill-creator-plan.md。
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import {
  validateWorkflowDocs,
  WorkflowDocValidationError,
} from "./workflowDocValidator.js";
import type { WorkflowDoc } from "../workflow/types.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── DTO + input shapes ──────────────────────────────────────────────────

export type SkillOwnerType = "agent" | "workspace" | "global";

export interface UserSkillRow {
  id: string;
  ownerType: SkillOwnerType;
  ownerId: string;
  name: string;
  description: string;
  triggers: string[];
  promptFragment: string | null;
  workflowDocs: WorkflowDoc[] | null;
  toolWhitelist: string[] | null;
  sourceConversationId: string | null;
  sourceWorkflowRunId: string | null;
  enabled: boolean;
  invokedCount: number;
  lastInvokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserSkillCreateInput {
  ownerType: SkillOwnerType;
  ownerId: string;
  name: string;
  description?: string;
  triggers: string[];
  promptFragment?: string | null;
  workflowDocs?: unknown[] | null; // 入库前会跑 validateWorkflowDocs
  toolWhitelist?: string[] | null;
  sourceConversationId?: string | null;
  sourceWorkflowRunId?: string | null;
}

export interface UserSkillUpdateInput {
  name?: string;
  description?: string;
  triggers?: string[];
  promptFragment?: string | null;
  workflowDocs?: unknown[] | null;
  toolWhitelist?: string[] | null;
  enabled?: boolean;
}

export interface UserSkillListFilter {
  ownerType: SkillOwnerType;
  ownerId: string;
  onlyEnabled?: boolean;
}

// ─── Validation errors (re-exported for tooling layer) ───────────────────

export class UserSkillValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "UserSkillValidationError";
  }
}

export class UserSkillNotFoundError extends Error {
  constructor(id: string) {
    super(`user skill not found: ${id}`);
    this.name = "UserSkillNotFoundError";
  }
}

export class UserSkillNameConflictError extends Error {
  constructor(name: string) {
    super(`skill name "${name}" already exists for this owner`);
    this.name = "UserSkillNameConflictError";
  }
}

export class UserSkillPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserSkillPermissionError";
  }
}

// ─── Constants (also drives validator messages) ──────────────────────────

const NAME_MIN = 1;
const NAME_MAX = 60;
const TRIGGERS_MAX = 20;
const PROMPT_FRAGMENT_MAX = 8 * 1024; // 8 KB
const WORKFLOW_DOCS_MAX = 5;
const DESCRIPTION_MAX = 2000;

// ─── Validation helpers ─────────────────────────────────────────────────

function validateName(name: unknown): string {
  if (typeof name !== "string") {
    throw new UserSkillValidationError("name 必须是字符串", "name");
  }
  // Reject leading/trailing whitespace on the raw input — Skill names are
  // user-facing identifiers, "  hi  " is almost always a typo and would also
  // mask name-conflict checks (since trim() → "hi" might collide). Check the
  // raw value, NOT the trimmed one (which by definition can't start/end with
  // whitespace).
  if (name.length > 0 && (name !== name.trim())) {
    throw new UserSkillValidationError(
      "name 不能以空格开头或结尾",
      "name",
    );
  }
  const trimmed = name.trim();
  if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) {
    throw new UserSkillValidationError(
      `name 长度必须 ${NAME_MIN}-${NAME_MAX} 字符`,
      "name",
    );
  }
  if (trimmed.includes("/")) {
    throw new UserSkillValidationError("name 不能包含 /", "name");
  }
  return trimmed;
}

function validateTriggers(triggers: unknown): string[] {
  if (!Array.isArray(triggers)) {
    throw new UserSkillValidationError("triggers 必须是字符串数组", "triggers");
  }
  if (triggers.length === 0) {
    throw new UserSkillValidationError("triggers 至少需要一个非空关键词", "triggers");
  }
  if (triggers.length > TRIGGERS_MAX) {
    throw new UserSkillValidationError(
      `triggers 最多 ${TRIGGERS_MAX} 个`,
      "triggers",
    );
  }
  const cleaned: string[] = [];
  for (const t of triggers) {
    if (typeof t !== "string") {
      throw new UserSkillValidationError("triggers 必须全为字符串", "triggers");
    }
    const trimmed = t.trim();
    if (trimmed) cleaned.push(trimmed);
  }
  if (cleaned.length === 0) {
    throw new UserSkillValidationError(
      "triggers 至少需要一个非空关键词 (全是空白被拒)",
      "triggers",
    );
  }
  return cleaned;
}

function validatePromptFragment(pf: unknown): string | null {
  if (pf === undefined || pf === null) return null;
  if (typeof pf !== "string") {
    throw new UserSkillValidationError(
      "promptFragment 必须是字符串或 null",
      "promptFragment",
    );
  }
  if (pf.length > PROMPT_FRAGMENT_MAX) {
    throw new UserSkillValidationError(
      `promptFragment 长度超过上限 ${PROMPT_FRAGMENT_MAX} bytes`,
      "promptFragment",
    );
  }
  // 空字符串视为 null（"清空"语义）
  return pf.trim() ? pf : null;
}

function validateToolWhitelist(tw: unknown): string[] | null {
  if (tw === undefined || tw === null) return null;
  if (!Array.isArray(tw)) {
    throw new UserSkillValidationError(
      "toolWhitelist 必须是字符串数组或 null",
      "toolWhitelist",
    );
  }
  const cleaned: string[] = [];
  for (const t of tw) {
    if (typeof t !== "string") {
      throw new UserSkillValidationError(
        "toolWhitelist 必须全为字符串",
        "toolWhitelist",
      );
    }
    const trimmed = t.trim();
    if (trimmed) cleaned.push(trimmed);
  }
  return cleaned.length === 0 ? null : cleaned;
}

function validateDescription(desc: unknown): string {
  if (desc === undefined || desc === null) return "";
  if (typeof desc !== "string") {
    throw new UserSkillValidationError(
      "description 必须是字符串",
      "description",
    );
  }
  if (desc.length > DESCRIPTION_MAX) {
    throw new UserSkillValidationError(
      `description 长度超过上限 ${DESCRIPTION_MAX} chars`,
      "description",
    );
  }
  return desc;
}

function assertAssetPresence(opts: {
  promptFragment: string | null;
  workflowDocs: WorkflowDoc[] | null;
  toolWhitelist: string[] | null;
}) {
  const has =
    Boolean(opts.promptFragment) ||
    (opts.workflowDocs && opts.workflowDocs.length > 0) ||
    (opts.toolWhitelist && opts.toolWhitelist.length > 0);
  if (!has) {
    throw new UserSkillValidationError(
      "promptFragment / workflowDocs / toolWhitelist 至少一个非空",
    );
  }
}

function validateWorkflowDocsField(input: unknown): WorkflowDoc[] | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) {
    throw new UserSkillValidationError(
      "workflowDocs 必须是数组或 null",
      "workflowDocs",
    );
  }
  if (input.length === 0) return null;
  if (input.length > WORKFLOW_DOCS_MAX) {
    throw new UserSkillValidationError(
      `workflowDocs 最多 ${WORKFLOW_DOCS_MAX} 个`,
      "workflowDocs",
    );
  }
  try {
    return validateWorkflowDocs(input);
  } catch (err) {
    if (err instanceof WorkflowDocValidationError) {
      throw new UserSkillValidationError(
        `workflowDocs 校验失败: ${err.message}`,
        "workflowDocs",
      );
    }
    throw err;
  }
}

function validateOwner(ownerType: unknown, ownerId: unknown): {
  ownerType: SkillOwnerType;
  ownerId: string;
} {
  if (ownerType !== "agent" && ownerType !== "workspace" && ownerType !== "global") {
    throw new UserSkillValidationError(
      "ownerType 必须是 agent | workspace | global",
      "ownerType",
    );
  }
  if (typeof ownerId !== "string" || !ownerId.trim()) {
    throw new UserSkillValidationError("ownerId 必填", "ownerId");
  }
  return { ownerType, ownerId };
}

// ─── Row ↔ DTO mapping ───────────────────────────────────────────────────

function rowToDto(row: any): UserSkillRow {
  return {
    id: row.id,
    ownerType: row.ownerType as SkillOwnerType,
    ownerId: row.ownerId,
    name: row.name,
    description: row.description ?? "",
    triggers: Array.isArray(row.triggers) ? (row.triggers as string[]) : [],
    promptFragment: row.promptFragment ?? null,
    workflowDocs: row.workflowDocs
      ? (row.workflowDocs as WorkflowDoc[])
      : null,
    toolWhitelist: row.toolWhitelist
      ? (row.toolWhitelist as string[])
      : null,
    sourceConversationId: row.sourceConversationId ?? null,
    sourceWorkflowRunId: row.sourceWorkflowRunId ?? null,
    enabled: !!row.enabled,
    invokedCount: row.invokedCount ?? 0,
    lastInvokedAt: row.lastInvokedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── CRUD ────────────────────────────────────────────────────────────────

export async function createUserSkill(
  input: UserSkillCreateInput,
): Promise<UserSkillRow> {
  const { ownerType, ownerId } = validateOwner(input.ownerType, input.ownerId);
  const name = validateName(input.name);
  const description = validateDescription(input.description);
  const triggers = validateTriggers(input.triggers);
  const promptFragment = validatePromptFragment(input.promptFragment);
  const workflowDocs = validateWorkflowDocsField(input.workflowDocs);
  const toolWhitelist = validateToolWhitelist(input.toolWhitelist);
  assertAssetPresence({ promptFragment, workflowDocs, toolWhitelist });

  // Race-safe uniqueness check via transaction
  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.userSkill.findFirst({
      where: { ownerType, ownerId, name },
      select: { id: true },
    });
    if (existing) {
      throw new UserSkillNameConflictError(name);
    }
    return tx.userSkill.create({
      data: {
        ownerType,
        ownerId,
        name,
        description,
        triggers: triggers as any,
        promptFragment,
        workflowDocs: (workflowDocs as any) ?? null,
        toolWhitelist: (toolWhitelist as any) ?? null,
        sourceConversationId: input.sourceConversationId ?? null,
        sourceWorkflowRunId: input.sourceWorkflowRunId ?? null,
      },
    });
  });
  return rowToDto(row);
}

export async function getUserSkill(id: string): Promise<UserSkillRow | null> {
  const row = await prisma.userSkill.findUnique({ where: { id } });
  return row ? rowToDto(row) : null;
}

export async function listUserSkills(
  filter: UserSkillListFilter,
): Promise<UserSkillRow[]> {
  const { ownerType, ownerId } = validateOwner(filter.ownerType, filter.ownerId);
  const where: Record<string, unknown> = { ownerType, ownerId };
  if (filter.onlyEnabled) where.enabled = true;
  const rows = await prisma.userSkill.findMany({
    where: where as any,
    orderBy: { updatedAt: "desc" },
  });
  return rows.map(rowToDto);
}

export async function updateUserSkill(
  id: string,
  patch: UserSkillUpdateInput,
  opts: { requireOwnerId?: string } = {},
): Promise<UserSkillRow> {
  const existing = await prisma.userSkill.findUnique({ where: { id } });
  if (!existing) throw new UserSkillNotFoundError(id);
  if (opts.requireOwnerId && existing.ownerId !== opts.requireOwnerId) {
    throw new UserSkillPermissionError(
      `permission denied: skill belongs to a different owner`,
    );
  }

  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const newName = validateName(patch.name);
    if (newName !== existing.name) {
      const conflict = await prisma.userSkill.findFirst({
        where: {
          ownerType: existing.ownerType,
          ownerId: existing.ownerId,
          name: newName,
          NOT: { id },
        },
        select: { id: true },
      });
      if (conflict) throw new UserSkillNameConflictError(newName);
    }
    data.name = newName;
  }
  if (patch.description !== undefined) {
    data.description = validateDescription(patch.description);
  }
  if (patch.triggers !== undefined) {
    data.triggers = validateTriggers(patch.triggers);
  }
  if (patch.promptFragment !== undefined) {
    data.promptFragment = validatePromptFragment(patch.promptFragment);
  }
  if (patch.workflowDocs !== undefined) {
    data.workflowDocs = (validateWorkflowDocsField(patch.workflowDocs) as any) ?? null;
  }
  if (patch.toolWhitelist !== undefined) {
    data.toolWhitelist = (validateToolWhitelist(patch.toolWhitelist) as any) ?? null;
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") {
      throw new UserSkillValidationError("enabled 必须是 boolean", "enabled");
    }
    data.enabled = patch.enabled;
  }

  // 至少一个 asset 非空 (取最终落库后的形态)
  const finalPromptFragment =
    "promptFragment" in data
      ? (data.promptFragment as string | null)
      : existing.promptFragment;
  const finalWorkflowDocs =
    "workflowDocs" in data
      ? (data.workflowDocs as WorkflowDoc[] | null)
      : (existing.workflowDocs as WorkflowDoc[] | null);
  const finalToolWhitelist =
    "toolWhitelist" in data
      ? (data.toolWhitelist as string[] | null)
      : (existing.toolWhitelist as string[] | null);
  assertAssetPresence({
    promptFragment: finalPromptFragment,
    workflowDocs: finalWorkflowDocs,
    toolWhitelist: finalToolWhitelist,
  });

  const row = await prisma.userSkill.update({
    where: { id },
    data: data as any,
  });
  return rowToDto(row);
}

export async function deleteUserSkill(
  id: string,
  opts: { requireOwnerId?: string } = {},
): Promise<void> {
  const existing = await prisma.userSkill.findUnique({ where: { id } });
  if (!existing) throw new UserSkillNotFoundError(id);
  if (opts.requireOwnerId && existing.ownerId !== opts.requireOwnerId) {
    throw new UserSkillPermissionError(
      `permission denied: skill belongs to a different owner`,
    );
  }
  await prisma.userSkill.delete({ where: { id } });
}

export async function toggleUserSkillEnabled(
  id: string,
  enabled: boolean,
  opts: { requireOwnerId?: string } = {},
): Promise<UserSkillRow> {
  const existing = await prisma.userSkill.findUnique({ where: { id } });
  if (!existing) throw new UserSkillNotFoundError(id);
  if (opts.requireOwnerId && existing.ownerId !== opts.requireOwnerId) {
    throw new UserSkillPermissionError(
      `permission denied: skill belongs to a different owner`,
    );
  }
  const row = await prisma.userSkill.update({
    where: { id },
    data: { enabled },
  });
  return rowToDto(row);
}

/**
 * 在 workflow / 工具调用成功后调用,递增使用统计。失败时不要调（避免污染统计）。
 * 不抛错——统计写失败不影响主流程。
 */
export async function recordUserSkillInvocation(id: string): Promise<void> {
  try {
    await prisma.userSkill.update({
      where: { id },
      data: {
        invokedCount: { increment: 1 },
        lastInvokedAt: new Date(),
      },
    });
  } catch (err) {
    console.error("[userSkillStore] recordInvocation failed:", err);
  }
}

// 测试 / 调试用 — 直接读 prisma instance
export function _getPrismaForTest(): PrismaClient {
  return prisma;
}
