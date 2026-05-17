/**
 * Demo-skill MCP tools — thin HTTP proxies to /api/demos/*.
 *
 * Split into two exports:
 *   - `demoNavTools`    (Tier 1, always-on): list_demos, get_demo
 *   - `demoWriteTools`  (Tier 2, demo-skill): everything else (~10 tools)
 *
 * See docs/vibe-demo-plan.md §9 + §10.
 */

import { apiRequest, toolResult, confirmationRequired, DEFAULT_WORKSPACE_ID } from "../dataStoreClient.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

function fwd(ctx?: ToolContext) {
  return {
    workspaceId: ctx?.workspaceId || DEFAULT_WORKSPACE_ID,
  };
}

// ─── Tier 1 · always-on navigation ────────────────────────────────────────

export const demoNavTools: ToolDefinition[] = [
  {
    name: "list_demos",
    description:
      "列出指定 workspace 下的所有 Demo（Vibe design / Vibe coding 生成的可运行前端 artifact）。" +
      "返回 id / name / template / lastBuildStatus / publishSlug。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "默认使用当前工作空间" },
      },
    },
    handler: async (args, ctx) => {
      const wsId = (args.workspaceId as string) || ctx?.workspaceId || DEFAULT_WORKSPACE_ID;
      const data = await apiRequest<any>(`/api/demos?workspaceId=${encodeURIComponent(wsId)}`);
      return toolResult(data);
    },
  },

  {
    name: "get_demo",
    description:
      "获取 Demo 的详细信息：id / name / template / 源文件列表（路径 + 大小）/ " +
      "dataTables / dataIdeas / capabilities / lastBuildStatus / publishSlug。" +
      "Agent 在编辑前应先调这个了解现状。",
    inputSchema: {
      type: "object",
      required: ["demoId"],
      properties: {
        demoId: { type: "string" },
      },
    },
    handler: async (args) => {
      const id = String(args.demoId);
      const data = await apiRequest<any>(`/api/demos/${encodeURIComponent(id)}?includeFiles=true`);
      return toolResult(data);
    },
  },
];

// ─── Tier 2 · demo-skill write/build/publish tools ────────────────────────

export const demoWriteTools: ToolDefinition[] = [
  {
    name: "create_demo",
    description:
      "创建一个新 Demo artifact 并 scaffold 初始文件。" +
      "template 选择：`static`（HTML/CSS/JS 静态，Vibe design 首选） 或 `react-spa`（React 18 + TS + Tailwind，Vibe coding 首选）。" +
      "返回 demoId、scaffolded 文件列表。",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        workspaceId: { type: "string", description: "默认使用当前工作空间" },
        name: { type: "string", description: "Demo 名称，如 '活动报名表'" },
        template: { type: "string", enum: ["static", "react-spa"], description: "模板，默认 static" },
      },
    },
    handler: async (args, ctx) => {
      const body = {
        workspaceId: (args.workspaceId as string) || ctx?.workspaceId || DEFAULT_WORKSPACE_ID,
        name: args.name,
        template: args.template || "static",
      };
      const data = await apiRequest<any>("/api/demos", { method: "POST", body });
      return toolResult(data);
    },
  },

  {
    name: "rename_demo",
    description: "修改 Demo 名称。",
    inputSchema: {
      type: "object",
      required: ["demoId", "name"],
      properties: {
        demoId: { type: "string" },
        name: { type: "string" },
      },
    },
    handler: async (args) => {
      const data = await apiRequest<any>(`/api/demos/${encodeURIComponent(String(args.demoId))}`, {
        method: "PATCH",
        body: { name: args.name },
      });
      return toolResult(data);
    },
  },

  {
    name: "delete_demo",
    description: "⚠️ 删除整个 Demo（元数据 + 所有文件 + dist + 已发布快照）。不可撤销。必须先征得用户同意。",
    danger: true,
    inputSchema: {
      type: "object",
      required: ["demoId"],
      properties: {
        demoId: { type: "string" },
        confirmed: { type: "boolean" },
      },
    },
    handler: async (args) => {
      const id = String(args.demoId);
      if (!args.confirmed) {
        return confirmationRequired("delete_demo", { demoId: id }, `即将删除 Demo ${id}，此操作不可撤销。`);
      }
      await apiRequest(`/api/demos/${encodeURIComponent(id)}`, { method: "DELETE" });
      return toolResult({ ok: true, deletedDemoId: id });
    },
  },

  {
    name: "list_demo_files",
    description: "列出 Demo 的所有源文件（files/ 目录下）。返回 [{path, size, updatedAt}]。",
    inputSchema: {
      type: "object",
      required: ["demoId"],
      properties: { demoId: { type: "string" } },
    },
    handler: async (args) => {
      const data = await apiRequest<any>(
        `/api/demos/${encodeURIComponent(String(args.demoId))}/files`,
      );
      return toolResult(data);
    },
  },

  {
    name: "read_demo_file",
    description: "读取 Demo 单个源文件内容。path 是相对于 files/ 的路径，如 'index.html' / 'app.tsx'。",
    inputSchema: {
      type: "object",
      required: ["demoId", "path"],
      properties: {
        demoId: { type: "string" },
        path: { type: "string" },
      },
    },
    handler: async (args) => {
      const data = await apiRequest<any>(
        `/api/demos/${encodeURIComponent(String(args.demoId))}/file?path=${encodeURIComponent(String(args.path))}`,
      );
      return toolResult(data);
    },
  },

  {
    name: "write_demo_file",
    description:
      "创建或覆盖 Demo 的源文件。path 是相对于 files/ 的路径（不可含 .. / 不可以 / 开头）。" +
      "content 是文件完整内容（UTF-8，≤ 500KB）。" +
      "每次调用都 bump demo.version。",
    inputSchema: {
      type: "object",
      required: ["demoId", "path", "content"],
      properties: {
        demoId: { type: "string" },
        path: { type: "string", description: "如 'index.html' / 'app.tsx' / 'style.css' / 'public/logo.svg'" },
        content: { type: "string" },
      },
    },
    handler: async (args) => {
      const data = await apiRequest<any>(
        `/api/demos/${encodeURIComponent(String(args.demoId))}/file`,
        { method: "PUT", body: { path: args.path, content: args.content } },
      );
      return toolResult(data);
    },
  },

  {
    name: "delete_demo_file",
    description: "⚠️ 删除 Demo 的单个源文件。不删目录。",
    danger: true,
    inputSchema: {
      type: "object",
      required: ["demoId", "path"],
      properties: {
        demoId: { type: "string" },
        path: { type: "string" },
        confirmed: { type: "boolean" },
      },
    },
    handler: async (args) => {
      const id = String(args.demoId);
      const p = String(args.path);
      if (!args.confirmed) {
        return confirmationRequired(
          "delete_demo_file",
          { demoId: id, path: p },
          `即将删除 ${id} 的文件 ${p}。`,
        );
      }
      await apiRequest(`/api/demos/${encodeURIComponent(id)}/file`, {
        method: "DELETE",
        body: { path: p },
      });
      return toolResult({ ok: true });
    },
  },

  {
    name: "update_demo_capabilities",
    description:
      "声明 Demo 需要访问哪些 Table / Idea 及其能力。决定 window.ImageBase SDK 里暴露哪些方法。" +
      "dataTables: tableId 数组；dataIdeas: ideaId 数组；capabilities: " +
      "{resourceId: [\"query\" / \"getRecord\" / \"describeTable\" / \"createRecord\" / \"updateRecord\" / \"deleteRecord\" / \"listIdeas\" / \"readIdea\"]}。" +
      "读类（query / getRecord / describeTable / listIdeas / readIdea）会自动开，写类必须显式加。",
    inputSchema: {
      type: "object",
      required: ["demoId"],
      properties: {
        demoId: { type: "string" },
        dataTables: { type: "array", items: { type: "string" } },
        dataIdeas: { type: "array", items: { type: "string" } },
        capabilities: { type: "object", description: "{resourceId: Capability[]}" },
      },
    },
    handler: async (args) => {
      const data = await apiRequest<any>(
        `/api/demos/${encodeURIComponent(String(args.demoId))}/capabilities`,
        {
          method: "PUT",
          body: {
            dataTables: args.dataTables || [],
            dataIdeas: args.dataIdeas || [],
            capabilities: args.capabilities || {},
          },
        },
      );
      return toolResult(data);
    },
  },

  {
    name: "build_demo",
    description:
      "编译 Demo 的源码 → dist/（对 react-spa 跑 esbuild；对 static 直接 copy + bundle JS）。" +
      "构建时间一般 < 3s。失败时返回 error + logTail。" +
      "Agent 按 promptFragment 规则最多自动 retry 2 次。",
    inputSchema: {
      type: "object",
      required: ["demoId"],
      properties: { demoId: { type: "string" } },
    },
    handler: async (args) => {
      const data = await apiRequest<any>(
        `/api/demos/${encodeURIComponent(String(args.demoId))}/build`,
        { method: "POST", body: {} },
      );
      return toolResult(data);
    },
  },

  {
    name: "screenshot_demo",
    description:
      "对已构建的 Demo 页面 headless Chromium 截图，**以 image 形式**回传给你（vision），" +
      "用于 1:1 视觉对比：把你刚写的 Demo 和原设计稿（view_taste_image）放在一起肉眼 diff，" +
      "发现布局偏差 / 颜色差 / 组件缺失 → 改代码 → rebuild → 再截图，直到视觉收敛。" +
      "要求 lastBuildStatus=success；宿主机需装 Chrome/Chromium（未装返回 BROWSER_UNAVAILABLE）。" +
      "默认 1440×900 + fullPage；常用调整：mobile 用 width=390 height=844。",
    inputSchema: {
      type: "object",
      required: ["demoId"],
      properties: {
        demoId: { type: "string" },
        width: { type: "number", description: "viewport 宽，默认 1440" },
        height: { type: "number", description: "viewport 高，默认 900" },
        fullPage: { type: "boolean", description: "是否截整个滚动页（默认 true）" },
      },
    },
    handler: async (args) => {
      try {
        const data = await apiRequest<{
          mediaType: string;
          base64: string;
          meta: { viewport: { width: number; height: number }; capturedWidth: number; capturedHeight: number; durationMs: number };
        }>(
          `/api/demos/${encodeURIComponent(String(args.demoId))}/screenshot`,
          {
            method: "POST",
            body: {
              width: args.width,
              height: args.height,
              fullPage: args.fullPage,
            },
          },
        );
        // Pack into IBASE_IMAGE marker so the adapter expands it into an
        // Anthropic image block. Caption tells Claude what it's looking at.
        const IBASE_IMAGE_MARKER = "__IBASE_IMAGE_v1__";
        return IBASE_IMAGE_MARKER + JSON.stringify({
          mediaType: data.mediaType,
          base64: data.base64,
          caption:
            `Demo ${args.demoId} preview @ ${data.meta.viewport.width}×${data.meta.viewport.height}` +
            ` (captured ${data.meta.capturedWidth}×${data.meta.capturedHeight}, ${data.meta.durationMs}ms)`,
          text:
            `This is what your Demo currently renders. Compare side-by-side with the ` +
            `original design (view_taste_image). Call out pixel/layout/color differences ` +
            `and edit the source to close them; then build + screenshot again to verify.`,
        });
      } catch (err: any) {
        return toolResult({
          error: err?.message || String(err),
          hint:
            "If BROWSER_UNAVAILABLE: ask the user to install google-chrome on the host; " +
            "meanwhile, approximate the design by reading view_taste_image + analyze_taste output.",
        });
      }
    },
  },

  {
    name: "publish_demo",
    description:
      "⚠️ 将当前 dist/ 快照发布为公开 URL（/share/:slug）。**需要先 build_demo 成功**。" +
      "发布后任何人（无需登录）访问 URL 都能使用 Demo，包括调用 SDK 的所有声明过的能力。" +
      "首次发布生成新 slug；后续 re-publish 保留 slug 但 publishedVersion++。",
    danger: true,
    inputSchema: {
      type: "object",
      required: ["demoId"],
      properties: {
        demoId: { type: "string" },
      },
    },
    handler: async (args) => {
      const id = String(args.demoId);
      const data = await apiRequest<any>(
        `/api/demos/${encodeURIComponent(id)}/publish`,
        { method: "POST", body: {} },
      );
      return toolResult(data);
    },
  },

  {
    name: "unpublish_demo",
    description:
      "取消发布 Demo。/share/:slug 立即 404；published/ 目录保留以便 re-publish 恢复。" +
      "重新 publish 会生成**新 slug**（旧 slug 永久失效）。",
    inputSchema: {
      type: "object",
      required: ["demoId"],
      properties: { demoId: { type: "string" } },
    },
    handler: async (args) => {
      await apiRequest(
        `/api/demos/${encodeURIComponent(String(args.demoId))}/unpublish`,
        { method: "POST", body: {} },
      );
      return toolResult({ ok: true });
    },
  },

  // ─── SVG → Demo (Path A) ───────────────────────────────────────────────
  // Same backend pipeline as the UI right-click "Make interactive" (Path B);
  // both endpoints converge on createDemoFromSvg. See
  // docs/svg-to-demo-plan.md.
  //
  // The Agent invokes this when the user says "把这个 taste 做成 demo" /
  // "convert this design to a runnable demo" without explicit "100% 还原"
  // wording. For pixel-perfect requests the Agent should switch to the
  // svg_to_demo_faithful workflow (Phase 2 — not yet shipped).
  {
    name: "create_demo_from_taste",
    description:
      "把一个 Taste 的 SVG 通过服务端确定性转换变成可运行的 Demo（Path A）。" +
      "简单 UI / Auto Layout 设计稿 95%+ 还原；复杂插画里的曲线 / mask 会保留为 inline SVG island。" +
      "返回 { demoId, droppedFeatures, manifestSummary, hint }。" +
      "之后通常调 write_demo_file 加交互 → build_demo → 用户预览。" +
      "如果用户明确要求像素级还原，改用 svg_to_demo_faithful workflow（Phase 2）。",
    inputSchema: {
      type: "object",
      required: ["tasteId"],
      properties: {
        tasteId: {
          type: "string",
          description: "源 Taste id。Agent 通常先从 list_tastes / get_taste 拿到。",
        },
        name: {
          type: "string",
          description: "Demo 名称（可选）。默认 '<taste 名> Demo'。",
        },
      },
    },
    handler: async (args) => {
      const tasteId = String(args.tasteId);
      const body: Record<string, string> = {};
      if (typeof args.name === "string" && args.name.trim()) body.name = args.name;
      const data = await apiRequest<{
        demoId: string;
        filesWritten: string[];
        manifest: Array<{ htmlId: string; type: string; figmaName?: string }>;
        droppedFeatures: string[];
        stats: {
          htmlBytes: number;
          cssBytes: number;
          elements: number;
          islands: number;
          cssVars: number;
        };
      }>(`/api/svg-to-demo/from-taste/${encodeURIComponent(tasteId)}`, {
        method: "POST",
        body: Object.keys(body).length > 0 ? body : ({} as any),
      });
      // Compact the manifest so token cost on the Agent's next turn stays
      // low. Full manifest is in `~/.imagebase/demos/<id>/files/manifest.json`
      // — Agent can `read_demo_file('manifest.json')` for details.
      const manifestSummary = summarizeManifest(data.manifest);
      const hint =
        data.droppedFeatures.length > 0
          ? "部分元素保留为内嵌 SVG（详见 droppedFeatures）。如需 100% 视觉还原，可改用 svg_to_demo_faithful workflow。"
          : null;
      return toolResult({
        demoId: data.demoId,
        filesWritten: data.filesWritten,
        droppedFeatures: data.droppedFeatures,
        manifestSummary,
        stats: data.stats,
        hint,
      });
    },
  },
];

/** Group manifest entries by type for compact display in the Agent's
 *  conversation: "12 rect, 8 text, 1 image, 3 island" instead of
 *  dumping 30+ rows. The full manifest is on disk at
 *  files/manifest.json — the Agent can read it on demand. */
function summarizeManifest(manifest: Array<{ type: string; figmaName?: string }>): {
  byType: Record<string, number>;
  named: string[];
} {
  const byType: Record<string, number> = {};
  const named: string[] = [];
  for (const m of manifest) {
    byType[m.type] = (byType[m.type] ?? 0) + 1;
    if (m.figmaName && named.length < 12) named.push(m.figmaName);
  }
  return { byType, named };
}

// Append the faithful-conversion (Path C) tool to the export. We keep it
// in this file rather than a separate module because it shares the
// "tasteId → Demo" semantic with create_demo_from_taste; conceptually
// they're the same operation at different fidelity levels.
demoWriteTools.push({
  name: "convert_taste_to_demo_faithful",
  description:
    "把一个 Taste 的 SVG 通过 **LLM-driven 高保真转换** 变成 Demo（Path C）。" +
    "比 create_demo_from_taste 更慢（30-90s）但视觉差异 < 2%。" +
    "适用于:像素级还原 / 复杂插画 / 用户明确说\"和原图一模一样\"的场景。" +
    "" +
    "工作流程: 先跑 Path A 的确定性基线 → 切分 SVG 为多个 chunk → 对每个 chunk 与原图做" +
    "像素 diff → 超阈值的 chunk 用 LLM 重生成 HTML/CSS → 拼接 → 重新 build。" +
    "" +
    "返回 { demoId, finalDiffRatio, refinedChunks, totalChunks, warnings, durationMs }。" +
    "如果服务端没装无头浏览器,会自动降级为 Path A 的纯确定性输出 + warning。",
  inputSchema: {
    type: "object",
    required: ["tasteId"],
    properties: {
      tasteId: { type: "string", description: "源 Taste id" },
      name: { type: "string", description: "Demo 名称（可选）。默认 '<taste 名> Demo (faithful)'" },
      refineThreshold: {
        type: "number",
        description: "chunk 像素 diff 比例超此值就触发 LLM 重生成。默认 0.05 (5%)。",
      },
      retryThreshold: {
        type: "number",
        description: "重生成后再 diff 仍超此值就再 retry 一次。默认 0.05。",
      },
      concurrency: {
        type: "number",
        description: "并发 LLM 调用数。默认 4,上限 8。",
      },
    },
  },
  handler: async (args, ctx) => {
    const tasteId = String(args.tasteId);
    const body: Record<string, any> = {};
    if (typeof args.name === "string" && args.name.trim()) body.name = args.name;
    if (typeof args.refineThreshold === "number") body.refineThreshold = args.refineThreshold;
    if (typeof args.retryThreshold === "number") body.retryThreshold = args.retryThreshold;
    if (typeof args.concurrency === "number") body.concurrency = args.concurrency;
    // Long-task: this can take 60+ seconds for the LLM-refinement path.
    // The MCP HTTP call to /faithful is opaque (no streaming progress yet),
    // so we drive the LongTaskTracker from this side: emit one progress
    // event up front, then a recurring heartbeat every 8s. LongTaskTracker
    // resets its 15s silence timer on every progress() call, so this keeps
    // the SSE warm and avoids the 180s no-progress timeout. We clear the
    // interval in finally regardless of success/failure.
    ctx?.progress?.({
      phase: "starting",
      message: `Path C 高保真转换 ${tasteId}`,
    });
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      ctx?.progress?.({
        phase: "running",
        message: `Path C 转换进行中 (${elapsedSec}s)…`,
      });
    }, 8000);
    // Don't keep the event loop alive on shutdown.
    if (typeof (heartbeat as any).unref === "function") (heartbeat as any).unref();
    let data: {
      ok: boolean;
      demoId: string;
      finalDiffRatio: number;
      refinedChunks: number;
      totalChunks: number;
      chunkFailures: Record<string, string>;
      warnings: string[];
      durationMs: number;
    };
    try {
      data = await apiRequest<{
        ok: boolean;
        demoId: string;
        finalDiffRatio: number;
        refinedChunks: number;
        totalChunks: number;
        chunkFailures: Record<string, string>;
        warnings: string[];
        durationMs: number;
      }>(`/api/svg-to-demo/from-taste/${encodeURIComponent(tasteId)}/faithful`, {
        method: "POST",
        body: Object.keys(body).length > 0 ? body : ({} as any),
      });
    } finally {
      clearInterval(heartbeat);
    }
    return toolResult({
      demoId: data.demoId,
      finalDiffPct: (data.finalDiffRatio * 100).toFixed(2) + "%",
      refinedChunks: data.refinedChunks,
      totalChunks: data.totalChunks,
      warnings: data.warnings,
      durationSec: (data.durationMs / 1000).toFixed(1),
      hint:
        data.finalDiffRatio < 0
          ? "服务端无头浏览器不可用，已降级为 Path A 输出（无 LLM 精修）。"
          : data.finalDiffRatio < 0.02
          ? "✓ 视觉吻合度 ≥ 98%，与原图一致"
          : data.finalDiffRatio < 0.05
          ? "视觉吻合度 ≥ 95%，可接受范围"
          : "局部仍有偏差，可能需要手工精修或再轮 refine",
    });
  },
});
