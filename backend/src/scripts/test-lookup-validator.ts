// Standalone test script for lookupValidator.
// Run:
//   cd backend && npx tsx src/scripts/test-lookup-validator.ts
// Exits non-zero if any assertion fails.

import { validateLookupConfig, getAllowedOperators } from "../services/lookupValidator.js";
import { Table, LookupConfig } from "../types.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? " — " + detail : ""));
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

function section(title: string) {
  console.log("\n" + title);
}

// ─── Fixtures ───

const tblCurrent: Table = {
  id: "tbl_current",
  name: "Tasks",
  fields: [
    { id: "f_owner", tableId: "tbl_current", name: "Owner", type: "Text", isPrimary: true, config: {} },
    { id: "f_stage", tableId: "tbl_current", name: "Stage", type: "Text", isPrimary: false, config: {} },
    { id: "f_due",   tableId: "tbl_current", name: "Due",   type: "DateTime", isPrimary: false, config: {} },
    // the Lookup we're about to validate
  ],
  records: [],
  views: [],
  autoNumberCounters: {},
};

const tblRef: Table = {
  id: "tbl_ref",
  name: "Assignments",
  fields: [
    { id: "rf_owner", tableId: "tbl_ref", name: "Owner", type: "Text",   isPrimary: true,  config: {} },
    { id: "rf_hours", tableId: "tbl_ref", name: "Hours", type: "Number", isPrimary: false, config: {} },
    { id: "rf_stage", tableId: "tbl_ref", name: "Stage", type: "SingleSelect", isPrimary: false, config: {} },
    { id: "rf_due",   tableId: "tbl_ref", name: "Due",   type: "DateTime",    isPrimary: false, config: {} },
  ],
  records: [],
  views: [],
  autoNumberCounters: {},
};

// A 3rd table for "forbid cross-table reference" tests
const tblOther: Table = {
  id: "tbl_other",
  name: "Other",
  fields: [
    { id: "of_x", tableId: "tbl_other", name: "X", type: "Text", isPrimary: true, config: {} },
  ],
  records: [],
  views: [],
  autoNumberCounters: {},
};

const allTables = [tblCurrent, tblRef, tblOther];

// Valid baseline config: sum of hours for same-owner rows, stage = "Doing"
const baseConfig: LookupConfig = {
  refTableId: "tbl_ref",
  refFieldId: "rf_hours",
  conditions: [
    { refFieldId: "rf_owner", operator: "eq", valueType: "field", currentFieldId: "f_owner" },
    { refFieldId: "rf_stage", operator: "eq", valueType: "constant", value: "Doing" },
  ],
  conditionLogic: "and",
  calcMethod: "sum",
  lookupOutputFormat: "number",
};

// ─── Operator whitelist ───

section("§3.4 getAllowedOperators");
assert("Text → 5 operators", getAllowedOperators("Text").length === 5);
assert("Text includes contains", getAllowedOperators("Text").includes("contains"));
assert("Text excludes gt", !getAllowedOperators("Text").includes("gt"));
assert("Number → 9 operators", getAllowedOperators("Number").length === 9);
assert("Number includes gt", getAllowedOperators("Number").includes("gt"));
assert("DateTime → 9 operators", getAllowedOperators("DateTime").length === 9);
assert("DateTime includes after", getAllowedOperators("DateTime").includes("after"));
assert("DateTime excludes gt", !getAllowedOperators("DateTime").includes("gt"));

// ─── Validation happy path ───

section("validateLookupConfig — happy path");
{
  const r = validateLookupConfig(baseConfig, "tbl_current", tblCurrent, allTables, null);
  assert("base config valid", r.valid, r.error);
}

// ─── §6.1 Rule 2: forbid self-reference ───

section("§2.1 禁止自查询");
{
  const bad = { ...baseConfig, refTableId: "tbl_current" };
  const r = validateLookupConfig(bad, "tbl_current", tblCurrent, allTables, null);
  assert("refTable === current rejected", !r.valid && r.path === "refTableId");
}

// ─── Rule 3: missing ref table/field ───

section("引用表/字段缺失");
{
  const r1 = validateLookupConfig({ ...baseConfig, refTableId: "tbl_nope" }, "tbl_current", tblCurrent, allTables, null);
  assert("unknown refTableId rejected", !r1.valid && r1.path === "refTableId");
  const r2 = validateLookupConfig({ ...baseConfig, refFieldId: "rf_nope" }, "tbl_current", tblCurrent, allTables, null);
  assert("unknown refFieldId rejected", !r2.valid && r2.path === "refFieldId");
}

// ─── Rule 4: condition count ───

section("查找条件数量 1..5");
{
  const zero = { ...baseConfig, conditions: [] };
  const r1 = validateLookupConfig(zero, "tbl_current", tblCurrent, allTables, null);
  assert("0 conditions rejected", !r1.valid && r1.path === "conditions");

  const six = {
    ...baseConfig,
    conditions: Array.from({ length: 6 }, () => ({
      refFieldId: "rf_owner", operator: "eq", valueType: "field", currentFieldId: "f_owner",
    } as any)),
  };
  const r2 = validateLookupConfig(six, "tbl_current", tblCurrent, allTables, null);
  assert("6 conditions rejected", !r2.valid && r2.path === "conditions");
}

// ─── Rule 6: operator whitelist ───

section("运算符白名单");
{
  // gt on Text field — forbidden
  const bad = {
    ...baseConfig,
    conditions: [
      { refFieldId: "rf_owner", operator: "gt", valueType: "constant", value: "X" },
    ],
  } as LookupConfig;
  const r = validateLookupConfig(bad, "tbl_current", tblCurrent, allTables, null);
  assert("gt on Text LHS rejected", !r.valid && r.path?.endsWith(".operator") === true, r.error);
}

// ─── Rule 6: RHS must be current table field ───

section("右值禁止引用其他表字段");
{
  const bad = {
    ...baseConfig,
    conditions: [
      // valueType=field but currentFieldId points to a field that doesn't exist on tbl_current
      { refFieldId: "rf_owner", operator: "eq", valueType: "field", currentFieldId: "of_x" },
    ],
  } as LookupConfig;
  const r = validateLookupConfig(bad, "tbl_current", tblCurrent, allTables, null);
  assert("RHS = other-table field rejected", !r.valid && r.path?.includes("currentFieldId") === true, r.error);
}

// ─── §3.5 date constant rules ───

section("§3.5 日期常量");
{
  const goodRelative: LookupConfig = {
    ...baseConfig,
    refFieldId: "rf_due",
    conditions: [
      { refFieldId: "rf_due", operator: "before", valueType: "constant", value: "today" as any },
    ],
    calcMethod: "max",
    lookupOutputFormat: "date",
  };
  const r1 = validateLookupConfig(goodRelative, "tbl_current", tblCurrent, allTables, null);
  assert("date constant 'today' accepted", r1.valid, r1.error);

  const goodAbsolute: LookupConfig = {
    ...goodRelative,
    conditions: [
      { refFieldId: "rf_due", operator: "before", valueType: "constant", value: { type: "absolute", value: "2026/04/20" } as any },
    ],
  };
  const r2 = validateLookupConfig(goodAbsolute, "tbl_current", tblCurrent, allTables, null);
  assert("date constant 2026/04/20 accepted", r2.valid, r2.error);

  const badDynamic: LookupConfig = {
    ...goodRelative,
    conditions: [
      { refFieldId: "rf_due", operator: "before", valueType: "constant", value: "next7Days" as any },
    ],
  };
  const r3 = validateLookupConfig(badDynamic, "tbl_current", tblCurrent, allTables, null);
  assert("date constant 'next7Days' rejected", !r3.valid, r3.error);

  const badFormat: LookupConfig = {
    ...goodRelative,
    conditions: [
      { refFieldId: "rf_due", operator: "before", valueType: "constant", value: { type: "absolute", value: "2026-04-20" } as any },
    ],
  };
  const r4 = validateLookupConfig(badFormat, "tbl_current", tblCurrent, allTables, null);
  assert("date constant with wrong format rejected", !r4.valid, r4.error);
}

// ─── Rule 7: calc method vs ref field type ───

section("计算方式与引用字段类型兼容");
{
  // sum on Text field — forbidden
  const bad: LookupConfig = { ...baseConfig, refFieldId: "rf_owner" };
  const r = validateLookupConfig(bad, "tbl_current", tblCurrent, allTables, null);
  assert("sum on Text ref field rejected", !r.valid && r.path === "calcMethod", r.error);
}

// ─── §3.6 output format whitelist ───

section("§3.6 字段格式白名单");
{
  // calcMethod=sum + format=text — forbidden
  const bad: LookupConfig = { ...baseConfig, lookupOutputFormat: "text" };
  const r = validateLookupConfig(bad, "tbl_current", tblCurrent, allTables, null);
  assert("sum + text format rejected", !r.valid && r.path === "lookupOutputFormat", r.error);

  // calcMethod=original + format=default — allowed
  const ok: LookupConfig = { ...baseConfig, calcMethod: "original", lookupOutputFormat: "default" };
  const r2 = validateLookupConfig(ok, "tbl_current", tblCurrent, allTables, null);
  assert("original + default format allowed", r2.valid, r2.error);
}

// ─── Rule 9: circular reference ───

section("查找引用成环检测");
{
  // Build a ref table where rf_hours is itself a Lookup pointing back to tbl_current's f_cycle
  const tblCurr2: Table = JSON.parse(JSON.stringify(tblCurrent));
  tblCurr2.fields.push({
    id: "f_cycle",
    tableId: "tbl_current",
    name: "Cycle",
    type: "Lookup",
    isPrimary: false,
    config: {} as any,
  });
  const tblRef2: Table = JSON.parse(JSON.stringify(tblRef));
  // replace rf_hours with a Lookup pointing at tbl_current.f_cycle
  tblRef2.fields = tblRef2.fields.map(f => f.id === "rf_hours"
    ? ({
        ...f, type: "Lookup",
        config: {
          lookup: {
            refTableId: "tbl_current",
            refFieldId: "f_cycle",
            conditions: [{ refFieldId: "f_owner", operator: "eq", valueType: "constant", value: "x" }],
            conditionLogic: "and",
            calcMethod: "original",
            lookupOutputFormat: "default",
          } as LookupConfig,
        },
      })
    : f);

  const bad: LookupConfig = { ...baseConfig, refTableId: "tbl_ref", refFieldId: "rf_hours", calcMethod: "original", lookupOutputFormat: "default" };
  const r = validateLookupConfig(bad, "tbl_current", tblCurr2, [tblCurr2, tblRef2, tblOther], "f_cycle");
  assert("cycle detected", !r.valid && r.path === "refFieldId", r.error);
}

// ─── Done ───

console.log(`\n${"─".repeat(50)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log("\nFailures:");
  failures.forEach(f => console.log("  - " + f));
  process.exit(1);
}
process.exit(0);
