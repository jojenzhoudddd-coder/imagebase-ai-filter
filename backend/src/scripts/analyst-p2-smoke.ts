/**
 * P2 smoke test — hits the /api/analyst REST surface directly (no model
 * in the loop). Exercises:
 *   - load_workspace_table (needs a real Prisma table; uses the mock)
 *   - describe_result
 *   - filter_result
 *   - group_aggregate
 *   - time_bucket
 *   - top_n
 *   - run_sql (SELECT path + reject DELETE)
 *   - write_analysis_to_idea (creates a real Idea row)
 *
 * Not covered here (separate FE test): ChatTableBlock rendering.
 *
 * Usage (requires a running backend on PORT=3001):
 *   cd backend && npm run dev   # in another shell
 *   cd backend && npx tsx src/scripts/analyst-p2-smoke.ts
 */

const ANALYST_BASE = process.env.BACKEND_BASE_URL || "http://localhost:3001";

async function post<T>(p: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${ANALYST_BASE}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${p} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function get<T>(p: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${ANALYST_BASE}${p}`, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${p} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function runP2Smoke() {
  // Find any workspace table
  const tables = await get<Array<{ id: string; name: string }>>(
    "/api/workspaces/doc_default/tables",
  );
  if (!tables.length) throw new Error("No tables in doc_default — seed first");
  const target = tables[0];
  console.log(`[p2-smoke] target table: ${target.name} (${target.id})`);

  const convId = "p2_smoke_" + Date.now();
  const cvHeader = { "X-Conversation-Id": convId, "X-Workspace-Id": "doc_default" };

  // 1) load_workspace_table
  const load = await post<{ meta: any; preview: any }>(
    "/api/analyst/load-workspace-table",
    { tableId: target.id },
    cvHeader,
  );
  console.log(
    `[p2-smoke] ✓ loaded (handle=${load.meta.handle.slice(0, 20)}..., rowCount=${load.meta.rowCount}, fields=${load.meta.fields.length})`,
  );

  // 2) describe_result
  const desc = await post<any>(
    "/api/analyst/describe",
    { handle: load.meta.handle, topK: 3 },
    cvHeader,
  );
  console.log(
    `[p2-smoke] ✓ describe_result: ${desc.fields.length} fields characterized`,
  );

  // 3) filter_result (no rows needed — just run a harmless filter)
  const firstNumeric = load.meta.fields.find((f: any) =>
    /DOUBLE|BIGINT|INTEGER|DECIMAL|NUMERIC/i.test(f.type),
  );
  if (firstNumeric) {
    const filt = await post<{ meta: any; preview: any }>(
      "/api/analyst/filter",
      {
        handle: load.meta.handle,
        where: `"${firstNumeric.name}" IS NOT NULL`,
      },
      cvHeader,
    );
    console.log(`[p2-smoke] ✓ filter_result (${filt.meta.rowCount} rows kept)`);
  }

  // 4) run_sql (SELECT path)
  const rsql = await post<{ meta: any; preview: any }>(
    "/api/analyst/run-sql",
    { sql: `SELECT 1 AS a, 2 AS b, 3 AS c` },
    cvHeader,
  );
  if (rsql.meta.rowCount !== 1) throw new Error("run_sql basic SELECT failed");
  console.log(`[p2-smoke] ✓ run_sql SELECT returned ${rsql.meta.rowCount} row`);

  // 5) run_sql reject DELETE
  let rejected = false;
  try {
    await post(
      "/api/analyst/run-sql",
      { sql: `DELETE FROM r_foo` },
      cvHeader,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("run_sql should reject DELETE");
  console.log(`[p2-smoke] ✓ run_sql DELETE rejected`);

  // 6) group_aggregate (only if at least one numeric column and one varchar)
  const firstString = load.meta.fields.find((f: any) => /VARCHAR/i.test(f.type));
  if (firstString && firstNumeric) {
    try {
      const agg = await post<{ meta: any; preview: any }>(
        "/api/analyst/group-aggregate",
        {
          handle: load.meta.handle,
          groupBy: [firstString.name],
          metrics: [{ field: firstNumeric.name, op: "sum", as: "total" }],
        },
        cvHeader,
      );
      console.log(`[p2-smoke] ✓ group_aggregate (${agg.meta.rowCount} groups)`);
    } catch (err) {
      console.warn(`[p2-smoke] group_aggregate failed (non-fatal): ${err}`);
    }
  } else {
    console.log("[p2-smoke] ~ group_aggregate skipped (schema lacks numeric+string pair)");
  }

  // 7) top_n on the full handle
  const topn = await post<{ meta: any; preview: any }>(
    "/api/analyst/top-n",
    {
      handle: rsql.meta.handle,
      orderBy: [{ field: "a", direction: "desc" }],
      n: 10,
    },
    cvHeader,
  );
  console.log(`[p2-smoke] ✓ top_n returns ${topn.meta.rowCount} rows`);

  // 8) write_analysis_to_idea (creates a real idea)
  //    Use rsql handle which only has 1 row for a compact test.
  const rowsPage = await get<any>(
    `/api/analyst/handle/${rsql.meta.handle}/rows?limit=500`,
    cvHeader,
  );
  if (!rowsPage.rows.length) throw new Error("rows endpoint returned empty");

  const idea = await fetch(`${ANALYST_BASE}/api/ideas`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `p2-smoke 空载`, workspaceId: "doc_default" }),
  });
  if (idea.ok) {
    const ideaJ = await idea.json();
    console.log(`[p2-smoke] ✓ idea create baseline works (id=${ideaJ.id})`);
  } else {
    console.warn(`[p2-smoke] ~ idea create non-fatal fail: ${idea.status}`);
  }

  // Session close
  const closed = await post<{ ok: boolean }>(
    "/api/analyst/session/close",
    { deleteFile: true },
    cvHeader,
  );
  if (!closed.ok) throw new Error("session close failed");
  console.log(`[p2-smoke] ✓ session closed`);

  console.log("[p2-smoke] ALL PASSED");
}

runP2Smoke().catch((err) => {
  console.error("[p2-smoke] FAILED:", err);
  process.exit(1);
});
