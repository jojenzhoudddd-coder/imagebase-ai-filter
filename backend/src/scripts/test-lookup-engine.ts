// Standalone tests for lookupEngine.
// Run:
//   cd backend && npx tsx src/scripts/test-lookup-engine.ts

import {
  computeLookup,
  computeLookupBatch,
  materializeLookups,
  effectiveTypeFor,
  LOOKUP_REF_SENTINEL,
} from "../services/lookupEngine.js";
import { Field, LookupConfig, Table, TableRecord } from "../types.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
function section(title: string) { console.log("\n" + title); }

// ─── Fixtures ───

const rec = (id: string, cells: Record<string, any>): TableRecord => ({
  id, tableId: "", cells, createdAt: 0, updatedAt: 0,
});

const assignments: Table = {
  id: "tbl_assign",
  name: "Assignments",
  fields: [
    { id: "rf_owner", tableId: "tbl_assign", name: "Owner", type: "Text",   isPrimary: true,  config: {} },
    { id: "rf_hours", tableId: "tbl_assign", name: "Hours", type: "Number", isPrimary: false, config: {} },
    { id: "rf_stage", tableId: "tbl_assign", name: "Stage", type: "SingleSelect", isPrimary: false, config: {} },
    { id: "rf_due",   tableId: "tbl_assign", name: "Due",   type: "DateTime", isPrimary: false, config: {} },
  ],
  records: [
    { ...rec("a1", { rf_owner: "Alice", rf_hours: 8,  rf_stage: "Doing", rf_due: new Date("2026-04-18").getTime() }), tableId: "tbl_assign" },
    { ...rec("a2", { rf_owner: "Alice", rf_hours: 4,  rf_stage: "Doing", rf_due: new Date("2026-04-25").getTime() }), tableId: "tbl_assign" },
    { ...rec("a3", { rf_owner: "Alice", rf_hours: 3,  rf_stage: "Done",  rf_due: new Date("2026-04-10").getTime() }), tableId: "tbl_assign" },
    { ...rec("a4", { rf_owner: "Bob",   rf_hours: 6,  rf_stage: "Doing", rf_due: new Date("2026-04-22").getTime() }), tableId: "tbl_assign" },
  ],
  views: [],
  autoNumberCounters: {},
};

const tasks: Table = {
  id: "tbl_tasks",
  name: "Tasks",
  fields: [
    { id: "f_owner", tableId: "tbl_tasks", name: "Owner", type: "Text", isPrimary: true, config: {} },
    // Lookup field added below
  ],
  records: [
    { ...rec("t1", { f_owner: "Alice" }), tableId: "tbl_tasks" },
    { ...rec("t2", { f_owner: "Bob" }),   tableId: "tbl_tasks" },
    { ...rec("t3", { f_owner: "Carol" }), tableId: "tbl_tasks" },
  ],
  views: [],
  autoNumberCounters: {},
};

const allTables = [tasks, assignments];
const ctx = { currentTable: tasks, allTables };

function lookupField(id: string, cfg: LookupConfig): Field {
  return { id, tableId: "tbl_tasks", name: id, type: "Lookup", isPrimary: false, config: { lookup: cfg } };
}

const baseLookup: LookupConfig = {
  refTableId: "tbl_assign",
  refFieldId: "rf_hours",
  conditions: [
    { refFieldId: "rf_owner", operator: "eq", valueType: "field", currentFieldId: "f_owner" },
  ],
  conditionLogic: "and",
  calcMethod: "sum",
  lookupOutputFormat: "number",
};

// ─── sum / count / average / max / min ───

section("聚合方式");

{
  const f = lookupField("lk_sum", baseLookup);
  assert("sum Alice = 15", computeLookup(f, tasks.records[0], ctx) === 15);
  assert("sum Bob = 6",    computeLookup(f, tasks.records[1], ctx) === 6);
  assert("sum Carol = 0",  computeLookup(f, tasks.records[2], ctx) === 0);
}
{
  const f = lookupField("lk_count", { ...baseLookup, calcMethod: "count" });
  assert("count Alice = 3", computeLookup(f, tasks.records[0], ctx) === 3);
  assert("count Bob = 1",   computeLookup(f, tasks.records[1], ctx) === 1);
  assert("count Carol = 0", computeLookup(f, tasks.records[2], ctx) === 0);
}
{
  const f = lookupField("lk_avg", { ...baseLookup, calcMethod: "average" });
  const alice = computeLookup(f, tasks.records[0], ctx);
  assert("average Alice = 5", alice === 5, `got ${alice}`);
  assert("average Carol = null", computeLookup(f, tasks.records[2], ctx) === null);
}
{
  const f = lookupField("lk_max", { ...baseLookup, calcMethod: "max" });
  assert("max Alice = 8", computeLookup(f, tasks.records[0], ctx) === 8);
}
{
  const f = lookupField("lk_min", { ...baseLookup, calcMethod: "min" });
  assert("min Alice = 3", computeLookup(f, tasks.records[0], ctx) === 3);
}

// ─── AND / OR ───

section("AND / OR 逻辑");
{
  // Alice AND stage=Doing → hours [8, 4] sum = 12
  const cfg: LookupConfig = {
    ...baseLookup,
    conditions: [
      { refFieldId: "rf_owner", operator: "eq", valueType: "field", currentFieldId: "f_owner" },
      { refFieldId: "rf_stage", operator: "eq", valueType: "constant", value: "Doing" },
    ],
    conditionLogic: "and",
  };
  const f = lookupField("lk_and", cfg);
  assert("Alice AND Doing = 12", computeLookup(f, tasks.records[0], ctx) === 12);
}
{
  // Alice OR stage=Doing → union sum = 8+4+3+6 = 21 (a1,a2,a3 Alice; a4 Doing)
  const cfg: LookupConfig = {
    ...baseLookup,
    conditions: [
      { refFieldId: "rf_owner", operator: "eq", valueType: "field", currentFieldId: "f_owner" },
      { refFieldId: "rf_stage", operator: "eq", valueType: "constant", value: "Doing" },
    ],
    conditionLogic: "or",
  };
  const f = lookupField("lk_or", cfg);
  assert("Alice OR Doing = 21", computeLookup(f, tasks.records[0], ctx) === 21);
}

// ─── original / deduplicate ───

section("original / deduplicate");
{
  const cfg: LookupConfig = { ...baseLookup, refFieldId: "rf_stage", calcMethod: "original", lookupOutputFormat: "default" };
  const f = lookupField("lk_orig", cfg);
  const v = computeLookup(f, tasks.records[0], ctx) as any;
  assert("original Alice = ['Doing','Doing','Done']", Array.isArray(v) && v.length === 3 && v.join(",") === "Doing,Doing,Done");

  const cfgD: LookupConfig = { ...cfg, calcMethod: "deduplicate" };
  const fD = lookupField("lk_dedupe", cfgD);
  const vD = computeLookup(fD, tasks.records[0], ctx) as any;
  assert("dedupe Alice = ['Doing','Done']", Array.isArray(vD) && vD.length === 2);

  const cfgDC: LookupConfig = { ...cfg, calcMethod: "deduplicateCount", lookupOutputFormat: "number" };
  const fDC = lookupField("lk_dc", cfgDC);
  assert("dedupe count Alice = 2", computeLookup(fDC, tasks.records[0], ctx) === 2);
}

// ─── Missing ref ───

section("#REF! 哨兵值");
{
  const bad: LookupConfig = { ...baseLookup, refTableId: "tbl_nope" };
  const f = lookupField("lk_bad", bad);
  assert("missing refTable → #REF!", computeLookup(f, tasks.records[0], ctx) === LOOKUP_REF_SENTINEL);
}
{
  const bad: LookupConfig = { ...baseLookup, refFieldId: "rf_nope" };
  const f = lookupField("lk_bad2", bad);
  assert("missing refField → #REF!", computeLookup(f, tasks.records[0], ctx) === LOOKUP_REF_SENTINEL);
}

// ─── Date constant (before today) ───

section("日期常量");
{
  // Set up: use an absolute date constant. Ref Due field; find records before 2026/04/20.
  const cfg: LookupConfig = {
    refTableId: "tbl_assign",
    refFieldId: "rf_hours",
    conditions: [
      { refFieldId: "rf_owner", operator: "eq", valueType: "field", currentFieldId: "f_owner" },
      { refFieldId: "rf_due", operator: "before", valueType: "constant", value: { type: "absolute", value: "2026/04/20" } as any },
    ],
    conditionLogic: "and",
    calcMethod: "sum",
    lookupOutputFormat: "number",
  };
  const f = lookupField("lk_date", cfg);
  // Alice: a1(18) before 4/20 → 8, a3(10) → 3.  4+0(a2 is 4/25)  → sum = 11
  assert("Alice sum hours before 4/20 = 11", computeLookup(f, tasks.records[0], ctx) === 11);
}

// ─── effectiveTypeFor ───

section("effectiveTypeFor");
assert("sum → Number",    effectiveTypeFor({ ...baseLookup, calcMethod: "sum" },    "Number") === "Number");
assert("count → Number",  effectiveTypeFor({ ...baseLookup, calcMethod: "count" },  "Text")   === "Number");
assert("max of date → DateTime", effectiveTypeFor({ ...baseLookup, calcMethod: "max" }, "DateTime") === "DateTime");
assert("original text → Text", effectiveTypeFor({ ...baseLookup, calcMethod: "original" }, "Text") === "Text");

// ─── computeLookupBatch ───

section("computeLookupBatch");
{
  const f = lookupField("lk_batch", baseLookup);
  const m = computeLookupBatch(f, tasks.records, ctx);
  assert("batch size = 3", m.size === 3);
  assert("batch Alice = 15", m.get("t1") === 15);
  assert("batch Bob = 6",    m.get("t2") === 6);
  assert("batch Carol = 0",  m.get("t3") === 0);
}

// ─── materializeLookups ───

section("materializeLookups");
{
  const tasksWithLookup: Table = {
    ...tasks,
    fields: [...tasks.fields, lookupField("f_total", baseLookup)],
  };
  const { records, fields } = materializeLookups(tasksWithLookup, tasksWithLookup.records, allTables);
  assert("original records untouched", tasksWithLookup.records[0].cells.f_total === undefined);
  assert("cloned Alice has f_total = 15", records[0].cells.f_total === 15);
  assert("field map type patched to Number", fields.get("f_total")!.type === "Number");
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
