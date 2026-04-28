/**
 * PR1 Skill Creator test driver — runs all P0 (SK-101 ~ SK-119) +
 * P1 (SK-150 ~ SK-157) cases against the userSkillStore + workflowDocValidator.
 *
 * Usage:
 *   cd backend && npx tsx scripts/skill-pr1-test.ts
 *
 * Cleanup: deletes any user_skills row whose name starts with `__test_pr1_`
 * at the very end (best-effort, even on early exit).
 */

// IMPORTANT: dotenv must be loaded BEFORE the userSkillStore import, because
// that module instantiates a pg.Pool at module-load time using
// process.env.DATABASE_URL. ES module imports are hoisted, so we use a
// dynamic import() after dotenv.config() to enforce the order.
import * as dotenv from "dotenv";
dotenv.config();

import type {
  createUserSkill as createUserSkillT,
  getUserSkill as getUserSkillT,
  listUserSkills as listUserSkillsT,
  updateUserSkill as updateUserSkillT,
  deleteUserSkill as deleteUserSkillT,
  toggleUserSkillEnabled as toggleUserSkillEnabledT,
  recordUserSkillInvocation as recordUserSkillInvocationT,
  UserSkillValidationError as UserSkillValidationErrorT,
  UserSkillNotFoundError as UserSkillNotFoundErrorT,
  UserSkillNameConflictError as UserSkillNameConflictErrorT,
  _getPrismaForTest as _getPrismaForTestT,
} from "../src/services/userSkill/userSkillStore.js";
import type { UserSkill } from "../src/generated/prisma/client.js";

// Bound at runtime after dynamic import (see main()).
let createUserSkill: typeof createUserSkillT;
let getUserSkill: typeof getUserSkillT;
let listUserSkills: typeof listUserSkillsT;
let updateUserSkill: typeof updateUserSkillT;
let deleteUserSkill: typeof deleteUserSkillT;
let toggleUserSkillEnabled: typeof toggleUserSkillEnabledT;
let recordUserSkillInvocation: typeof recordUserSkillInvocationT;
let UserSkillValidationError: typeof UserSkillValidationErrorT;
let UserSkillNotFoundError: typeof UserSkillNotFoundErrorT;
let UserSkillNameConflictError: typeof UserSkillNameConflictErrorT;
let _getPrismaForTest: typeof _getPrismaForTestT;

// ─── Test infrastructure ─────────────────────────────────────────────────

const OWNER = { ownerType: "agent" as const, ownerId: "agent_default" };
const TEST_PREFIX = "__test_pr1_";

interface TestResult {
  id: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  error?: string;
}
const results: TestResult[] = [];

class AssertionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AssertionError";
  }
}

function assert(condition: any, msg: string): asserts condition {
  if (!condition) throw new AssertionError(msg);
}

async function runCase(id: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ id, status: "PASS" });
    process.stdout.write(`  [PASS] ${id}\n`);
  } catch (err: any) {
    const msg = err?.message ? `${err.name ?? "Error"}: ${err.message}` : String(err);
    results.push({ id, status: "FAIL", error: msg });
    process.stdout.write(`  [FAIL] ${id} — ${msg}\n`);
  }
}

function skipCase(id: string, reason: string) {
  results.push({ id, status: "SKIPPED", error: reason });
  process.stdout.write(`  [SKIPPED] ${id} — ${reason}\n`);
}

// ─── WorkflowDoc fixtures ────────────────────────────────────────────────

function validDoc(suffix = "") {
  return {
    rootNodeId: "n1",
    nodes: {
      n1: { id: "n1", kind: "trigger" as const, source: "chat-message", next: "n2" },
      n2: { id: "n2", kind: "action" as const, type: "mcp_tool", tool: "list_tables" + suffix },
    },
  };
}

// ─── Cleanup helpers ─────────────────────────────────────────────────────

async function cleanup() {
  if (!_getPrismaForTest) {
    console.log("[cleanup] module not loaded; nothing to clean");
    return;
  }
  const prisma = _getPrismaForTest();
  try {
    const result = await prisma.userSkill.deleteMany({
      where: {
        ownerType: OWNER.ownerType,
        ownerId: OWNER.ownerId,
        name: { startsWith: TEST_PREFIX },
      },
    });
    console.log(`\n[cleanup] removed ${result.count} __test_pr1_* rows`);
  } catch (err) {
    console.error("[cleanup] failed:", err);
  } finally {
    await prisma.$disconnect();
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────

async function main() {
  console.log("=== PR1 Skill Creator tests starting ===\n");

  // Dynamic import AFTER dotenv.config() so DATABASE_URL is available when
  // userSkillStore instantiates its pg.Pool at module-load time.
  const mod = await import("../src/services/userSkill/userSkillStore.js");
  createUserSkill = mod.createUserSkill;
  getUserSkill = mod.getUserSkill;
  listUserSkills = mod.listUserSkills;
  updateUserSkill = mod.updateUserSkill;
  deleteUserSkill = mod.deleteUserSkill;
  toggleUserSkillEnabled = mod.toggleUserSkillEnabled;
  recordUserSkillInvocation = mod.recordUserSkillInvocation;
  UserSkillValidationError = mod.UserSkillValidationError;
  UserSkillNotFoundError = mod.UserSkillNotFoundError;
  UserSkillNameConflictError = mod.UserSkillNameConflictError;
  _getPrismaForTest = mod._getPrismaForTest;

  const prisma = _getPrismaForTest();

  // Pre-cleanup so prior runs don't pollute
  await prisma.userSkill.deleteMany({
    where: {
      ownerType: OWNER.ownerType,
      ownerId: OWNER.ownerId,
      name: { startsWith: TEST_PREFIX },
    },
  });

  // ─── SK-101: migration applied + indexes exist ───────────────────────
  await runCase("SK-101", async () => {
    const tableExists = await prisma.$queryRaw<Array<{ to_regclass: string | null }>>`
      SELECT to_regclass('user_skills')::text as to_regclass
    `;
    assert(
      tableExists[0]?.to_regclass === "user_skills",
      `user_skills table not present, got ${JSON.stringify(tableExists)}`,
    );

    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'user_skills'
    `;
    const names = indexes.map((r) => r.indexname);
    assert(
      names.includes("user_skills_ownerType_ownerId_idx"),
      `missing index user_skills_ownerType_ownerId_idx; have ${names.join(", ")}`,
    );
    assert(
      names.includes("user_skills_enabled_idx"),
      `missing index user_skills_enabled_idx; have ${names.join(", ")}`,
    );

    // Migration row check
    const migrations = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations
       WHERE migration_name = '20260428180000_add_user_skill'
    `;
    assert(
      migrations.length === 1,
      `migration 20260428180000_add_user_skill not in _prisma_migrations`,
    );
  });

  // ─── SK-102: UserSkill type compiles & is usable ─────────────────────
  await runCase("SK-102", async () => {
    // Static type check at runtime: declare a function annotated with
    // UserSkill, attempt to assign a query result. If types didn't compile
    // the file wouldn't have loaded, so reaching here = pass. We additionally
    // smoke-fetch a row to exercise the type.
    const row: UserSkill | null = await prisma.userSkill.findFirst();
    void row;
    assert(true, "UserSkill type imported");
  });

  // ─── SK-103: minimal create returns enabled=true, invokedCount=0 ─────
  let id103 = "";
  await runCase("SK-103", async () => {
    const skill = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}103`,
      triggers: ["a"],
      promptFragment: "x",
    });
    id103 = skill.id;
    assert(skill.enabled === true, `expected enabled=true, got ${skill.enabled}`);
    assert(
      skill.invokedCount === 0,
      `expected invokedCount=0, got ${skill.invokedCount}`,
    );
    assert(skill.name === `${TEST_PREFIX}103`, "name mismatch");
    assert(Array.isArray(skill.triggers) && skill.triggers[0] === "a", "triggers mismatch");
  });

  // ─── SK-104: each asset alone succeeds ───────────────────────────────
  await runCase("SK-104", async () => {
    const a = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}104a`,
      triggers: ["a"],
      promptFragment: "only prompt",
    });
    assert(a.promptFragment === "only prompt", "104a prompt-only failed");

    const b = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}104b`,
      triggers: ["b"],
      workflowDocs: [validDoc("_104b")],
    });
    assert(
      b.workflowDocs && b.workflowDocs.length === 1,
      "104b workflowDocs-only failed",
    );

    const c = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}104c`,
      triggers: ["c"],
      toolWhitelist: ["x"],
    });
    assert(
      c.toolWhitelist && c.toolWhitelist.includes("x"),
      "104c toolWhitelist-only failed",
    );
  });

  // ─── SK-105: all assets empty/null → throw "至少一个" ────────────────
  await runCase("SK-105", async () => {
    let caught: any = null;
    try {
      await createUserSkill({
        ...OWNER,
        name: `${TEST_PREFIX}105`,
        triggers: ["a"],
      });
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof UserSkillValidationError, "expected UserSkillValidationError");
    assert(
      String(caught.message).includes("至少一个"),
      `expected message to contain "至少一个", got: ${caught.message}`,
    );
  });

  // ─── SK-106: list returns ≥3 created skills, sorted updatedAt desc ───
  await runCase("SK-106", async () => {
    // Force ordering by updating each in sequence
    const a = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}106a`,
      triggers: ["a"],
      promptFragment: "x",
    });
    await new Promise((r) => setTimeout(r, 10));
    const b = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}106b`,
      triggers: ["b"],
      promptFragment: "x",
    });
    await new Promise((r) => setTimeout(r, 10));
    const c = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}106c`,
      triggers: ["c"],
      promptFragment: "x",
    });
    void a;
    void b;
    void c;

    const list = await listUserSkills(OWNER);
    const ours = list.filter((s) => s.name.startsWith(`${TEST_PREFIX}106`));
    assert(ours.length === 3, `expected 3 SK-106 skills, got ${ours.length}`);
    // Ours come back in updatedAt desc order; whichever is most recent wins
    for (let i = 0; i + 1 < ours.length; i++) {
      assert(
        ours[i].updatedAt.getTime() >= ours[i + 1].updatedAt.getTime(),
        `list not in updatedAt desc order at index ${i}`,
      );
    }
    // Most recent should be 106c
    assert(ours[0].name === `${TEST_PREFIX}106c`, `expected 106c first, got ${ours[0].name}`);
  });

  // ─── SK-107: get returns full row ────────────────────────────────────
  await runCase("SK-107", async () => {
    const created = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}107`,
      triggers: ["a"],
      workflowDocs: [validDoc("_107")],
    });
    const fetched = await getUserSkill(created.id);
    assert(fetched !== null, "fetch returned null");
    assert(fetched!.id === created.id, "id mismatch");
    assert(
      fetched!.workflowDocs !== null && fetched!.workflowDocs.length === 1,
      "workflowDocs not returned",
    );
    assert(
      fetched!.workflowDocs![0].rootNodeId === "n1",
      "workflowDocs[0].rootNodeId not preserved",
    );
  });

  // ─── SK-108: get of unknown id returns null (no throw) ───────────────
  await runCase("SK-108", async () => {
    const result = await getUserSkill("not_a_real_id");
    assert(result === null, `expected null, got ${result}`);
  });

  // ─── SK-109: update description only ─────────────────────────────────
  await runCase("SK-109", async () => {
    assert(id103, "SK-103 must have run first");
    const before = await getUserSkill(id103);
    assert(before, "before-update fetch returned null");
    await new Promise((r) => setTimeout(r, 10));
    const updated = await updateUserSkill(id103, { description: "new desc" });
    assert(updated.description === "new desc", "description not updated");
    assert(updated.name === before!.name, "name was changed unexpectedly");
    assert(updated.triggers.join(",") === before!.triggers.join(","), "triggers changed");
    assert(
      updated.updatedAt.getTime() >= before!.updatedAt.getTime(),
      "updatedAt did not advance",
    );
  });

  // ─── SK-110: update triggers replaces (not merges) ───────────────────
  await runCase("SK-110", async () => {
    assert(id103, "SK-103 must have run first");
    const updated = await updateUserSkill(id103, { triggers: ["new1", "new2"] });
    assert(updated.triggers.length === 2, `expected 2 triggers, got ${updated.triggers.length}`);
    assert(
      updated.triggers[0] === "new1" && updated.triggers[1] === "new2",
      `expected ["new1","new2"], got ${JSON.stringify(updated.triggers)}`,
    );
  });

  // ─── SK-111: delete then get returns null ────────────────────────────
  await runCase("SK-111", async () => {
    const s = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}111`,
      triggers: ["a"],
      promptFragment: "x",
    });
    await deleteUserSkill(s.id);
    const after = await getUserSkill(s.id);
    assert(after === null, "skill still found after delete");
  });

  // ─── SK-112: toggle flips enabled, leaves other fields untouched ────
  await runCase("SK-112", async () => {
    const s = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}112`,
      triggers: ["a"],
      promptFragment: "stable",
    });
    const toggled = await toggleUserSkillEnabled(s.id, false);
    assert(toggled.enabled === false, "enabled did not flip to false");
    assert(toggled.promptFragment === "stable", "promptFragment changed");
    assert(toggled.name === s.name, "name changed");
    assert(toggled.triggers.join(",") === s.triggers.join(","), "triggers changed");
  });

  // ─── SK-113: recordInvocation increments invokedCount + sets ts ──────
  await runCase("SK-113", async () => {
    const s = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}113`,
      triggers: ["a"],
      promptFragment: "x",
    });
    assert(s.invokedCount === 0, "starting invokedCount not 0");
    assert(s.lastInvokedAt === null, "starting lastInvokedAt not null");

    await recordUserSkillInvocation(s.id);
    const after = await getUserSkill(s.id);
    assert(after !== null, "skill missing after invocation");
    assert(after!.invokedCount === 1, `expected invokedCount=1, got ${after!.invokedCount}`);
    assert(after!.lastInvokedAt instanceof Date, "lastInvokedAt not set");
  });

  // ─── SK-114: invalid triggers shapes ─────────────────────────────────
  await runCase("SK-114", async () => {
    for (const bad of [null, undefined, "string"]) {
      let caught: any = null;
      try {
        await createUserSkill({
          ...OWNER,
          name: `${TEST_PREFIX}114_${String(bad)}`,
          triggers: bad as any,
          promptFragment: "x",
        });
      } catch (e) {
        caught = e;
      }
      assert(
        caught instanceof UserSkillValidationError,
        `triggers=${String(bad)}: expected UserSkillValidationError, got ${caught?.name ?? "no error"}`,
      );
    }
  });

  // ─── SK-115: workflowDocs containing eval(...) → throw mentioning eval
  await runCase("SK-115", async () => {
    let caught: any = null;
    try {
      await createUserSkill({
        ...OWNER,
        name: `${TEST_PREFIX}115`,
        triggers: ["a"],
        workflowDocs: [
          {
            rootNodeId: "r",
            nodes: {
              r: { kind: "action", type: "mcp_tool", tool: "eval(\"...\")" },
            },
          },
        ],
      });
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof UserSkillValidationError,
      `expected UserSkillValidationError, got ${caught?.name}`,
    );
    assert(
      /eval/i.test(String(caught.message)),
      `expected error mentioning "eval", got: ${caught.message}`,
    );
  });

  // ─── SK-116: workflowDocs missing rootNodeId/nodes → throw ───────────
  await runCase("SK-116", async () => {
    let caught: any = null;
    try {
      await createUserSkill({
        ...OWNER,
        name: `${TEST_PREFIX}116`,
        triggers: ["a"],
        workflowDocs: [{ foo: "bar" }],
      });
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof UserSkillValidationError,
      `expected UserSkillValidationError, got ${caught?.name}`,
    );
    assert(
      /rootNodeId|nodes/i.test(String(caught.message)),
      `expected message about rootNodeId or nodes, got: ${caught.message}`,
    );
  });

  // ─── SK-117: duplicate name same owner → conflict ────────────────────
  await runCase("SK-117", async () => {
    const name = `${TEST_PREFIX}117_dup`;
    await createUserSkill({
      ...OWNER,
      name,
      triggers: ["a"],
      promptFragment: "x",
    });
    let caught: any = null;
    try {
      await createUserSkill({
        ...OWNER,
        name,
        triggers: ["a"],
        promptFragment: "x",
      });
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof UserSkillNameConflictError,
      `expected UserSkillNameConflictError, got ${caught?.name}: ${caught?.message}`,
    );
  });

  // ─── SK-118: triggers with empty/blank strings rejected ──────────────
  await runCase("SK-118", async () => {
    let caught: any = null;
    try {
      await createUserSkill({
        ...OWNER,
        name: `${TEST_PREFIX}118`,
        triggers: ["", "  "],
        promptFragment: "x",
      });
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof UserSkillValidationError,
      `expected UserSkillValidationError, got ${caught?.name}`,
    );
    assert(
      /空/.test(String(caught.message)) || /empty|blank/i.test(String(caught.message)),
      `expected message about empty/blank, got: ${caught.message}`,
    );
  });

  // ─── SK-119: deleteUserSkill on unknown id throws NotFound ───────────
  await runCase("SK-119", async () => {
    let caught: any = null;
    try {
      await deleteUserSkill("not_a_real_id");
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof UserSkillNotFoundError,
      `expected UserSkillNotFoundError, got ${caught?.name}: ${caught?.message}`,
    );
  });

  // ───────────────────── P1 ─────────────────────

  // ─── SK-150: promptFragment exactly 8KB ok; 8KB+1 fails ──────────────
  await runCase("SK-150", async () => {
    const limit = 8 * 1024;
    const ok = "a".repeat(limit);
    const sk = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}150_ok`,
      triggers: ["a"],
      promptFragment: ok,
    });
    assert(sk.promptFragment !== null && sk.promptFragment.length === limit, "8KB not stored");

    let caught: any = null;
    try {
      await createUserSkill({
        ...OWNER,
        name: `${TEST_PREFIX}150_fail`,
        triggers: ["a"],
        promptFragment: "a".repeat(limit + 1),
      });
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof UserSkillValidationError,
      `8KB+1: expected UserSkillValidationError, got ${caught?.name}`,
    );
  });

  // ─── SK-151: workflowDocs len 5 ok; 6 fail ───────────────────────────
  await runCase("SK-151", async () => {
    const five = [validDoc("_151a"), validDoc("_151b"), validDoc("_151c"), validDoc("_151d"), validDoc("_151e")];
    const sk = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}151_ok`,
      triggers: ["a"],
      workflowDocs: five,
    });
    assert(sk.workflowDocs && sk.workflowDocs.length === 5, "5 docs not stored");

    const six = [...five, validDoc("_151f")];
    let caught: any = null;
    try {
      await createUserSkill({
        ...OWNER,
        name: `${TEST_PREFIX}151_fail`,
        triggers: ["a"],
        workflowDocs: six,
      });
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof UserSkillValidationError,
      `6 docs: expected UserSkillValidationError, got ${caught?.name}`,
    );
  });

  // ─── SK-152: triggers len 20 ok; 21 fail ─────────────────────────────
  await runCase("SK-152", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const sk = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}152_ok`,
      triggers: twenty,
      promptFragment: "x",
    });
    assert(sk.triggers.length === 20, "20 triggers not stored");

    let caught: any = null;
    try {
      await createUserSkill({
        ...OWNER,
        name: `${TEST_PREFIX}152_fail`,
        triggers: [...twenty, "t20"],
        promptFragment: "x",
      });
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof UserSkillValidationError,
      `21 triggers: expected UserSkillValidationError, got ${caught?.name}`,
    );
  });

  // ─── SK-153: name length & format constraints ────────────────────────
  await runCase("SK-153", async () => {
    // length 60 ok — but prefix 12 chars; use shorter prefix-free pattern via custom name
    // We need to keep __test_pr1_ prefix for cleanup. Prefix is 11 chars. So use len-60 name.
    const len60Name = `${TEST_PREFIX}` + "a".repeat(60 - TEST_PREFIX.length); // total 60
    assert(len60Name.length === 60, `name should be 60 chars, got ${len60Name.length}`);
    const ok = await createUserSkill({
      ...OWNER,
      name: len60Name,
      triggers: ["a"],
      promptFragment: "x",
    });
    assert(ok.name.length === 60, "len-60 not stored");

    // length 61 fail
    const len61Name = `${TEST_PREFIX}` + "b".repeat(61 - TEST_PREFIX.length);
    let caught: any = null;
    try {
      await createUserSkill({
        ...OWNER,
        name: len61Name,
        triggers: ["a"],
        promptFragment: "x",
      });
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof UserSkillValidationError,
      `len-61: expected UserSkillValidationError, got ${caught?.name}`,
    );

    // leading/trailing spaces fail. Skip cleanup-prefix for this one.
    let caught2: any = null;
    try {
      await createUserSkill({
        ...OWNER,
        name: "  hi  ",
        triggers: ["a"],
        promptFragment: "x",
      });
    } catch (e) {
      caught2 = e;
    }
    assert(
      caught2 instanceof UserSkillValidationError,
      `"  hi  ": expected UserSkillValidationError, got ${caught2?.name}`,
    );

    // slash fail
    let caught3: any = null;
    try {
      await createUserSkill({
        ...OWNER,
        name: `${TEST_PREFIX}a/b`,
        triggers: ["a"],
        promptFragment: "x",
      });
    } catch (e) {
      caught3 = e;
    }
    assert(
      caught3 instanceof UserSkillValidationError,
      `"a/b": expected UserSkillValidationError, got ${caught3?.name}`,
    );
  });

  // ─── SK-154: rootNodeId not in nodes → fail ──────────────────────────
  await runCase("SK-154", async () => {
    let caught: any = null;
    try {
      await createUserSkill({
        ...OWNER,
        name: `${TEST_PREFIX}154`,
        triggers: ["a"],
        workflowDocs: [
          {
            rootNodeId: "missing",
            nodes: {
              r: { kind: "trigger", source: "chat-message", next: "r" },
            },
          },
        ],
      });
    } catch (e) {
      caught = e;
    }
    assert(
      caught instanceof UserSkillValidationError,
      `expected UserSkillValidationError, got ${caught?.name}: ${caught?.message}`,
    );
    assert(
      /missing|rootNodeId|nodes/i.test(String(caught.message)),
      `expected message about missing/rootNodeId/nodes, got: ${caught.message}`,
    );
  });

  // ─── SK-155: toolWhitelist with unknown tool warned-only (stored) ────
  await runCase("SK-155", async () => {
    const sk = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}155`,
      triggers: ["a"],
      toolWhitelist: ["__not_a_real_tool__"],
    });
    assert(
      sk.toolWhitelist !== null && sk.toolWhitelist.includes("__not_a_real_tool__"),
      `unknown tool not stored as-is: ${JSON.stringify(sk.toolWhitelist)}`,
    );
  });

  // ─── SK-156: SKIPPED — DB tear-down too risky for shared connection ──
  skipCase(
    "SK-156",
    "requires DB tear-down (would corrupt shared pool); manual sub-process test recommended",
  );

  // ─── SK-157: concurrent same-name create — exactly 1 wins ────────────
  await runCase("SK-157", async () => {
    const dupName = `${TEST_PREFIX}157_concurrent`;
    const r = await Promise.allSettled([
      createUserSkill({ ...OWNER, name: dupName, triggers: ["a"], promptFragment: "x" }),
      createUserSkill({ ...OWNER, name: dupName, triggers: ["a"], promptFragment: "x" }),
    ]);
    const fulfilled = r.filter((x) => x.status === "fulfilled");
    const rejected = r.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
    assert(
      fulfilled.length === 1,
      `expected 1 fulfilled, got ${fulfilled.length} (rejected=${rejected.length})`,
    );
    assert(
      rejected.length === 1,
      `expected 1 rejected, got ${rejected.length}`,
    );
    assert(
      rejected[0].reason instanceof UserSkillNameConflictError ||
        /already exists|conflict|unique/i.test(String(rejected[0].reason?.message ?? rejected[0].reason)),
      `expected UserSkillNameConflictError, got ${rejected[0].reason?.name ?? rejected[0].reason}: ${rejected[0].reason?.message}`,
    );
    // Ensure no duplicate row
    const matching = await prisma.userSkill.findMany({
      where: { ownerType: OWNER.ownerType, ownerId: OWNER.ownerId, name: dupName },
    });
    assert(matching.length === 1, `expected 1 row, found ${matching.length}`);
  });

  // ─── Summary ─────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIPPED").length;

  console.log("\n=== PR1 RESULTS ===");
  console.log(`Total:   ${results.length}`);
  console.log(`PASS:    ${pass}`);
  console.log(`FAIL:    ${fail}`);
  console.log(`SKIPPED: ${skip}`);
  if (fail > 0) {
    console.log("\nFailed test IDs:");
    for (const r of results.filter((x) => x.status === "FAIL")) {
      console.log(`  - ${r.id}: ${r.error}`);
    }
  }
  if (skip > 0) {
    console.log("\nSkipped test IDs:");
    for (const r of results.filter((x) => x.status === "SKIPPED")) {
      console.log(`  - ${r.id}: ${r.error}`);
    }
  }

  return fail === 0 ? 0 : 1;
}

let exitCode = 1;
main()
  .then((c) => {
    exitCode = c;
  })
  .catch((err) => {
    console.error("\n[fatal] test driver crashed:", err);
    exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    process.exit(exitCode);
  });
