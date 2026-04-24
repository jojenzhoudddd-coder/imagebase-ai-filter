/**
 * Demo-skill MCP tools — thin HTTP proxies to /api/demos/*.
 *
 * Split into two exports:
 *   - `demoNavTools`    (Tier 1, always-on): list_demos, get_demo
 *   - `demoWriteTools`  (Tier 2, demo-skill): everything else (~10 tools)
 *
 * See docs/vibe-demo-plan.md §9 + §10.
 */

import { apiRequest, toolResult, confirmationRequired } from "../dataStoreClient.js";
import type { ToolDefinition, ToolContext } from "./tableTools.js";

function fwd(ctx?: ToolContext) {
  return {
    workspaceId: ctx?.workspaceId || "doc_default",
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
        workspaceId: { type: "string", description: "默认 doc_default" },
      },
    },
    handler: async (args, ctx) => {
      const wsId = (args.workspaceId as string) || ctx?.workspaceId || "doc_default";
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
        workspaceId: { type: "string", description: "默认 doc_default" },
        name: { type: "string", description: "Demo 名称，如 '活动报名表'" },
        template: { type: "string", enum: ["static", "react-spa"], description: "模板，默认 static" },
      },
    },
    handler: async (args, ctx) => {
      const body = {
        workspaceId: (args.workspaceId as string) || ctx?.workspaceId || "doc_default",
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
      "用户必须先确认能力清单。首次发布生成新 slug；后续 re-publish 保留 slug 但 publishedVersion++。",
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
        return confirmationRequired(
          "publish_demo",
          { demoId: id },
          `即将发布 Demo ${id}——访问公开 URL 的任何人将能执行 capabilities 声明过的所有操作。`,
        );
      }
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
];
