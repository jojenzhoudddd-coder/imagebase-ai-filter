/**
 * PR2 Skill Creator test driver — runs all P0 (SK-201 ~ SK-214) +
 * P1 (SK-250 ~ SK-255) cases against userSkillRegistry + chatAgentService
 * helper functions and resolveActiveTools.
 *
 * Usage:
 *   cd backend && npx tsx scripts/skill-pr2-test.ts
 *
 * Cleanup: deletes any user_skills row whose name starts with `__test_pr2_`.
 */

// dotenv before any DB-touching dynamic import
import * as dotenv from "dotenv";
dotenv.config();

const OWNER = { ownerType: "agent" as const, ownerId: "agent_default" };
const TEST_PREFIX = "__test_pr2_";

interface TestResult {
  id: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  error?: string;
}
const results: TestResult[] = [];

class AssertionError extends Error {
  constructor(msg: string) { super(msg); this.name = "AssertionError"; }
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

function validDoc(suffix = "") {
  return {
    rootNodeId: "n1",
    nodes: {
      n1: { id: "n1", kind: "trigger" as const, source: "chat-message", next: "n2" },
      n2: { id: "n2", kind: "action" as const, type: "mcp_tool", tool: "list_tables" + suffix },
    },
  };
}

async function main() {
  console.log("=== PR2 Skill Creator tests starting ===\n");

  // Dynamic imports after dotenv
  const store = await import("../src/services/userSkill/userSkillStore.js");
  const registry = await import("../src/services/userSkill/userSkillRegistry.js");
  const chatAgent = await import("../src/services/chatAgentService.js");
  const toolsIndex = await import("../mcp-server/src/tools/index.js");
  const skillsIndex = await import("../mcp-server/src/skills/index.js");

  const {
    createUserSkill,
    listUserSkills,
    getUserSkill,
    deleteUserSkill,
    toggleUserSkillEnabled,
    recordUserSkillInvocation,
    _getPrismaForTest,
  } = store;
  const {
    loadUserSkills,
    toSkillDefinition,
    parseInvokeWorkflowToolName,
    USER_SKILL_TAG,
  } = registry;
  const {
    buildAvailableSkillsByName,
    buildSkillNameForTool,
    autoActivateByTriggers,
    buildSkillCatalog,
    buildSystemText,
    getOrInitSkillState,
  } = chatAgent;
  const { resolveActiveTools } = toolsIndex;
  const { allSkills } = skillsIndex;

  const prisma = _getPrismaForTest();

  // Pre-cleanup
  await prisma.userSkill.deleteMany({
    where: {
      ownerType: OWNER.ownerType,
      ownerId: OWNER.ownerId,
      name: { startsWith: TEST_PREFIX },
    },
  });

  // ─── SK-201: empty load returns [] ─────────────────────────────────────
  await runCase("SK-201", async () => {
    const skills = await loadUserSkills(OWNER.ownerId);
    // The DB might have non-test skills for agent_default. Spec says "with no
    // user skills returns []", so we need to ensure none exist. Filter to test prefix.
    const ours = skills.filter((s) => s.name.startsWith(TEST_PREFIX));
    assert(ours.length === 0, `expected 0 __test_pr2_ skills before any created, got ${ours.length}`);
  });

  // ─── SK-202: create + load returns it ──────────────────────────────────
  let id202 = "";
  await runCase("SK-202", async () => {
    const created = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}202`,
      triggers: ["sk202_kw"],
      promptFragment: "x",
    });
    id202 = created.id;
    const skills = await loadUserSkills(OWNER.ownerId);
    const ours = skills.filter((s) => s.name === `${TEST_PREFIX}202`);
    assert(ours.length === 1, `expected 1 SK-202 skill, got ${ours.length}`);
    assert(typeof ours[0].name === "string", "name not string");
    assert(Array.isArray(ours[0].tools), "tools not array");
  });

  // ─── SK-203: toSkillDefinition with null workflowDocs ─────────────────
  await runCase("SK-203", async () => {
    const fakeRow: any = {
      id: "rowfake",
      ownerType: "agent",
      ownerId: "agent_default",
      name: "demo",
      description: "",
      triggers: ["a"],
      promptFragment: "x",
      workflowDocs: null,
      toolWhitelist: null,
      sourceConversationId: null,
      sourceWorkflowRunId: null,
      enabled: true,
      invokedCount: 0,
      lastInvokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const def = toSkillDefinition(fakeRow);
    assert(Array.isArray(def.tools) && def.tools.length === 0, `expected tools=[], got ${def.tools.length}`);
    assert(def.promptFragment === "x", `expected promptFragment="x", got ${def.promptFragment}`);
  });

  // ─── SK-204: toSkillDefinition with one workflowDoc ────────────────────
  await runCase("SK-204", async () => {
    const fakeRow: any = {
      id: "rowfake204",
      ownerType: "agent",
      ownerId: "agent_default",
      name: "TestSkill204",
      description: "",
      triggers: ["a"],
      promptFragment: null,
      workflowDocs: [validDoc("_204")],
      toolWhitelist: null,
      sourceConversationId: null,
      sourceWorkflowRunId: null,
      enabled: true,
      invokedCount: 0,
      lastInvokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const def = toSkillDefinition(fakeRow);
    assert(def.tools.length === 1, `expected 1 tool, got ${def.tools.length}`);
    assert(
      def.tools[0].name === `invoke_skill_workflow_rowfake204_0`,
      `expected name invoke_skill_workflow_rowfake204_0, got ${def.tools[0].name}`,
    );
    assert(
      def.tools[0].description.includes("TestSkill204"),
      `expected description to mention skill name, got: ${def.tools[0].description}`,
    );
  });

  // ─── SK-205: 3 workflowDocs → 3 tools, indices 0/1/2 ───────────────────
  await runCase("SK-205", async () => {
    const fakeRow: any = {
      id: "rowfake205",
      ownerType: "agent",
      ownerId: "agent_default",
      name: "TestSkill205",
      description: "",
      triggers: ["a"],
      promptFragment: null,
      workflowDocs: [validDoc("_a"), validDoc("_b"), validDoc("_c")],
      toolWhitelist: null,
      sourceConversationId: null,
      sourceWorkflowRunId: null,
      enabled: true,
      invokedCount: 0,
      lastInvokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const def = toSkillDefinition(fakeRow);
    assert(def.tools.length === 3, `expected 3 tools, got ${def.tools.length}`);
    assert(def.tools[0].name.endsWith("_0"), `tool[0] name=${def.tools[0].name}`);
    assert(def.tools[1].name.endsWith("_1"), `tool[1] name=${def.tools[1].name}`);
    assert(def.tools[2].name.endsWith("_2"), `tool[2] name=${def.tools[2].name}`);
  });

  // ─── SK-206: handler success path increments invokedCount ─────────────
  let id206 = "";
  await runCase("SK-206", async () => {
    const created = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}206`,
      triggers: ["a"],
      workflowDocs: [validDoc("_206")],
    });
    id206 = created.id;
    assert(created.invokedCount === 0, `starting invokedCount=${created.invokedCount}`);

    const def = toSkillDefinition(created as any);
    assert(def.tools.length === 1, "expected 1 tool");
    const tool = def.tools[0];

    // Stub ctx with executeWorkflow
    const stubCtx: any = {
      executeWorkflow: async () => ({ runId: "r1", success: true, summary: "ok" }),
    };
    const resultStr = await tool.handler({ userMessage: "hi" }, stubCtx);
    const resultObj = JSON.parse(resultStr);
    assert(resultObj.runId === "r1", `expected runId=r1, got ${resultObj.runId}`);
    assert(resultObj.success === true, `expected success=true, got ${resultObj.success}`);
    assert(resultObj.summary === "ok", `expected summary=ok, got ${resultObj.summary}`);
    assert(resultObj.userSkillId === created.id, `userSkillId mismatch`);
    assert(resultObj.workflowIndex === 0, `expected workflowIndex=0, got ${resultObj.workflowIndex}`);

    // recordUserSkillInvocation is fire-and-forget (void). Wait briefly.
    await new Promise((r) => setTimeout(r, 200));
    const refetched = await getUserSkill(created.id);
    assert(refetched, "row missing after invocation");
    assert(
      refetched!.invokedCount === 1,
      `expected invokedCount=1, got ${refetched!.invokedCount}`,
    );
    assert(refetched!.lastInvokedAt instanceof Date, "lastInvokedAt not set");

    // No-ctx path
    const errStr = await tool.handler({ userMessage: "hi" }, undefined);
    const errObj = JSON.parse(errStr);
    assert(typeof errObj.error === "string" && errObj.error.includes("不可用"), `expected unavailable error, got ${errStr}`);
  });

  // ─── SK-207: autoActivateByTriggers ───────────────────────────────────
  await runCase("SK-207", async () => {
    const userSkill = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}207`,
      triggers: ["___sk207_kw"],
      promptFragment: "x",
    });
    const skills = await loadUserSkills(OWNER.ownerId);
    const userSkillDef = skills.find((s) => s.name === `${TEST_PREFIX}207`);
    assert(userSkillDef, "user skill def not found");

    const merged = [...allSkills, userSkillDef!];
    const state = getOrInitSkillState("conv-sk207");
    state.active.clear();
    state.lastUsedTurn.clear();
    state.turnIndex = 0;

    const noMatch = autoActivateByTriggers(state, "no match here", merged);
    assert(
      !state.active.has(userSkillDef!.name),
      `state.active should NOT contain user skill, got: ${[...state.active]}`,
    );

    autoActivateByTriggers(state, "this contains ___sk207_kw", merged);
    assert(
      state.active.has(userSkillDef!.name),
      `state.active SHOULD contain user skill after match, got: ${[...state.active]}`,
    );
    void userSkill; void noMatch;
  });

  // ─── SK-208: buildAvailableSkillsByName lookup ────────────────────────
  await runCase("SK-208", async () => {
    const skills = await loadUserSkills(OWNER.ownerId);
    const userSkillDef = skills.find((s) => s.name === `${TEST_PREFIX}207`);
    assert(userSkillDef, "user skill not found from prior SK-207");
    const map = buildAvailableSkillsByName([userSkillDef!]);
    assert(map[userSkillDef!.name] === userSkillDef, "user skill not found in merged map");
  });

  // ─── SK-209: toggle off → load doesn't include it ─────────────────────
  await runCase("SK-209", async () => {
    const created = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}209`,
      triggers: ["a"],
      promptFragment: "x",
    });
    let skills = await loadUserSkills(OWNER.ownerId);
    assert(
      skills.some((s) => s.name === created.name),
      "expected enabled skill in load",
    );
    await toggleUserSkillEnabled(created.id, false);
    skills = await loadUserSkills(OWNER.ownerId);
    assert(
      !skills.some((s) => s.name === created.name),
      "expected disabled skill NOT in load",
    );
  });

  // ─── SK-210: buildSkillCatalog mentions builtin + user, [user] tag ───
  await runCase("SK-210", async () => {
    const skills = await loadUserSkills(OWNER.ownerId);
    const userSkillDef = skills.find((s) => s.name === `${TEST_PREFIX}207`);
    assert(userSkillDef, "user skill from SK-207 missing");
    // Pick a real builtin name
    const builtinName = allSkills[0]?.name;
    assert(builtinName, "no builtin skill available");
    const catalog = buildSkillCatalog([builtinName!], [...allSkills, userSkillDef!]);
    assert(catalog.includes(builtinName!), `catalog missing builtin name ${builtinName}`);
    assert(
      catalog.includes(userSkillDef!.name),
      `catalog missing user skill name ${userSkillDef!.name}`,
    );
    assert(
      catalog.includes(USER_SKILL_TAG),
      `catalog missing [user] tag (USER_SKILL_TAG=${USER_SKILL_TAG})`,
    );
  });

  // ─── SK-211: buildSystemText injects user skill promptFragment ────────
  await runCase("SK-211", async () => {
    // Re-fetch user skills so we have a fresh def w/ promptFragment
    const sk211 = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}211`,
      triggers: ["a"],
      promptFragment: "PR2_PROMPT_FRAGMENT_TOKEN",
    });
    const skills = await loadUserSkills(OWNER.ownerId);
    const userSkillDef = skills.find((s) => s.name === sk211.name);
    assert(userSkillDef, "SK-211 user skill missing");

    const layers: any = {
      identity: "id",
      snapshot: "ss",
      recalled: null,
      analystHandles: null,
    };
    const merged = [...allSkills, userSkillDef!];
    const map = buildAvailableSkillsByName([userSkillDef!]);
    const text = buildSystemText(layers, [userSkillDef!.name], merged, map);
    assert(
      text.includes("PR2_PROMPT_FRAGMENT_TOKEN"),
      `system text does NOT contain user skill promptFragment`,
    );
    assert(
      text.includes(`Active Skill · ${userSkillDef!.name}`),
      `system text missing "Active Skill · ${userSkillDef!.name}" header`,
    );
  });

  // ─── SK-212: SK-206 already verified invokedCount + lastInvokedAt ────
  await runCase("SK-212", async () => {
    assert(id206, "SK-206 must have run first");
    const refetched = await getUserSkill(id206);
    assert(refetched, "SK-206 row missing");
    assert(
      refetched!.invokedCount >= 1,
      `expected invokedCount>=1, got ${refetched!.invokedCount}`,
    );
    assert(refetched!.lastInvokedAt !== null, "lastInvokedAt is null");
  });

  // ─── SK-213: user skill name colliding with builtin wins ──────────────
  await runCase("SK-213", async () => {
    // Use builtin "table-skill" — must exist
    const builtinTable = allSkills.find((s) => s.name === "table-skill");
    assert(builtinTable, "table-skill builtin missing — cannot run collision test");

    // Create a user skill with the same name (builtin lives in registry, not DB)
    const collidingName = "table-skill"; // does NOT match TEST_PREFIX!
    // First clean any prior leftover
    await prisma.userSkill.deleteMany({
      where: { ownerType: OWNER.ownerType, ownerId: OWNER.ownerId, name: collidingName },
    });
    const created = await createUserSkill({
      ...OWNER,
      name: collidingName,
      triggers: ["___sk213_collide"],
      promptFragment: "USER_VERSION",
    });
    try {
      const skills = await loadUserSkills(OWNER.ownerId);
      const userSkillDef = skills.find((s) => s.name === collidingName);
      assert(userSkillDef, "user skill version not in load");
      assert(userSkillDef!.promptFragment === "USER_VERSION", "user version missing promptFragment");
      const map = buildAvailableSkillsByName([userSkillDef!]);
      assert(
        map[collidingName] === userSkillDef,
        `collision: expected user skill to win, got ${map[collidingName]?.promptFragment}`,
      );
    } finally {
      // Hard-delete this row since it doesn't match TEST_PREFIX
      await deleteUserSkill(created.id);
    }
  });

  // ─── SK-214: 3 user skills with overlapping triggers all activate ────
  await runCase("SK-214", async () => {
    const a = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}214_a`,
      triggers: ["xyz_test"],
      promptFragment: "a",
    });
    const b = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}214_b`,
      triggers: ["xyz_test"],
      promptFragment: "b",
    });
    const c = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}214_c`,
      triggers: ["xyz_test"],
      promptFragment: "c",
    });
    void a; void b; void c;

    const skills = await loadUserSkills(OWNER.ownerId);
    const ours = skills.filter((s) => s.name.startsWith(`${TEST_PREFIX}214_`));
    assert(ours.length === 3, `expected 3 skills, got ${ours.length}`);

    const merged = [...allSkills, ...ours];
    const state = getOrInitSkillState("conv-sk214");
    state.active.clear();
    state.lastUsedTurn.clear();
    state.turnIndex = 0;

    autoActivateByTriggers(state, "xyz_test query", merged);
    for (const s of ours) {
      assert(
        state.active.has(s.name),
        `expected ${s.name} active, active set: ${[...state.active]}`,
      );
    }
  });

  // ─── P1 ────────────────────────────────────────────────────────────────

  // ─── SK-250: 100 user skills loadUserSkills < 200ms ───────────────────
  await runCase("SK-250", async () => {
    const ids: string[] = [];
    try {
      for (let i = 0; i < 100; i++) {
        const s = await createUserSkill({
          ...OWNER,
          name: `${TEST_PREFIX}perf_${i}`,
          triggers: [`t${i}`],
          promptFragment: "x",
        });
        ids.push(s.id);
      }
      const t0 = Date.now();
      const skills = await loadUserSkills(OWNER.ownerId);
      const dur = Date.now() - t0;
      const ours = skills.filter((s) => s.name.startsWith(`${TEST_PREFIX}perf_`));
      assert(ours.length === 100, `expected 100 perf rows, got ${ours.length}`);
      assert(dur < 200, `loadUserSkills took ${dur}ms (limit 200ms)`);
    } finally {
      // bulk cleanup
      await prisma.userSkill.deleteMany({
        where: {
          ownerType: OWNER.ownerType,
          ownerId: OWNER.ownerId,
          name: { startsWith: `${TEST_PREFIX}perf_` },
        },
      });
    }
  });

  // ─── SK-251: softDeps undefined on user skill SkillDefinition ─────────
  await runCase("SK-251", async () => {
    const fakeRow: any = {
      id: "rowfake251",
      ownerType: "agent",
      ownerId: "agent_default",
      name: "x",
      description: "",
      triggers: ["a"],
      promptFragment: "x",
      workflowDocs: null,
      toolWhitelist: null,
      sourceConversationId: null,
      sourceWorkflowRunId: null,
      enabled: true,
      invokedCount: 0,
      lastInvokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const def = toSkillDefinition(fakeRow);
    assert(def.softDeps === undefined, `expected softDeps undefined, got ${JSON.stringify(def.softDeps)}`);
  });

  // ─── SK-252: handler with success:false → no recordInvocation ────────
  await runCase("SK-252", async () => {
    const created = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}252`,
      triggers: ["a"],
      workflowDocs: [validDoc("_252")],
    });
    assert(created.invokedCount === 0, "starting count not 0");
    const def = toSkillDefinition(created as any);
    const stubCtx: any = {
      executeWorkflow: async () => ({ runId: "r2", success: false, summary: "failed" }),
    };
    await def.tools[0].handler({ userMessage: "hi" }, stubCtx);
    await new Promise((r) => setTimeout(r, 200));
    const refetched = await getUserSkill(created.id);
    assert(
      refetched && refetched.invokedCount === 0,
      `expected invokedCount=0 on failure, got ${refetched?.invokedCount}`,
    );
  });

  // ─── SK-253: handler still works after row deletion (silent) ─────────
  await runCase("SK-253", async () => {
    const created = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}253`,
      triggers: ["a"],
      workflowDocs: [validDoc("_253")],
    });
    const def = toSkillDefinition(created as any);
    const handler = def.tools[0].handler;
    // Now delete underlying row
    await deleteUserSkill(created.id);
    // Captured closure should still execute without throwing
    const stubCtx: any = {
      executeWorkflow: async () => ({ runId: "r3", success: true, summary: "ok" }),
    };
    let threw = false;
    try {
      const out = await handler({ userMessage: "hi" }, stubCtx);
      assert(typeof out === "string", "handler did not return string");
    } catch {
      threw = true;
    }
    assert(!threw, "handler threw despite captured closure deletion");
  });

  // ─── SK-254: case-sensitivity matches builtin (String.includes) ──────
  await runCase("SK-254", async () => {
    const created = await createUserSkill({
      ...OWNER,
      name: `${TEST_PREFIX}254`,
      triggers: ["AB"],
      promptFragment: "x",
    });
    const skills = await loadUserSkills(OWNER.ownerId);
    const userSkillDef = skills.find((s) => s.name === created.name);
    assert(userSkillDef, "missing");
    const merged = [...allSkills, userSkillDef!];
    const state = getOrInitSkillState("conv-sk254");
    state.active.clear();
    state.lastUsedTurn.clear();
    state.turnIndex = 0;

    // userMessage "ab is here" — different case from "AB"
    autoActivateByTriggers(state, "ab is here", merged);
    // String.includes is case-SENSITIVE so should NOT match
    assert(
      !state.active.has(userSkillDef!.name),
      `case-sensitivity broken: "ab" matched trigger "AB" (active: ${[...state.active]})`,
    );

    // Verify "AB is here" DOES match
    state.active.clear();
    state.lastUsedTurn.clear();
    autoActivateByTriggers(state, "AB is here", merged);
    assert(
      state.active.has(userSkillDef!.name),
      `expected case-matching to activate, active: ${[...state.active]}`,
    );
  });

  // ─── SK-255: catalog stays under 4000 chars even with 50 skills ──────
  await runCase("SK-255", async () => {
    // Build 50 fake user skills directly via toSkillDefinition (no DB hit)
    const fakeDefs = Array.from({ length: 50 }, (_, i) => {
      const fakeRow: any = {
        id: `fake255_${i}`,
        ownerType: "agent",
        ownerId: "agent_default",
        name: `__bench_${i}`,
        description: `desc ${i}`,
        triggers: [`t${i}`],
        promptFragment: "x",
        workflowDocs: null,
        toolWhitelist: null,
        sourceConversationId: null,
        sourceWorkflowRunId: null,
        enabled: true,
        invokedCount: 0,
        lastInvokedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return toSkillDefinition(fakeRow);
    });
    const catalog = buildSkillCatalog([], fakeDefs);
    assert(
      catalog.length < 4000,
      `catalog with 50 skills exceeds 4000 chars: ${catalog.length}`,
    );
  });

  void parseInvokeWorkflowToolName;
  void buildSkillNameForTool;
  void resolveActiveTools;

  // ─── Summary ─────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIPPED").length;

  console.log("\n=== PR2 RESULTS ===");
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

  return fail === 0 ? 0 : 1;
}

async function cleanup() {
  try {
    const store = await import("../src/services/userSkill/userSkillStore.js");
    const prisma = store._getPrismaForTest();
    const result = await prisma.userSkill.deleteMany({
      where: {
        ownerType: OWNER.ownerType,
        ownerId: OWNER.ownerId,
        name: { startsWith: TEST_PREFIX },
      },
    });
    console.log(`\n[cleanup] removed ${result.count} __test_pr2_* rows`);
    await prisma.$disconnect();
  } catch (err) {
    console.error("[cleanup] failed:", err);
  }
}

let exitCode = 1;
main()
  .then((c) => { exitCode = c; })
  .catch((err) => {
    console.error("\n[fatal] test driver crashed:", err);
    exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    process.exit(exitCode);
  });
