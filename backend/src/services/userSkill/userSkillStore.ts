/**
 * UserSkill store (V2 — fs-first).
 *
 * 职责变化(2026-04-28):
 *   - DB 表 `user_skills` 现在只是**薄索引**(id / ownerType / ownerId / name /
 *     dirPath / enabled / invokedCount / lastInvokedAt / createdAt / updatedAt)
 *   - description / triggers / promptFragment / workflowDocs / toolWhitelist /
 *     sourceConversationId / sourceWorkflowRunId 全部下沉到 SKILL.md + workflows/*.json
 *     (走 BlobStorage,见 services/userSkill/skillFs.ts)
 *   - CRUD 在两个 store 之间协调:DB index 提供 fast list / unique check / enable
 *     状态;fs 提供完整内容
 *
 * 不变的契约:
 *   - 调用端仍然拿到 UserSkillRow 形态的数据(包括 promptFragment / workflowDocs
 *     等字段),`get` / `list` 内部把 fs + DB 拼起来再返回
 *   - 错误类(UserSkillValidationError 等)签名不变
 *
 * 详见 docs/roadmap-post-skill-v1.md PR4 + docs/skill-creator-plan.md。
 */

import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { generateId } from "../idGenerator.js";
import {
  validateWorkflowDocs,
  WorkflowDocValidationError,
} from "./workflowDocValidator.js";
import {
  readSkill,
  readSkillFrontmatter,
  writeSkill,
  deleteSkill as deleteSkillFs,
  skillDirPath,
  SkillFsError,
  type SkillFrontmatter,
  type SkillFsRecord,
} from "./skillFs.js";
import type { WorkflowDoc } from "../workflow/types.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── DTO + input shapes ──────────────────────────────────────────────────

export type SkillOwnerType = "agent" | "workspace" | "global";

/** Composite shape: DB index columns + fs frontmatter + fs body + workflows.
 *  This is what callers see from `get` / `list`. Backward-compatible-ish
 *  with V1 — same field names. */
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
  /** V2 addition: fs key prefix. Mostly internal; UI may render for trust. */
  dirPath: string;
}

export interface UserSkillCreateInput {
  ownerType: SkillOwnerType;
  ownerId: string;
  name: string;
  description?: string;
  triggers: string[];
  promptFragment?: string | null;
  workflowDocs?: unknown[] | null;
  toolWhitelist?: string[] | null;
  enabled?: boolean;
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

// ─── Errors ──────────────────────────────────────────────────────────────

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

// ─── Constants ───────────────────────────────────────────────────────────

const NAME_MIN = 1;
const NAME_MAX = 60;
const TRIGGERS_MAX = 20;
const PROMPT_FRAGMENT_MAX = 8 * 1024;
const WORKFLOW_DOCS_MAX = 5;
const DESCRIPTION_MAX = 2000;

// ─── Validation helpers ─────────────────────────────────────────────────

function validateName(name: unknown): string {
  if (typeof name !== "string") {
    throw new UserSkillValidationError("name 必须是字符串", "name");
  }
  if (name.length > 0 && name !== name.trim()) {
    throw new UserSkillValidationError("name 不能以空格开头或结尾", "name");
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

// ─── Compose row from DB index + fs record ───────────────────────────────

interface IndexRow {
  id: string;
  ownerType: string;
  ownerId: string;
  name: string;
  dirPath: string;
  enabled: boolean;
  invokedCount: number;
  lastInvokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function composeRow(idx: IndexRow, fs: SkillFsRecord): UserSkillRow {
  const fm = fs.frontmatter;
  // Normalize body whitespace from fs round-trip. `serializeSkillMd` writes
  //    `---\n<yaml>---\n\n<body>\n`
  // and our parser's body capture group includes both the leading `\n`
  // (after the closing `---\n`) and the trailing `\n` we appended. Strip
  // both edges so a user who passed "abc" gets back "abc" (not "\nabc\n").
  // Internal newlines are preserved verbatim. Lossy for users who
  // intentionally put leading/trailing blank lines, but that matches
  // every Markdown editor's behavior.
  const body = fs.body.replace(/^\n+/, "").replace(/\n+$/, "");
  return {
    id: idx.id,
    ownerType: idx.ownerType as SkillOwnerType,
    ownerId: idx.ownerId,
    name: idx.name,
    dirPath: idx.dirPath,
    description: fm.description ?? "",
    triggers: Array.isArray(fm.triggers) ? fm.triggers : [],
    promptFragment: body && body.trim() ? body : null,
    workflowDocs: fs.workflowDocs.length > 0 ? fs.workflowDocs : null,
    toolWhitelist: Array.isArray(fm.allowed_tools) && fm.allowed_tools.length > 0
      ? fm.allowed_tools
      : null,
    sourceConversationId: fm.source?.conversation_id ?? null,
    sourceWorkflowRunId: fm.source?.workflow_run_id ?? null,
    enabled: idx.enabled,
    invokedCount: idx.invokedCount,
    lastInvokedAt: idx.lastInvokedAt,
    createdAt: idx.createdAt,
    updatedAt: idx.updatedAt,
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

  // Step 1: reserve DB row in a $transaction (handles name-conflict race).
  // We need the row id BEFORE writing fs (dirPath includes id), so we INSERT
  // first, then write fs, then on fs failure cleanup DB row.
  const created = await prisma.$transaction(async (tx) => {
    const existing = await tx.userSkill.findFirst({
      where: { ownerType, ownerId, name },
      select: { id: true },
    });
    if (existing) throw new UserSkillNameConflictError(name);
    const skillId = await generateId("userSkill");
    return tx.userSkill.create({
      data: {
        id: skillId,
        ownerType,
        ownerId,
        name,
        dirPath: "pending",
        enabled: input.enabled ?? true,
      },
    });
  });

  const dirPath = skillDirPath(ownerId, created.id);
  const now = new Date().toISOString();
  const frontmatter: SkillFrontmatter = {
    id: created.id,
    name,
    description,
    when_to_use: description, // V1 reuses description; future iterations may split
    triggers,
    allowed_tools: toolWhitelist ?? undefined,
    workflows: undefined, // writeSkill fills from validated workflowDocs
    source:
      input.sourceConversationId || input.sourceWorkflowRunId
        ? {
            conversation_id: input.sourceConversationId ?? null,
            workflow_run_id: input.sourceWorkflowRunId ?? null,
          }
        : undefined,
    created_at: now,
    updated_at: now,
  };

  try {
    await writeSkill({
      dirPath,
      frontmatter,
      body: promptFragment ?? "",
      workflowDocs: workflowDocs ?? [],
    });
  } catch (err) {
    // fs write failed — undo DB row so we don't leave a phantom index entry.
    await prisma.userSkill.delete({ where: { id: created.id } }).catch(() => {});
    throw err;
  }

  const finalRow = await prisma.userSkill.update({
    where: { id: created.id },
    data: { dirPath },
  });
  const fsRec = await readSkill(dirPath);
  return composeRow(finalRow as unknown as IndexRow, fsRec);
}

export async function getUserSkill(id: string): Promise<UserSkillRow | null> {
  const idx = (await prisma.userSkill.findUnique({ where: { id } })) as
    | IndexRow
    | null;
  if (!idx) return null;
  let fsRec: SkillFsRecord;
  try {
    fsRec = await readSkill(idx.dirPath);
  } catch (err) {
    // fs is the source of truth; if missing, signal corruption clearly.
    throw new SkillFsError(
      `index row ${id} points at ${idx.dirPath} but fs read failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }
  return composeRow(idx, fsRec);
}

export async function listUserSkills(
  filter: UserSkillListFilter,
): Promise<UserSkillRow[]> {
  const { ownerType, ownerId } = validateOwner(filter.ownerType, filter.ownerId);
  const where: Record<string, unknown> = { ownerType, ownerId };
  if (filter.onlyEnabled) where.enabled = true;
  const rows = (await prisma.userSkill.findMany({
    where: where as any,
    orderBy: { updatedAt: "desc" },
  })) as IndexRow[];
  // Read each fs concurrently — these are tiny + OS page cache makes this
  // effectively free after first call.
  const enriched = await Promise.all(
    rows.map(async (idx) => {
      try {
        const fsRec = await readSkill(idx.dirPath);
        return composeRow(idx, fsRec);
      } catch (err) {
        // Don't crash the whole list on one corrupt row — log + skip.
        console.error(
          `[userSkillStore.list] skipping ${idx.id} (${idx.dirPath}):`,
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    }),
  );
  return enriched.filter((r): r is UserSkillRow => r !== null);
}

export async function updateUserSkill(
  id: string,
  patch: UserSkillUpdateInput,
  opts: { requireOwnerId?: string } = {},
): Promise<UserSkillRow> {
  const idx = (await prisma.userSkill.findUnique({ where: { id } })) as
    | IndexRow
    | null;
  if (!idx) throw new UserSkillNotFoundError(id);
  if (opts.requireOwnerId && idx.ownerId !== opts.requireOwnerId) {
    throw new UserSkillPermissionError(
      `permission denied: skill belongs to a different owner`,
    );
  }

  // Read current fs state — we'll merge patches into it.
  const cur = await readSkill(idx.dirPath);
  const fm = cur.frontmatter;

  const dbData: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const newName = validateName(patch.name);
    if (newName !== idx.name) {
      const conflict = await prisma.userSkill.findFirst({
        where: {
          ownerType: idx.ownerType,
          ownerId: idx.ownerId,
          name: newName,
          NOT: { id },
        },
        select: { id: true },
      });
      if (conflict) throw new UserSkillNameConflictError(newName);
    }
    dbData.name = newName;
    fm.name = newName;
  }
  if (patch.description !== undefined) {
    fm.description = validateDescription(patch.description);
    fm.when_to_use = fm.description;
  }
  if (patch.triggers !== undefined) {
    fm.triggers = validateTriggers(patch.triggers);
  }
  if (patch.toolWhitelist !== undefined) {
    const tw = validateToolWhitelist(patch.toolWhitelist);
    fm.allowed_tools = tw ?? undefined;
  }
  let nextBody = cur.body;
  if (patch.promptFragment !== undefined) {
    const pf = validatePromptFragment(patch.promptFragment);
    nextBody = pf ?? "";
  }
  let nextDocs: WorkflowDoc[] | null = cur.workflowDocs.length > 0 ? cur.workflowDocs : null;
  if (patch.workflowDocs !== undefined) {
    nextDocs = validateWorkflowDocsField(patch.workflowDocs);
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") {
      throw new UserSkillValidationError("enabled 必须是 boolean", "enabled");
    }
    dbData.enabled = patch.enabled;
  }

  // After patch composition, re-check asset presence.
  assertAssetPresence({
    promptFragment: nextBody.trim() ? nextBody : null,
    workflowDocs: nextDocs,
    toolWhitelist: fm.allowed_tools && fm.allowed_tools.length > 0
      ? fm.allowed_tools
      : null,
  });

  fm.updated_at = new Date().toISOString();
  await writeSkill({
    dirPath: idx.dirPath,
    frontmatter: fm,
    body: nextBody,
    workflowDocs: nextDocs ?? [],
  });
  const newIdx = (await prisma.userSkill.update({
    where: { id },
    data: dbData as any,
  })) as IndexRow;
  const newFs = await readSkill(idx.dirPath);
  return composeRow(newIdx, newFs);
}

export async function deleteUserSkill(
  id: string,
  opts: { requireOwnerId?: string } = {},
): Promise<void> {
  const idx = (await prisma.userSkill.findUnique({ where: { id } })) as
    | IndexRow
    | null;
  if (!idx) throw new UserSkillNotFoundError(id);
  if (opts.requireOwnerId && idx.ownerId !== opts.requireOwnerId) {
    throw new UserSkillPermissionError(
      `permission denied: skill belongs to a different owner`,
    );
  }
  // Delete fs first (idempotent), then DB row. If DB delete fails, fs is
  // already gone but next list will skip the broken index row + log.
  await deleteSkillFs(idx.dirPath);
  await prisma.userSkill.delete({ where: { id } });
}

export async function toggleUserSkillEnabled(
  id: string,
  enabled: boolean,
  opts: { requireOwnerId?: string } = {},
): Promise<UserSkillRow> {
  const idx = (await prisma.userSkill.findUnique({ where: { id } })) as
    | IndexRow
    | null;
  if (!idx) throw new UserSkillNotFoundError(id);
  if (opts.requireOwnerId && idx.ownerId !== opts.requireOwnerId) {
    throw new UserSkillPermissionError(
      `permission denied: skill belongs to a different owner`,
    );
  }
  const newIdx = (await prisma.userSkill.update({
    where: { id },
    data: { enabled },
  })) as IndexRow;
  const fsRec = await readSkill(idx.dirPath);
  return composeRow(newIdx, fsRec);
}

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

/** Read just frontmatter for a single skill. Used by `list_my_skills` /
 *  catalog rendering when full body isn't needed. Cheap. */
export async function getUserSkillFrontmatter(
  id: string,
): Promise<{ idx: IndexRow; frontmatter: SkillFrontmatter } | null> {
  const idx = (await prisma.userSkill.findUnique({ where: { id } })) as
    | IndexRow
    | null;
  if (!idx) return null;
  try {
    const frontmatter = await readSkillFrontmatter(idx.dirPath);
    return { idx, frontmatter };
  } catch {
    return null;
  }
}

export function _getPrismaForTest(): PrismaClient {
  return prisma;
}
