/**
 * demo-skill — Tier 2 bundle for Vibe Demo generation / build / publish.
 *
 * Shared toolset for both vibe-design-skill and vibe-coding-skill; those
 * two skills only contribute additional promptFragments (no new tools).
 *
 * See docs/vibe-demo-plan.md §10.1.
 */

import { demoWriteTools } from "../tools/demoTools.js";
import type { SkillDefinition } from "./types.js";

export const DEMO_SKILL_PROMPT = `## Demo 基本流程

1. \`create_demo(workspaceId, name, template)\` — template 选 "static"（Vibe design / 纯落地页）或 "react-spa"（Vibe coding / CRUD 类）
2. \`write_demo_file(demoId, path, content)\` 一个或多个
   - 推荐结构：index.html, app.tsx（react-spa）, style.css
   - react-spa 模板 scaffold 时已经给了 index.html + app.tsx + importmap，直接改 app.tsx
3. 如果要读写 Table 或读 Idea → \`update_demo_capabilities(demoId, dataTables, dataIdeas, capabilities)\`
   - dataTables 声明用到的 tableId
   - dataIdeas 声明用到的 ideaId（只读）
   - capabilities 是每个 resourceId 的能力白名单
   - 读类（query / getRecord / describeTable / readIdea / listIdeas）默认自动开
   - 写类（createRecord / updateRecord / deleteRecord）必须显式加
4. \`build_demo(demoId)\` — esbuild 打包
   - 失败时读 logTail 里的 error，自己修，**最多 retry 2 次**；第 3 次仍失败停下来问用户
5. Demo 可在 /workspace/:workspaceId/demo/:demoId 预览
6. 用户满意后：\`publish_demo(demoId)\` 生成公开 URL /share/:slug

## window.ImageBase SDK（Demo 代码里用）

注入为 window.ImageBase。根据 capabilities 动态生成——你**没声明的方法在 SDK 上不存在**。

\`\`\`typescript
interface ImageBase {
  demoId: string;
  dataTables: string[];
  dataIdeas: string[];
  capabilities: Record<string, string[]>;

  // Table 读（默认总是开）
  query(tableId, options?: {filter?, sort?, limit?}): Promise<Record[]>;
  getRecord(tableId, recordId): Promise<Record>;
  describeTable(tableId): Promise<{id, name, fields, views, recordCount}>;

  // Table 写（capabilities 里声明才出现）
  createRecord(tableId, cells): Promise<Record>;
  updateRecord(tableId, recordId, cells): Promise<Record>;
  deleteRecord(tableId, recordId): Promise<void>;
  batchCreate/batchUpdate/batchDelete: 批量变体

  // Idea 读（capabilities 里声明才出现）
  listIdeas(): Promise<{id, name, updatedAt}[]>;
  readIdea(ideaId): Promise<{id, name, content, sections, version, updatedAt}>;
}
\`\`\`

## 硬规则

- 生成 Demo 前调 get_data_dictionary / describe_table / readIdea 了解字段和内容
- 代码里所有 SDK 调用必须 try/catch
- **不要** 试图在 Demo 里 fetch \`/api/tables/...\` 或其他系统 API——只能通过 window.ImageBase
- **不要** 使用 Node.js-only 模块（fs / path / process / require），代码跑在浏览器
- 规模引导：单文件 < 800 行，总文件 < 10 个。超了拆分或告诉用户需要拆；不是硬限制，真要超就超
- Build 失败 retry 规则：最多自动 retry 2 次；第 3 次失败问用户
- Publish 是 danger 工具，会走二次确认

## 模板细节

### static
- 入口 files/index.html，自由引用 files/ 下其他文件
- 适合：纯展示页、落地页、海报、静态 dashboard

### react-spa
- 入口 files/app.tsx，esbuild 打包成 dist/bundle.js
- index.html scaffold 已带：importmap 指向 esm.sh 的 React 18 + ReactDOM，Tailwind CDN
- React & ReactDOM 从 CDN 加载（每个 Demo 不单独 bundle React）
- 写 TSX：\`import React from "react"; import { createRoot } from "react-dom/client";\`
- 渲染：\`createRoot(document.getElementById("root")!).render(<App />);\`

## 状态提示

你的工具调用会触发 tool_progress 事件（"preparing" / "bundling" / "injecting" / "finalizing"），
用户在 chat 里会看到一个 CodingFlowCard 显示当前步骤。不需要你额外汇报进度。
`;

export const demoSkill: SkillDefinition = {
  name: "demo-skill",
  displayName: "Demo 代码生成 & 部署",
  description:
    "生成可运行的前端 Demo（HTML/React SPA），编译、预览、发布到公开 URL；" +
    "通过 ImageBase SDK 读写 workspace 内声明的 Table 数据和读 Idea 内容。",
  artifacts: ["demo"],
  softDeps: ["table-skill", "analyst-skill"],
  when:
    "当用户请求「做一个网页 / 页面 / 落地页 / dashboard / 小工具 / Demo / 原型」；" +
    "或要求把数据表做成可交互的 UI / 表单；或说 vibe design / vibe coding 时激活。",
  triggers: [
    /(vibe|demo|原型|prototype)/i,
    /(做个|写一个|做一个|生成|搭一个|搭个).*(网页|页面|落地页|表单|dashboard|看板|app|小工具|前端|系统|平台|管理)/i,
    /(前端|HTML|CSS|JS|React|组件|UI).*(生成|写|做)/i,
    /(发布|部署|publish|deploy).*(demo|页面|原型|链接)/i,
    // functional intent (will also trigger vibe-coding-skill)
    /\b(CRM|ERP|OA|CRUD)\b/i,
    /(表单|submit|提交|增删改查|登录|注册|查询)/,
    // design intent (will also trigger vibe-design-skill)
    /(漂亮|好看|视觉|美观|设计感|有质感|惊艳|高级感|精致)/,
    /(落地页|hero|banner|海报|封面|mockup|展示页|推广页)/i,
  ],
  tools: demoWriteTools,
  promptFragment: DEMO_SKILL_PROMPT,
};
