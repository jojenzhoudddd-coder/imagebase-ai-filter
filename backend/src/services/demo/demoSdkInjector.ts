/**
 * demoSdkInjector — generates the `window.ImageBase` SDK JS for a Demo
 * based on its declared capabilities. See docs/vibe-demo-plan.md §7.
 *
 * Key invariant: the generated SDK object **only contains methods that the
 * Demo's capabilities explicitly permit**. Unknown-to-Demo operations don't
 * appear in `window.ImageBase` at all, so a browser devtools attacker can't
 * call them via `ImageBase.deleteRecord(...)` — they're not defined. The
 * backend also enforces capability via `demoCapabilityGuard` as the second
 * layer of defence.
 */

import type { Capabilities } from "../../schemas/demoSchema.js";

export interface BuildSdkOptions {
  demoId: string;
  dataTables: string[];
  dataIdeas: string[];
  capabilities: Capabilities;
  /** Base URL for demo-runtime API (defaults to `/api/demo-runtime`). */
  runtimeBase?: string;
}

/**
 * Aggregate the capability set across all declared resources to decide which
 * method *stubs* should appear in the SDK. We generate a method if ANY
 * resource allows that capability — per-call the backend also checks the
 * specific resource the caller passed.
 */
function collectAllCaps(caps: Capabilities): Set<string> {
  const s = new Set<string>();
  for (const arr of Object.values(caps)) {
    for (const c of arr) s.add(c);
  }
  return s;
}

/** Read-side caps that are always exposed when the Demo declares at least
 * one matching resource (no explicit opt-in required in prompt). Keeps the
 * SDK usable for typical "fetch data to render" flows without extra knobs. */
const IMPLICIT_TABLE_READS = new Set(["query", "getRecord", "describeTable"]);
const IMPLICIT_IDEA_READS = new Set(["listIdeas", "readIdea"]);

function effectiveCaps(
  caps: Capabilities,
  dataTables: string[],
  dataIdeas: string[],
): Set<string> {
  const s = collectAllCaps(caps);
  // Implicit reads: Agent declared these resources, so give it read tools
  // even if capability list is terse.
  if (dataTables.length > 0) {
    for (const c of IMPLICIT_TABLE_READS) s.add(c);
  }
  if (dataIdeas.length > 0) {
    for (const c of IMPLICIT_IDEA_READS) s.add(c);
  }
  return s;
}

/**
 * Build the SDK JS file content. Pure — no IO. The output is raw JS to be
 * served as application/javascript. No sourcemap, no minification (the SDK
 * is < 2 KB, and human-readable helps debugging in the iframe console).
 */
export function buildSdkJs(opts: BuildSdkOptions): string {
  const { demoId, dataTables, dataIdeas, capabilities } = opts;
  const caps = effectiveCaps(capabilities, dataTables, dataIdeas);
  const base = opts.runtimeBase || "/api/demo-runtime";

  const methods: string[] = [];

  // --- Table read ---
  if (caps.has("query")) {
    methods.push(`
    async query(tableId, options = {}) {
      return _req("POST", "/query", { tableId, ...options });
    }`);
  }
  if (caps.has("getRecord")) {
    methods.push(`
    async getRecord(tableId, recordId) {
      return _req("GET", "/records/" + encodeURIComponent(recordId) + "?tableId=" + encodeURIComponent(tableId));
    }`);
  }
  if (caps.has("describeTable")) {
    methods.push(`
    async describeTable(tableId) {
      return _req("GET", "/tables/" + encodeURIComponent(tableId) + "/schema");
    }`);
  }

  // --- Table write ---
  if (caps.has("createRecord")) {
    methods.push(`
    async createRecord(tableId, cells) {
      return _req("POST", "/records", { tableId, cells });
    }`);
    methods.push(`
    async batchCreate(tableId, records) {
      return _req("POST", "/batch-create", { tableId, records });
    }`);
  }
  if (caps.has("updateRecord")) {
    methods.push(`
    async updateRecord(tableId, recordId, cells) {
      return _req("PUT", "/records/" + encodeURIComponent(recordId), { tableId, cells });
    }`);
    methods.push(`
    async batchUpdate(tableId, updates) {
      return _req("POST", "/batch-update", { tableId, updates });
    }`);
  }
  if (caps.has("deleteRecord")) {
    methods.push(`
    async deleteRecord(tableId, recordId) {
      return _req("DELETE", "/records/" + encodeURIComponent(recordId) + "?tableId=" + encodeURIComponent(tableId));
    }`);
    methods.push(`
    async batchDelete(tableId, recordIds) {
      return _req("POST", "/batch-delete", { tableId, recordIds });
    }`);
  }

  // --- Idea read ---
  if (caps.has("listIdeas")) {
    methods.push(`
    async listIdeas() {
      return _req("GET", "/ideas");
    }`);
  }
  if (caps.has("readIdea")) {
    methods.push(`
    async readIdea(ideaId) {
      return _req("GET", "/ideas/" + encodeURIComponent(ideaId));
    }`);
  }

  const dataTablesJson = JSON.stringify(dataTables);
  const dataIdeasJson = JSON.stringify(dataIdeas);
  const capabilitiesJson = JSON.stringify(capabilities);

  return `// ImageBase SDK — auto-generated for demo=${demoId}
// Capabilities declared at build time; methods you don't see here do not exist.
(function() {
  var DEMO_ID = ${JSON.stringify(demoId)};
  var BASE = location.origin + ${JSON.stringify(base)} + "/" + DEMO_ID;

  // ─── Runtime error overlay ─────────────────────────────────────────────
  // Agent-generated Demo code frequently throws on unexpected data shapes
  // (e.g. record.fields.xxx where fields is undefined). Without a safety
  // net, React unmounts the whole tree on a render-phase throw and the
  // iframe goes blank — no clue for the user or the Agent what broke.
  // This handler catches uncaught errors + unhandled rejections + the
  // "root mounted but empty" case and paints a readable error card so
  // the failure is visible and iterable.
  function _showError(kind, message, stack) {
    try {
      var existing = document.getElementById("__imagebase_err__");
      if (existing) existing.remove();
      var root = document.getElementById("root");
      if (root) root.style.visibility = "hidden";
      var box = document.createElement("div");
      box.id = "__imagebase_err__";
      box.style.cssText = [
        "position:fixed", "inset:0", "z-index:2147483647",
        "background:#FEF3F2", "color:#991B1B",
        "padding:24px", "overflow:auto",
        "font:13px/1.6 -apple-system,BlinkMacSystemFont,'SF Pro',sans-serif",
      ].join(";");
      box.innerHTML =
        '<div style="max-width:820px;margin:0 auto">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
            '<span style="width:18px;height:18px;border-radius:50%;background:#DC2626;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700">!</span>' +
            '<span style="font-weight:600;font-size:14px">Demo 运行时错误 (' + kind + ')</span>' +
          '</div>' +
          '<div style="padding:10px 12px;background:#fff;border:1px solid #FECACA;border-radius:6px;margin-bottom:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word">' +
            String(message || "(no message)").replace(/[&<>]/g, function (c) {
              return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
            }) +
          '</div>' +
          (stack ?
            '<details style="padding:10px 12px;background:#fff;border:1px solid #FECACA;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px"><summary style="cursor:pointer;color:#6B7280">堆栈</summary><pre style="margin:8px 0 0;white-space:pre-wrap;word-break:break-word">' +
              String(stack).replace(/[&<>]/g, function (c) {
                return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
              }) +
            '</pre></details>' : '') +
          '<div style="margin-top:12px;color:#6B7280;font-size:12px">提示：把这段错误复制给 Agent，它会据此修复代码。</div>' +
        '</div>';
      (document.body || document.documentElement).appendChild(box);
    } catch (_) { /* last-resort: nothing we can do */ }
  }
  window.addEventListener("error", function (e) {
    _showError("error", (e && (e.message || e.error && e.error.message)) || "unknown",
      e && e.error && e.error.stack);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var reason = e && e.reason;
    var msg = reason && (reason.message || reason.toString()) || "unhandled promise rejection";
    _showError("rejection", msg, reason && reason.stack);
  });
  // "Mounted but empty" net: if the root is still empty 2s after load,
  // that usually means React threw during initial render before rendering
  // anything. The error listener above should have fired; if it didn't,
  // surface a generic message so the user isn't staring at a blank page.
  window.addEventListener("load", function () {
    setTimeout(function () {
      var root = document.getElementById("root");
      if (root && !root.hasChildNodes() && !document.getElementById("__imagebase_err__")) {
        _showError("empty", "Demo mounted an empty tree. Likely an uncaught error during render.", null);
      }
    }, 2000);
  });
  // Expose so user code (or an ErrorBoundary) can call manually.
  window.__imagebaseShowError = _showError;


  async function _req(method, path, body) {
    var r = await fetch(BASE + path, {
      method: method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      var err = {};
      try { err = await r.json(); } catch (_) {}
      throw new Error(err.error || ("HTTP " + r.status));
    }
    if (r.status === 204) return undefined;
    return r.json();
  }

  var SDK = Object.freeze({
    ${methods.join(",\n    ")}${methods.length ? "," : ""}
    get demoId() { return DEMO_ID; },
    get dataTables() { return ${dataTablesJson}; },
    get dataIdeas() { return ${dataIdeasJson}; },
    get capabilities() { return ${capabilitiesJson}; },
  });

  window.ImageBase = SDK;
  try {
    console.log(
      "%c[ImageBase SDK loaded]",
      "color:#1456F0;font-weight:bold",
      "demo=", DEMO_ID,
      "tables=", SDK.dataTables,
      "ideas=", SDK.dataIdeas,
      "capabilities=", SDK.capabilities
    );
  } catch (_) {}
})();
`;
}

/**
 * HTML snippet to inject before </head> so the SDK loads ASAP, before the
 * Demo's own scripts. Returned as a string, caller patches index.html.
 */
export function sdkScriptTag(): string {
  return `<script src="./sdk.js" defer></script>`;
}

/**
 * Patch an index.html string: insert the SDK script tag into <head>, or
 * prepend to <body> if no <head> tag is found. Idempotent (won't inject
 * twice if already present).
 */
export function injectSdkTag(html: string): string {
  if (html.includes(`src="./sdk.js"`)) return html;
  const tag = sdkScriptTag();
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `  ${tag}\n</head>`);
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n  ${tag}`);
  }
  // No head — insert before first <body> or at start
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body[^>]*>/i, (m) => `${m}\n  ${tag}`);
  }
  return `<!DOCTYPE html><html><head>${tag}</head><body>${html}</body></html>`;
}
