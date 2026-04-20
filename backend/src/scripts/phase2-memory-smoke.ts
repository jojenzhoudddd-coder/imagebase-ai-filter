/**
 * Phase 2 Day 1 smoke test — read_memory.
 *
 * Run with:  AGENT_HOME=/tmp/imagebase-phase2-smoke npx tsx backend/src/scripts/phase2-memory-smoke.ts
 *
 * Expects: two episodic memories land under
 *   $AGENT_HOME/agent_test/memory/episodic/, list returns them newest-first
 *   with correct tags, a filename lookup returns the full body, tag filter
 *   filters correctly, and bad filenames are rejected.
 */

import { metaTools } from "../../mcp-server/src/tools/metaTools.js";
import { memoryTools } from "../../mcp-server/src/tools/memoryTools.js";
import { ensureAgentFiles } from "../services/agentService.js";

async function main() {
  const agentId = "agent_test";
  await ensureAgentFiles(agentId);

  const meta = Object.fromEntries(metaTools.map((t) => [t.name, t]));
  const memory = Object.fromEntries(memoryTools.map((t) => [t.name, t]));

  // Write two memories so the list isn't empty.
  const w1 = await meta["create_memory"].handler(
    {
      title: "Phase 2 Day 1 启动",
      body: "今天开始 Phase 2。目标：读取自己的记忆。",
      tags: ["phase2", "milestone"],
    },
    { agentId }
  );
  console.log("create_memory #1:", w1);

  // Small delay so mtimes differ.
  await new Promise((r) => setTimeout(r, 20));

  const w2 = await meta["create_memory"].handler(
    {
      title: "CRM 系统搭完",
      body: "用户确认 CRM 系统 3 张表上线。",
      tags: ["crm", "milestone"],
    },
    { agentId }
  );
  console.log("create_memory #2:", w2);

  // List all (no filter).
  const listAll = await memory["read_memory"].handler({}, { agentId });
  console.log("\nread_memory (list all):", listAll);

  const parsedAll = JSON.parse(listAll);
  if (!parsedAll.ok || parsedAll.count < 2) {
    throw new Error("expected at least 2 memories listed");
  }
  // Newest-first check.
  if (!/CRM 系统搭完|crm/i.test(parsedAll.memories[0].title)) {
    throw new Error(`expected newest memory first, got: ${parsedAll.memories[0].title}`);
  }

  // Tag filter.
  const listCrm = await memory["read_memory"].handler({ tag: "crm" }, { agentId });
  console.log("\nread_memory (tag=crm):", listCrm);
  const parsedCrm = JSON.parse(listCrm);
  if (parsedCrm.count !== 1 || !parsedCrm.memories[0].tags.includes("crm")) {
    throw new Error("tag filter did not isolate crm memory");
  }

  // Load one by filename.
  const firstFilename = parsedAll.memories[0].filename;
  const loaded = await memory["read_memory"].handler({ filename: firstFilename }, { agentId });
  console.log("\nread_memory (by filename):", loaded);
  const parsedLoaded = JSON.parse(loaded);
  if (!parsedLoaded.ok || !parsedLoaded.memory.body) {
    throw new Error("filename load returned no body");
  }

  // Path traversal guard.
  const traversal = await memory["read_memory"].handler(
    { filename: "../../../etc/passwd" },
    { agentId }
  );
  console.log("\nread_memory (traversal attempt, expect ok:false):", traversal);
  const parsedTrav = JSON.parse(traversal);
  if (parsedTrav.ok) throw new Error("traversal filename was not rejected");

  // Missing file.
  const missing = await memory["read_memory"].handler(
    { filename: "2020-01-01_nope_0000.md" },
    { agentId }
  );
  console.log("\nread_memory (missing file):", missing);
  const parsedMissing = JSON.parse(missing);
  if (parsedMissing.ok) throw new Error("missing filename should return ok:false");

  // Limit.
  const limited = await memory["read_memory"].handler({ limit: 1 }, { agentId });
  console.log("\nread_memory (limit=1):", limited);
  const parsedLim = JSON.parse(limited);
  if (parsedLim.count !== 1) throw new Error("limit=1 did not limit results");

  console.log("\n✅ Phase 2 Day 1 smoke passed.");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
