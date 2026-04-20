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

  // ── Day 2: recall_memory ──────────────────────────────────────────────

  // Keyword match.
  const recallCrm = await memory["recall_memory"].handler({ query: "CRM" }, { agentId });
  console.log("\nrecall_memory (query=CRM):", recallCrm);
  const parsedRecallCrm = JSON.parse(recallCrm);
  if (!parsedRecallCrm.ok || parsedRecallCrm.count < 1) {
    throw new Error("query=CRM returned no hits");
  }
  if (!/crm|CRM/i.test(parsedRecallCrm.hits[0].title + parsedRecallCrm.hits[0].preview)) {
    throw new Error(`top hit for CRM doesn't look like CRM memory: ${parsedRecallCrm.hits[0].title}`);
  }

  // Tag match only (no query).
  const recallTag = await memory["recall_memory"].handler({ tags: ["phase2"] }, { agentId });
  console.log("\nrecall_memory (tags=[phase2]):", recallTag);
  const parsedRecallTag = JSON.parse(recallTag);
  if (parsedRecallTag.count !== 1 || !parsedRecallTag.hits[0].tags.includes("phase2")) {
    throw new Error("tag-only recall failed");
  }

  // Both query + tags should boost the CRM hit higher than a weak keyword.
  const recallBoth = await memory["recall_memory"].handler(
    { query: "系统", tags: ["crm"] },
    { agentId }
  );
  console.log("\nrecall_memory (query=系统 tags=[crm]):", recallBoth);
  const parsedRecallBoth = JSON.parse(recallBoth);
  if (parsedRecallBoth.count < 1 || !parsedRecallBoth.hits[0].tags.includes("crm")) {
    throw new Error("combined query+tag did not rank CRM first");
  }

  // Non-matching query returns empty.
  const recallMiss = await memory["recall_memory"].handler({ query: "完全不存在的词" }, { agentId });
  console.log("\nrecall_memory (no match):", recallMiss);
  const parsedRecallMiss = JSON.parse(recallMiss);
  if (parsedRecallMiss.count !== 0) {
    throw new Error("non-matching query should return 0 hits");
  }

  // No query, no tags → falls back to recency (returns top-K newest).
  const recallBlank = await memory["recall_memory"].handler({}, { agentId });
  console.log("\nrecall_memory (blank → recency fallback):", recallBlank);
  const parsedRecallBlank = JSON.parse(recallBlank);
  if (parsedRecallBlank.count < 2) throw new Error("blank recall should list all memories by recency");
  // Newest first.
  if (parsedRecallBlank.hits[0].reasons.mtimeMs < parsedRecallBlank.hits[1].reasons.mtimeMs) {
    throw new Error("blank recall not sorted by recency");
  }

  // ── Day 3: auto-recall section rendering ──────────────────────────────

  const { buildRecalledMemoriesSection } = await import("../services/chatAgentService.js");

  const autoHit = await buildRecalledMemoriesSection(agentId, "帮我看看之前 CRM 系统做到哪了");
  console.log("\nauto-recall section (CRM query):\n" + autoHit);
  if (!/CRM/i.test(autoHit)) throw new Error("auto-recall did not surface CRM memory");
  if (!/read_memory/.test(autoHit)) throw new Error("auto-recall should hint at read_memory for full body");

  const autoEmpty = await buildRecalledMemoriesSection(agentId, "今天北京天气怎么样");
  console.log("\nauto-recall section (unrelated query):\n[" + autoEmpty + "]");
  if (autoEmpty !== "") throw new Error("unrelated query should produce empty recall (so prompt stays tight)");

  // ── Day 4: working.jsonl → episodic compression ────────────────────────

  const {
    appendWorkingMemory,
    readWorkingMemory,
    compressWorkingMemory,
    clearWorkingMemory,
  } = await import("../services/agentService.js");

  // Start from a clean slate so the assertion counts are exact.
  await clearWorkingMemory(agentId);
  for (let i = 0; i < 12; i++) {
    await appendWorkingMemory(agentId, {
      timestamp: new Date(Date.now() - (12 - i) * 1000).toISOString(),
      conversationId: "conv_smoke",
      userMessage: i % 2 === 0 ? `怎么给 CRM 系统加字段 ${i}` : `给任务表加记录 ${i}`,
      assistantMessage: `已处理 ${i}`,
      toolCalls: i % 2 === 0 ? ["create_field"] : ["batch_create_records"],
    });
  }
  const beforeEntries = await readWorkingMemory(agentId);
  console.log("\nworking.jsonl before compress:", beforeEntries.length, "entries");
  if (beforeEntries.length !== 12) throw new Error("expected 12 entries");

  // Below-threshold run should be a no-op.
  const skip = await compressWorkingMemory(agentId, { minTurns: 100 });
  console.log("compressWorkingMemory (minTurns=100, should skip):", skip);
  if (skip.compressed) throw new Error("expected below-threshold to skip compression");

  // At-threshold run should compress + clear.
  const done = await compressWorkingMemory(agentId, { minTurns: 10 });
  console.log("compressWorkingMemory (minTurns=10, should compress):", done);
  if (!done.compressed) throw new Error("expected compression to fire");
  if (done.turns !== 12) throw new Error(`expected 12 turns compressed, got ${done.turns}`);

  const afterEntries = await readWorkingMemory(agentId);
  console.log("working.jsonl after compress:", afterEntries.length, "entries");
  if (afterEntries.length !== 0) throw new Error("working log should be empty after compress");

  // The new episodic file should exist and be tagged as a compaction.
  const listAfter = await memory["read_memory"].handler({ limit: 5 }, { agentId });
  const parsedAfter = JSON.parse(listAfter);
  const compactionEntry = parsedAfter.memories.find((m: any) =>
    m.tags.includes("working-memory-compaction")
  );
  console.log("compaction episodic entry:", compactionEntry?.filename, compactionEntry?.title);
  if (!compactionEntry) throw new Error("no compaction episodic memory was written");

  console.log("\n✅ Phase 2 Day 1+2+3+4 smoke passed.");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
