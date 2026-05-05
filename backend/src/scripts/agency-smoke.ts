/**
 * Smoke test for Chaos Monkey Service (High Agency Mode)
 *
 * Usage:
 *   cd backend && npx tsx src/scripts/agency-smoke.ts
 *
 * Requires: ONEAPI_API_KEY + ONEAPI_BASE_URL in .env (gpt-5.5 via OneAPI)
 */

import "dotenv/config";
// Only register oneapiAdapter (gpt-5.5 uses oneapi, no circular dep via arkAdapter→mcp-server)
import { registerProviderAdapter } from "../services/modelRegistry.js";
import { oneapiAdapter } from "../services/providers/oneapiAdapter.js";
registerProviderAdapter(oneapiAdapter);

import { planRoadmap, validateMilestone } from "../services/chaosMonkeyService.js";
import type { WorkspaceContext } from "../services/chaosMonkeyService.js";

async function main() {
  console.log("═══ High Agency Smoke Test ═══\n");

  // ─── Test 1: Planning ─────────────────────────────────────────────────────
  console.log("▶ Test 1: planRoadmap()");
  console.log("  Goal: 创建一个客户管理表并写一份使用文档");
  console.log("  Todos: [先设计字段结构]");
  console.log("  Calling Chaos Monkey (gpt-5.5)...\n");

  const wsContext: WorkspaceContext = {
    tables: [],
    ideas: [],
    designs: [],
    demos: [],
  };

  const t0 = Date.now();
  const roadmap = await planRoadmap({
    goal: "创建一个客户管理表并写一份使用文档",
    todos: ["先设计字段结构"],
    workspaceContext: wsContext,
  });
  const planMs = Date.now() - t0;

  console.log(`  ✓ Planning completed in ${planMs}ms`);
  console.log(`  Segments: ${roadmap.segments.length}`);
  for (const seg of roadmap.segments) {
    console.log(`    [${seg.from}] → [${seg.to}]: ${seg.milestones.length} milestones`);
    for (const m of seg.milestones) {
      console.log(`      • ${m.title} (${m.acceptanceCriteria.length} criteria)`);
    }
  }
  console.log();

  // ─── Test 2: Validation (Pass scenario) ───────────────────────────────────
  console.log("▶ Test 2: validateMilestone() — should PASS");

  const firstMilestone = roadmap.segments[0]?.milestones[0];
  if (!firstMilestone) {
    console.log("  ⚠ No milestone to validate (roadmap was empty). Skipping.");
  } else {
    const t1 = Date.now();
    const passResult = await validateMilestone({
      milestone: firstMilestone,
      executionResult: `已完成：${firstMilestone.description}。所有验收标准均已满足。`,
      artifactsChanged: [
        { type: "table", id: "tbl_001", name: "客户管理", action: "created" },
      ],
    });
    const valMs = Date.now() - t1;

    console.log(`  ✓ Validation completed in ${valMs}ms`);
    console.log(`  Passed: ${passResult.passed}`);
    console.log(`  Reason: ${passResult.reason}`);
    if (passResult.suggestions) {
      console.log(`  Suggestions: ${passResult.suggestions.join("; ")}`);
    }
    console.log();
  }

  // ─── Test 3: Validation (Fail scenario) ───────────────────────────────────
  console.log("▶ Test 3: validateMilestone() — should FAIL");

  if (!firstMilestone) {
    console.log("  ⚠ Skipping (no milestone).");
  } else {
    const t2 = Date.now();
    const failResult = await validateMilestone({
      milestone: firstMilestone,
      executionResult: "我遇到了错误，没有完成任何操作。",
      artifactsChanged: [],
    });
    const valMs2 = Date.now() - t2;

    console.log(`  ✓ Validation completed in ${valMs2}ms`);
    console.log(`  Passed: ${failResult.passed}`);
    console.log(`  Reason: ${failResult.reason}`);
    if (failResult.suggestions) {
      console.log(`  Suggestions: ${failResult.suggestions.join("; ")}`);
    }
    console.log();
  }

  console.log("═══ All smoke tests completed ═══");
}

main().catch((err) => {
  console.error("✗ Smoke test failed:", err);
  process.exit(1);
});
