/**
 * Workspace default toggle regression test.
 *
 * Verifies the intended shared-definition / workspace-local-toggle contract:
 *   - user habits: definition/content shared, current workspace defaults on,
 *     other workspaces default off.
 *   - user skills: DB/fs definition shared, current workspace defaults on,
 *     other workspaces default off.
 *   - user integrations: DB definition/config shared, current workspace
 *     defaults on, other workspaces default off.
 *
 * Usage:
 *   cd backend && npx tsx scripts/workspace-toggle-defaults-test.ts
 */

import * as dotenv from "dotenv";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

dotenv.config();

const TEST_PREFIX = "__test_ws_defaults_";
const WS_A = "__test_ws_defaults_a";
const WS_B = "__test_ws_defaults_b";
const LOCAL_AGENT_ID = "__test_agent_ws_defaults";

interface TestResult {
  id: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  error?: string;
}

const results: TestResult[] = [];

class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

async function runCase(id: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ id, status: "PASS" });
    process.stdout.write(`  [PASS] ${id}\n`);
  } catch (err: any) {
    const msg = err?.message ? `${err.name ?? "Error"}: ${err.message}` : String(err);
    results.push({ id, status: "FAIL", error: msg });
    process.stdout.write(`  [FAIL] ${id} - ${msg}\n`);
  }
}

function skipCase(id: string, reason: string) {
  results.push({ id, status: "SKIPPED", error: reason });
  process.stdout.write(`  [SKIPPED] ${id} - ${reason}\n`);
}

function findTool(tools: any[], name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

async function main() {
  console.log("=== Workspace toggle defaults tests starting ===\n");

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-toggle-defaults-"));
  process.env.AGENT_HOME = path.join(tempRoot, "agents");
  process.env.IMAGEBASE_HOME = path.join(tempRoot, "imagebase");
  process.env.BLOB_STORAGE_BACKEND = "local";

  const createdSkillIds: string[] = [];
  const createdIntegrationIds: string[] = [];
  let prisma: any = null;
  let dbAgentId: string | null = null;
  let cleanupSkill: ((id: string, opts?: { requireOwnerId?: string }) => Promise<void>) | null = null;
  let cleanupIntegration: ((id: string, opts?: { requireAgentId?: string }) => Promise<unknown>) | null = null;

  try {
    const agentService = await import("../src/services/agentService.js");
    const cronScheduler = await import("../src/services/cronScheduler.js");

    const habitAgentId = LOCAL_AGENT_ID;
    await agentService.ensureAgentFiles(habitAgentId);

    await runCase("WS-HABIT-001 new user habit is shared but only current workspace is on", async () => {
      const job = await cronScheduler.addCronJob(habitAgentId, {
        schedule: "@daily",
        prompt: `${TEST_PREFIX}habit prompt`,
        displayName: `${TEST_PREFIX}habit`,
        description: "workspace default toggle regression",
        type: "user",
        enabled: false,
      });
      await agentService.setHabitOverride(habitAgentId, WS_A, job.id, { enabled: true });

      const wsAJob = (await cronScheduler.listCronJobs(habitAgentId, { workspaceId: WS_A }))
        .find((item) => item.id === job.id);
      const wsBJob = (await cronScheduler.listCronJobs(habitAgentId, { workspaceId: WS_B }))
        .find((item) => item.id === job.id);

      assert(wsAJob, "created habit missing in current workspace list");
      assert(wsBJob, "created habit definition missing in other workspace list");
      assert(wsAJob.prompt === job.prompt && wsBJob.prompt === job.prompt, "habit content should be shared");
      assert(wsAJob.enabled === true, "current workspace should default on");
      assert(wsBJob.enabled === false, "other workspace should default off");
      assert(wsAJob.workspaceId === WS_A, "current workspace should be stamped onto effective habit");
      assert(wsBJob.workspaceId === WS_B, "other workspace should be stamped onto effective habit");
    });

    await runCase("WS-HABIT-002 legacy workspace-bound habit is visible elsewhere but defaults off", async () => {
      const legacy = await cronScheduler.addCronJob(habitAgentId, {
        schedule: "@daily",
        prompt: `${TEST_PREFIX}legacy habit prompt`,
        workspaceId: WS_A,
        displayName: `${TEST_PREFIX}legacy_habit`,
        description: "legacy workspace-bound habit regression",
        type: "user",
        enabled: true,
      });

      const wsAJob = (await cronScheduler.listCronJobs(habitAgentId, { workspaceId: WS_A }))
        .find((item) => item.id === legacy.id);
      const wsBJob = (await cronScheduler.listCronJobs(habitAgentId, { workspaceId: WS_B }))
        .find((item) => item.id === legacy.id);

      assert(wsAJob?.enabled === true, "legacy habit should stay on in its original workspace");
      assert(wsBJob, "legacy habit definition should still be listed in other workspaces");
      assert(wsBJob.enabled === false, "legacy habit should default off outside its original workspace");
      assert(wsBJob.prompt === legacy.prompt, "legacy habit content should be shared");
    });

    const userSkillStore = await import("../src/services/userSkill/userSkillStore.js");
    const userSkillRegistry = await import("../src/services/userSkill/userSkillRegistry.js");
    const userSkillToolsMod = await import("../mcp-server/src/tools/userSkillTools.js");
    const integrationStore = await import("../src/services/integrations/integrationStore.js");
    const integrationToolsMod = await import("../mcp-server/src/tools/integrationTools.js");

    cleanupSkill = userSkillStore.deleteUserSkill;
    cleanupIntegration = integrationStore.deleteAgentIntegration;
    prisma = userSkillStore._getPrismaForTest();

    try {
      await prisma.userSkill.deleteMany({ where: { name: { startsWith: TEST_PREFIX } } });
      const agent = await prisma.agent.findFirst({ orderBy: { createdAt: "asc" } });
      dbAgentId = agent?.id ?? null;
    } catch (err: any) {
      const reason = `database unavailable: ${err?.message ?? String(err)}`;
      skipCase("WS-SKILL-001 new user skill workspace default", reason);
      skipCase("WS-INTEGRATION-001 new user integration workspace default", reason);
      dbAgentId = null;
    }

    if (!dbAgentId) {
      if (results.every((r) => r.id !== "WS-SKILL-001 new user skill workspace default")) {
        skipCase("WS-SKILL-001 new user skill workspace default", "no agent row found in database");
        skipCase("WS-INTEGRATION-001 new user integration workspace default", "no agent row found in database");
      }
    } else {
      await agentService.ensureAgentFiles(dbAgentId);

      await runCase("WS-SKILL-001 new user skill is shared but only current workspace is on", async () => {
        const create = findTool(userSkillToolsMod.userSkillTools, "create_skill");
        const list = findTool(userSkillToolsMod.userSkillTools, "list_my_skills");
        const update = findTool(userSkillToolsMod.userSkillTools, "update_skill");
        const ctxA = { agentId: dbAgentId, workspaceId: WS_A, conversationId: "conv_test_ws_defaults" };
        const ctxB = { agentId: dbAgentId, workspaceId: WS_B, conversationId: "conv_test_ws_defaults" };
        const name = `${TEST_PREFIX}skill_${Date.now()}`;

        const created = JSON.parse(await create.handler({
          name,
          description: "workspace default toggle regression",
          triggers: [`${TEST_PREFIX}trigger`],
          promptFragment: "Use this test skill only for workspace toggle regression.",
        }, ctxA));
        assert(created.ok === true, `create_skill failed: ${JSON.stringify(created)}`);
        createdSkillIds.push(created.skill.id);
        assert(created.skill.enabled === true, "create response should show current workspace enabled");

        const rawRow = await userSkillStore.getUserSkill(created.skill.id);
        assert(rawRow?.enabled === false, "underlying shared skill row should default disabled");

        const listA = JSON.parse(await list.handler({}, ctxA));
        const listB = JSON.parse(await list.handler({}, ctxB));
        const skillA = listA.skills.find((item: any) => item.id === created.skill.id);
        const skillB = listB.skills.find((item: any) => item.id === created.skill.id);
        assert(skillA?.enabled === true, "current workspace list should show enabled");
        assert(skillB?.enabled === false, "other workspace list should show disabled");

        const loadedA = await userSkillRegistry.loadUserSkills(dbAgentId!, WS_A);
        const loadedB = await userSkillRegistry.loadUserSkills(dbAgentId!, WS_B);
        assert(loadedA.some((item: any) => item.name === name), "runtime should load skill in current workspace");
        assert(!loadedB.some((item: any) => item.name === name), "runtime should not load skill in other workspace");

        const updated = JSON.parse(await update.handler({
          id: created.skill.id,
          description: "updated description without touching enabled",
        }, ctxA));
        assert(updated.ok === true, `update_skill failed: ${JSON.stringify(updated)}`);
        assert(updated.skill.enabled === true, "workspace update response should preserve effective enabled state");

        const toggleByUpdate = JSON.parse(await update.handler({
          id: created.skill.id,
          enabled: true,
        }, ctxA));
        assert(toggleByUpdate.ok === true, `update_skill enabled failed: ${JSON.stringify(toggleByUpdate)}`);
        assert(toggleByUpdate.skill.enabled === true, "update_skill enabled should affect current workspace");
        const rawAfterUpdateEnabled = await userSkillStore.getUserSkill(created.skill.id);
        assert(rawAfterUpdateEnabled?.enabled === false, "update_skill enabled must not mutate the shared DB row");
      });

      await runCase("WS-INTEGRATION-001 new user integration is shared but only current workspace is on", async () => {
        const create = findTool(integrationToolsMod.integrationTools, "create_integration");
        const ctxA = { agentId: dbAgentId, workspaceId: WS_A, conversationId: "conv_test_ws_defaults" };
        const displayName = `${TEST_PREFIX}integration_${Date.now()}`;

        const created = JSON.parse(await create.handler({
          providerKey: "custom-cli",
          displayName,
          transport: "cli",
          config: { command: "echo", args: ["workspace-toggle-defaults"] },
          toolManifest: [],
        }, ctxA));
        assert(created.ok === true, `create_integration failed: ${JSON.stringify(created)}`);
        createdIntegrationIds.push(created.integration.id);
        assert(created.integration.enabled === true, "create response should show current workspace enabled");

        const raw = (await integrationStore.listAgentIntegrations(dbAgentId!))
          .find((item: any) => item.id === created.integration.id);
        const current = (await integrationStore.listAgentIntegrations(dbAgentId!, { workspaceId: WS_A }))
          .find((item: any) => item.id === created.integration.id);
        const other = (await integrationStore.listAgentIntegrations(dbAgentId!, { workspaceId: WS_B }))
          .find((item: any) => item.id === created.integration.id);

        assert(raw?.enabled === false, "underlying shared integration row should default disabled");
        assert(current?.enabled === true, "current workspace list should show enabled");
        assert(other?.enabled === false, "other workspace list should show disabled");
        assert(current?.displayName === displayName && other?.displayName === displayName, "integration definition/config should be shared");
      });
    }
  } finally {
    for (const id of createdIntegrationIds) {
      if (!cleanupIntegration || !dbAgentId) continue;
      await cleanupIntegration(id, { requireAgentId: dbAgentId }).catch((err) => {
        console.error(`[cleanup] integration ${id} failed:`, err);
      });
    }
    for (const id of createdSkillIds) {
      if (!cleanupSkill || !dbAgentId) continue;
      await cleanupSkill(id, { requireOwnerId: dbAgentId }).catch((err) => {
        console.error(`[cleanup] skill ${id} failed:`, err);
      });
    }
    if (prisma) {
      await prisma.userSkill.deleteMany({ where: { name: { startsWith: TEST_PREFIX } } }).catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
    }
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIPPED").length;

  console.log("\n=== WORKSPACE DEFAULT RESULTS ===");
  console.log(`Total:   ${results.length}`);
  console.log(`PASS:    ${pass}`);
  console.log(`FAIL:    ${fail}`);
  console.log(`SKIPPED: ${skip}`);

  if (fail > 0) {
    console.log("\nFailed test IDs:");
    for (const r of results.filter((item) => item.status === "FAIL")) {
      console.log(`  - ${r.id}: ${r.error}`);
    }
  }

  return fail === 0 ? 0 : 1;
}

let exitCode = 1;
main()
  .then((code) => {
    exitCode = code;
  })
  .catch((err) => {
    console.error("\n[fatal] workspace defaults test crashed:", err);
    exitCode = 1;
  })
  .finally(() => {
    process.exit(exitCode);
  });
