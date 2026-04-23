/**
 * Vibe Demo V1 backend smoke — exercises the full flow via HTTP:
 *   1. POST /api/demos          create
 *   2. PUT  /api/demos/:id/file  write app.tsx (react-spa)
 *   3. PUT  /api/demos/:id/capabilities   declare table access
 *   4. POST /api/demos/:id/build          esbuild bundle
 *   5. GET  /api/demos/:id/preview/       private preview
 *   6. GET  /api/demos/:id/preview/sdk.js SDK injection
 *   7. POST /api/demo-runtime/:id/query   capability-gated call
 *   8. POST /api/demo-runtime/:id/records (createRecord — should succeed since declared)
 *   9. DELETE /api/demo-runtime/:id/records/:rid?tableId=...  (should fail — not declared)
 *  10. POST /api/demos/:id/publish         generate /share/:slug
 *  11. GET  /share/:slug/                  public anonymous access
 *  12. POST /api/demos/:id/unpublish       /share/:slug → 404
 *  13. DELETE /api/demos/:id               cleanup
 *
 * Usage (requires running backend on PORT=3001 or BACKEND_BASE_URL):
 *   cd backend && npx tsx src/scripts/demo-v1-smoke.ts
 */

const DEMO_SMOKE_BASE = process.env.BACKEND_BASE_URL || "http://localhost:3001";

async function smokeFetch(method: string, path: string, body?: unknown): Promise<{ status: number; data: any; text: string }> {
  const r = await fetch(`${DEMO_SMOKE_BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, data, text };
}

async function runSmoke() {
  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean, detail?: string) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}  ${detail ?? ""}`); }
  };

  console.log("=== Vibe Demo V1 Backend Smoke ===\n");

  // Find a real table for capability testing
  const tables = await smokeFetch("GET", "/api/workspaces/doc_default/tables");
  if (tables.status !== 200 || !tables.data?.length) {
    throw new Error("No tables in doc_default; seed first");
  }
  const targetTableId = tables.data[0].id;
  console.log(`target table: ${targetTableId}\n`);

  // 1. Create
  const create = await smokeFetch("POST", "/api/demos", {
    workspaceId: "doc_default",
    name: `V1 Smoke ${Date.now()}`,
    template: "static",
  });
  check("create demo", create.status === 201 && /^dm\d{12}$/.test(create.data?.id || ""), `got ${create.status} id=${create.data?.id}`);
  const demoId = create.data.id;

  // 2. Write files
  const writeHtml = await smokeFetch("PUT", `/api/demos/${demoId}/file`, {
    path: "index.html",
    content: `<!DOCTYPE html>
<html>
<head><title>Smoke Demo</title></head>
<body>
  <h1 id="h">Loading...</h1>
  <script>
    (async () => {
      try {
        const schema = await window.ImageBase.describeTable("${targetTableId}");
        document.getElementById("h").textContent = "Loaded table: " + schema.name;
      } catch (e) {
        document.getElementById("h").textContent = "ERROR: " + e.message;
      }
    })();
  </script>
</body>
</html>`,
  });
  check("write index.html", writeHtml.status === 200);

  // 3. Declare capabilities — read query + read describe + write createRecord
  const caps = await smokeFetch("PUT", `/api/demos/${demoId}/capabilities`, {
    dataTables: [targetTableId],
    dataIdeas: [],
    capabilities: { [targetTableId]: ["query", "describeTable", "createRecord"] },
  });
  check("update capabilities", caps.status === 200 && caps.data?.dataTables?.[0] === targetTableId);

  // 4. Build
  const build = await smokeFetch("POST", `/api/demos/${demoId}/build`, {});
  check(
    "build demo",
    build.status === 200 && build.data?.ok === true,
    build.data?.error,
  );

  // 5. Preview
  const preview = await smokeFetch("GET", `/api/demos/${demoId}/preview/`);
  check("preview index.html", preview.status === 200 && preview.text.includes("sdk.js"));

  // 6. SDK delivery (the one injected in index.html fetches ./sdk.js)
  const sdk = await smokeFetch("GET", `/api/demos/${demoId}/preview/sdk.js`);
  check("sdk.js is dist-side copy", sdk.status === 200 && sdk.text.includes("window.ImageBase"));

  // Also: runtime sdk.js (served by demo-runtime for arbitrary fetches)
  const sdk2 = await smokeFetch("GET", `/api/demo-runtime/${demoId}/sdk.js`);
  check("runtime sdk.js endpoint", sdk2.status === 200 && sdk2.text.includes("window.ImageBase"));

  // 7. Runtime query — should succeed
  const query = await smokeFetch("POST", `/api/demo-runtime/${demoId}/query`, {
    tableId: targetTableId,
    limit: 5,
  });
  check("runtime query (declared)", query.status === 200 && Array.isArray(query.data));

  // 8. Runtime query on NOT declared table — should 403
  const notDeclaredQuery = await smokeFetch("POST", `/api/demo-runtime/${demoId}/query`, {
    tableId: "tbl_requirements_that_is_not_declared_999",
    limit: 1,
  });
  check("runtime query (undeclared) returns 403 or 404", notDeclaredQuery.status === 403 || notDeclaredQuery.status === 404);

  // 9. Create record — should succeed (createRecord declared)
  const create1 = await smokeFetch("POST", `/api/demo-runtime/${demoId}/records`, {
    tableId: targetTableId,
    cells: { /* empty, server tolerates */ },
  });
  check("runtime createRecord (declared)", create1.status === 201, `status=${create1.status}`);
  const newRecordId = create1.data?.id;

  // 10. Delete record — should 403 (deleteRecord NOT declared)
  if (newRecordId) {
    const del = await smokeFetch(
      "DELETE",
      `/api/demo-runtime/${demoId}/records/${newRecordId}?tableId=${targetTableId}`,
    );
    check("runtime deleteRecord (undeclared) → 403", del.status === 403, `status=${del.status}`);
  }

  // 11. Schema mutation should 404
  const createTable = await smokeFetch("POST", `/api/demo-runtime/${demoId}/tables`, { name: "hacked" });
  check("schema mutation → 404", createTable.status === 404);

  // 12. Publish
  const publish = await smokeFetch("POST", `/api/demos/${demoId}/publish`, {});
  check(
    "publish demo",
    publish.status === 200 && typeof publish.data?.slug === "string" && publish.data.slug.length === 12,
    JSON.stringify(publish.data).slice(0, 200),
  );
  const slug = publish.data?.slug;

  // 13. Public share access
  if (slug) {
    const share = await smokeFetch("GET", `/share/${slug}/`);
    check(
      "/share/:slug/ public access",
      share.status === 200 && share.text.includes("sdk.js"),
      `status=${share.status}`,
    );
  }

  // 14. Unpublish
  const unpublish = await smokeFetch("POST", `/api/demos/${demoId}/unpublish`, {});
  check("unpublish demo", unpublish.status === 200);

  // 15. /share/:slug → 404 after unpublish
  if (slug) {
    const after = await smokeFetch("GET", `/share/${slug}/`);
    check("/share/:slug/ → 404 after unpublish", after.status === 404);
  }

  // 16. Cleanup
  const del = await smokeFetch("DELETE", `/api/demos/${demoId}`);
  check("delete demo cleanup", del.status === 200);

  console.log(`\n=== Smoke: ${pass} pass, ${fail} fail ===`);
  if (fail > 0) process.exit(1);
}

runSmoke().catch((err) => {
  console.error("[demo-v1-smoke] FAILED:", err);
  process.exit(1);
});
