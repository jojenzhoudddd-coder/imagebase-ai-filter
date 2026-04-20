/**
 * Phase 3 smoke test — skills (Tier 2) tier-split + activation wiring.
 *
 * Run with:  npx tsx backend/src/scripts/phase3-skills-smoke.ts
 *
 * Covers:
 *   - resolveActiveTools([]) is strictly Tier 0+1 (no table-skill tools leak)
 *   - resolveActiveTools(["table-skill"]) unlocks field / record / view CRUD
 *   - find_skill lists table-skill with the expected metadata
 *   - activate_skill / deactivate_skill invoke the ctx callbacks
 *   - tableSkill.triggers match common Chinese & English phrasings
 *   - Every tool is reachable via toolsByName (no orphans)
 *
 * No network / DB — this is a pure registry / routing test. Actual tool
 * execution (HTTP calls to the backend) is covered by other smoke tests.
 */

import {
  tier0Tools,
  tier1Tools,
  resolveActiveTools,
  allTools,
  toolsByName,
  toArkToolFormat,
} from "../../mcp-server/src/tools/index.js";
import { skillRouterTools } from "../../mcp-server/src/tools/skillRouterTools.js";
import { allSkills, skillsByName } from "../../mcp-server/src/skills/index.js";
import { tableSkill } from "../../mcp-server/src/skills/tableSkill.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("assertion failed: " + msg);
}

async function main() {
  // ── 1. Default tool set is Tier 0 + Tier 1 only ────────────────────────
  const baseline = resolveActiveTools([]);
  const baselineNames = new Set(baseline.map((t) => t.name));
  console.log("baseline tool count:", baseline.length);
  console.log(
    "baseline names sample:",
    [...baselineNames].slice(0, 12).join(", "),
    baselineNames.size > 12 ? "…" : ""
  );

  assert(baselineNames.has("list_tables"), "Tier 1 list_tables missing");
  assert(baselineNames.has("get_table"), "Tier 1 get_table missing");
  assert(baselineNames.has("find_skill"), "Tier 0 find_skill missing");
  assert(baselineNames.has("activate_skill"), "Tier 0 activate_skill missing");
  assert(baselineNames.has("deactivate_skill"), "Tier 0 deactivate_skill missing");

  // Tier 2 tools must NOT leak into baseline.
  for (const t of tableSkill.tools) {
    assert(
      !baselineNames.has(t.name) || t.name === "list_tables" || t.name === "get_table",
      `Tier 2 tool leaked into baseline: ${t.name}`
    );
  }
  // Sanity: a few known Tier 2 tools are definitely hidden.
  for (const hidden of ["create_field", "delete_field", "batch_create_records", "create_view"]) {
    assert(!baselineNames.has(hidden), `${hidden} should NOT be baseline`);
  }

  // Tier split totals should align.
  const expectedBaseline = tier0Tools.length + tier1Tools.length;
  assert(
    baseline.length === expectedBaseline,
    `baseline size ${baseline.length} != tier0+tier1 ${expectedBaseline}`
  );

  // ── 2. Activating table-skill unlocks its tools ────────────────────────
  const withSkill = resolveActiveTools(["table-skill"]);
  const withSkillNames = new Set(withSkill.map((t) => t.name));
  console.log("\nwith table-skill active, tool count:", withSkill.length);
  for (const must of [
    "create_field",
    "update_field",
    "batch_delete_fields",
    "batch_create_records",
    "create_view",
    "update_view",
  ]) {
    assert(withSkillNames.has(must), `${must} should appear after activating table-skill`);
  }
  assert(
    withSkillNames.has("list_tables"),
    "Tier 1 list_tables must still be visible with skill active"
  );
  // Activating twice is idempotent.
  const twice = resolveActiveTools(["table-skill", "table-skill"]);
  assert(twice.length === withSkill.length, "duplicate skill names must not duplicate tools");

  // Unknown skill name is silently ignored.
  const unknown = resolveActiveTools(["nope-skill"]);
  assert(unknown.length === baseline.length, "unknown skill should be ignored");

  // ── 3. find_skill returns the catalog ──────────────────────────────────
  const find = skillRouterTools.find((t) => t.name === "find_skill")!;
  const findOut = await find.handler({}, { activeSkills: [] });
  const findParsed = JSON.parse(findOut);
  console.log(
    "\nfind_skill says:",
    findParsed.count,
    "skills;",
    findParsed.skills.map((s: any) => s.name).join(", ")
  );
  assert(findParsed.ok, "find_skill ok:false");
  assert(findParsed.count === allSkills.length, "find_skill count mismatch");
  const tableEntry = findParsed.skills.find((s: any) => s.name === "table-skill");
  assert(tableEntry, "table-skill missing from find_skill");
  assert(tableEntry.toolCount === tableSkill.tools.length, "tool count mismatch");
  assert(tableEntry.active === false, "table-skill should NOT be active in this call");

  const findActive = await find.handler({}, { activeSkills: ["table-skill"] });
  const findActiveParsed = JSON.parse(findActive);
  const activeEntry = findActiveParsed.skills.find((s: any) => s.name === "table-skill");
  assert(activeEntry.active === true, "active flag should reflect ctx.activeSkills");

  // ── 4. activate_skill / deactivate_skill call the callbacks ────────────
  const activate = skillRouterTools.find((t) => t.name === "activate_skill")!;
  const deactivate = skillRouterTools.find((t) => t.name === "deactivate_skill")!;
  const activated: string[] = [];
  const deactivated: string[] = [];
  const ctx = {
    activeSkills: [] as string[],
    onActivateSkill: (n: string) => activated.push(n),
    onDeactivateSkill: (n: string) => deactivated.push(n),
  };

  const aOk = JSON.parse(await activate.handler({ name: "table-skill" }, ctx));
  assert(aOk.ok && aOk.activated === "table-skill", "activate_skill happy path failed");
  assert(activated.length === 1 && activated[0] === "table-skill", "onActivateSkill not called");
  assert(
    Array.isArray(aOk.newlyAvailableTools) && aOk.newlyAvailableTools.length > 0,
    "activate_skill should list newly available tools"
  );

  const aBad = JSON.parse(await activate.handler({ name: "does-not-exist" }, ctx));
  assert(!aBad.ok, "activate_skill on unknown name should return ok:false");
  assert(Array.isArray(aBad.available), "unknown activation should list available skills");

  const aMissing = JSON.parse(await activate.handler({}, ctx));
  assert(!aMissing.ok, "activate_skill w/o name should return ok:false");

  const dOk = JSON.parse(await deactivate.handler({ name: "table-skill" }, ctx));
  assert(dOk.ok && dOk.deactivated === "table-skill", "deactivate_skill happy path failed");
  assert(deactivated[0] === "table-skill", "onDeactivateSkill not called");

  // ── 5. Trigger regexes cover common phrasings ──────────────────────────
  const phrases = [
    "帮我创建一个字段",
    "给项目表加一个字段叫优先级",
    "删除这条记录",
    "批量导入数据",
    "add a new column called owner",
    "delete record row 3",
    "create view for my tasks",
  ];
  for (const p of phrases) {
    const hit = tableSkill.triggers.some((t) =>
      typeof t === "string" ? p.includes(t) : t.test(p)
    );
    assert(hit, `trigger missed: "${p}"`);
  }
  // Negative cases that should NOT auto-activate the table skill.
  const noTrigger = [
    "你好",
    "今天星期几",
    "帮我总结一下昨天的工作",
  ];
  for (const p of noTrigger) {
    const hit = tableSkill.triggers.some((t) =>
      typeof t === "string" ? p.includes(t) : t.test(p)
    );
    assert(!hit, `trigger falsely matched: "${p}"`);
  }

  // ── 6. toolsByName / ARK formatter cover every tool ────────────────────
  for (const t of allTools) {
    assert(toolsByName[t.name] === t, `toolsByName missing ${t.name}`);
  }
  const arkFmt = toArkToolFormat(withSkill);
  assert(arkFmt.length === withSkill.length, "ARK formatter dropped tools");
  assert(
    arkFmt.every((f) => f.type === "function" && typeof f.name === "string"),
    "ARK formatter output malformed"
  );

  // ── 7. Skill catalog block renders active flag correctly ───────────────
  // buildSkillCatalog is private; we exercise it indirectly by checking
  // the skill registry produces catalog-friendly fields.
  for (const s of allSkills) {
    assert(typeof s.displayName === "string" && s.displayName.length > 0, `${s.name} missing displayName`);
    assert(typeof s.when === "string" && s.when.length > 0, `${s.name} missing when`);
    assert(Array.isArray(s.tools) && s.tools.length > 0, `${s.name} has no tools`);
  }
  assert(skillsByName["table-skill"] === tableSkill, "skillsByName lookup broken");

  console.log("\n✅ Phase 3 skills smoke passed.");
  console.log(
    `   baseline tools=${baseline.length}, +table-skill=${withSkill.length}, total registered=${allTools.length}, skills=${allSkills.length}`
  );
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
