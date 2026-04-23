/**
 * P1 smoke test — exercises the DuckDB runtime end-to-end without running the
 * full backend. Verifies:
 *   1. Session creation + _result_meta registry table
 *   2. Parquet snapshot create → attach → query
 *   3. createResult → resolveHandle round trip
 *   4. previewResult pagination
 *   5. describeResult pure aggregation on a numeric column
 *   6. assertSafeSql rejects DELETE / DROP
 *   7. closeSession cleanup
 *
 * Runs in isolation using ANALYST_HOME=/tmp/analyst-smoke-<pid>.
 *
 * Usage:
 *   cd backend && npx tsx src/scripts/analyst-p1-smoke.ts
 */

import path from "path";
import os from "os";
import fsp from "fs/promises";

const tmp = path.join(os.tmpdir(), `analyst-smoke-${process.pid}`);
process.env.ANALYST_HOME = tmp;
process.env.RUNTIME_DISABLED = "1";

import * as runtime from "../services/analyst/duckdbRuntime.js";
import { DuckDBInstance } from "@duckdb/node-api";
import { snapshotsDir } from "../services/analyst/duckdbRuntime.js";

async function makeSyntheticSnapshot(tableId: string, rowCount: number) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(snapshotsDir(), `${tableId}@${ts}.parquet`);
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run(
    `CREATE TABLE t (id BIGINT, city VARCHAR, amount DOUBLE, created_at TIMESTAMP);`,
  );
  const batch = 500;
  for (let i = 0; i < rowCount; i += batch) {
    const vals: string[] = [];
    for (let j = i; j < Math.min(i + batch, rowCount); j++) {
      const city = ["北京", "上海", "广州", "深圳"][j % 4];
      const amount = (100 + (j * 7) % 9000).toFixed(2);
      const tsv = `2024-${String(((j % 12) + 1)).padStart(2, "0")}-01 00:00:00`;
      vals.push(`(${j}, '${city}', ${amount}, '${tsv}')`);
    }
    await conn.run(`INSERT INTO t VALUES ${vals.join(",")};`);
  }
  const safe = outFile.replace(/'/g, "''");
  await conn.run(`COPY t TO '${safe}' (FORMAT PARQUET, COMPRESSION ZSTD);`);
  conn.closeSync();
  instance.closeSync();
  return { path: outFile, snapshotAt: ts };
}

async function main() {
  console.log(`[smoke] ANALYST_HOME=${tmp}`);
  const convId = "smoke_" + Date.now().toString(36);

  // 1) Session creation + registry
  const sess = await runtime.getOrCreateSession(convId);
  if (!sess) throw new Error("session create failed");
  console.log(`[smoke] ✓ session created ${sess.conversationId}`);

  // 2) Build a snapshot and attach it as a view
  const snap = await makeSyntheticSnapshot("tbl_orders", 2_000);
  const viewName = await runtime.attachSnapshot(
    convId,
    "tbl_orders",
    snap.path,
    snap.snapshotAt,
  );
  console.log(`[smoke] ✓ snapshot attached as ${viewName}`);

  // 3) createResult → resolveHandle
  const meta = await runtime.createResult(convId, {
    sql: `SELECT city, COUNT(*)::BIGINT AS cnt, SUM(amount)::DOUBLE AS total FROM ${viewName} GROUP BY city`,
    sourceTableIds: ["tbl_orders"],
    snapshotAt: snap.snapshotAt,
    producedBy: "smoke_test",
  });
  if (meta.rowCount !== 4) throw new Error(`expected 4 rows, got ${meta.rowCount}`);
  const resolved = await runtime.resolveHandle(convId, meta.handle);
  if (resolved.handle !== meta.handle) throw new Error("handle resolve mismatch");
  console.log(`[smoke] ✓ createResult + resolveHandle OK (${meta.rowCount} rows, ${meta.fields.length} fields)`);

  // 4) previewResult
  const prev = await runtime.previewResult(convId, meta.handle, 2);
  if (prev.rows.length !== 2) throw new Error(`expected 2 preview rows, got ${prev.rows.length}`);
  if (prev.rowCount !== 4) throw new Error(`expected rowCount=4, got ${prev.rowCount}`);
  if (!prev.truncated) throw new Error("expected truncated=true when preview < rowCount");
  console.log(`[smoke] ✓ previewResult returns truncated preview (${prev.rows.length} of ${prev.rowCount})`);

  // 5) describeResult on the source view
  const srcMeta = await runtime.createResult(convId, {
    sql: `SELECT * FROM ${viewName}`,
    sourceTableIds: ["tbl_orders"],
    snapshotAt: snap.snapshotAt,
    producedBy: "smoke_describe",
  });
  const stats = await runtime.describeResult(convId, srcMeta.handle, { topK: 3 });
  const amountStat = stats.fields.find((f) => f.name === "amount");
  if (!amountStat || amountStat.mean == null) throw new Error("describe amount.mean missing");
  const cityStat = stats.fields.find((f) => f.name === "city");
  if (!cityStat || !cityStat.topValues?.length) throw new Error("describe city.topValues missing");
  console.log(`[smoke] ✓ describeResult produces aggregate stats (amount.mean=${amountStat.mean?.toFixed(2)}, city.top=${cityStat.topValues[0].value})`);

  // 6) assertSafeSql
  try {
    runtime.assertSafeSql("SELECT 1");
  } catch {
    throw new Error("SELECT 1 unexpectedly rejected");
  }
  const shouldReject = ["DROP TABLE t", "DELETE FROM t", "SELECT 1; DROP TABLE t"];
  for (const sql of shouldReject) {
    let thrown = false;
    try { runtime.assertSafeSql(sql); } catch { thrown = true; }
    if (!thrown) throw new Error(`assertSafeSql should reject: ${sql}`);
  }
  console.log(`[smoke] ✓ assertSafeSql rejects DROP/DELETE/multi-statement`);

  // 7) Close session
  await runtime.closeSession(convId);
  if (runtime.hasOpenSession(convId)) throw new Error("session still open after closeSession");
  console.log(`[smoke] ✓ closeSession clears runtime state`);

  // Clean tmp
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  console.log(`[smoke] ALL PASSED`);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
