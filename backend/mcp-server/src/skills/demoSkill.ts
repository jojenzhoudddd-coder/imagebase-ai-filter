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

## 数据形态契约（写代码前必读——跳过这节代码几乎必坏）

### Record 的真实形状

\`query\` / \`getRecord\` / \`createRecord\` / \`updateRecord\` 都返回同一个 shape：

\`\`\`json
{
  "id": "rec_xxx",
  "tableId": "tbl_yyy",
  "cells": {
    "fld_name": "登录页重构",
    "fld_assignee": "u_alice",
    "fld_priority": "P0",
    "fld_tags": ["opt_fe", "opt_urgent"],
    "fld_date": "2026-04-20"
  }
}
\`\`\`

**访问值只能 \`record.cells[fieldId]\`**。不存在 \`record.fields\`、\`record.values\`、\`record[fieldId]\`——你自己猜的这些 shape 都会返回 undefined，页面显示空白。

### cells 写入形状

\`createRecord(tableId, cells)\` / \`updateRecord(tableId, recordId, cells)\` 的 \`cells\` 是**扁平的 \`{fieldId: value}\` map**。key 必须是字段 id（\`fld_xxx\`），不是字段名（"优先级"）。**不要**外包 \`{fields: {...}}\`（那是 Airtable 的 API，不是这里）。

### describeTable 返回的字段元数据

\`\`\`json
{
  "id": "tbl_yyy",
  "fields": [
    { "id": "fld_priority", "name": "优先级", "type": "SingleSelect",
      "config": { "options": [{"id":"opt_p0","name":"P0","color":"#002270"}, ...] } },
    { "id": "fld_assignee", "name": "负责人", "type": "User",
      "config": { "users": [{"id":"u_alice","name":"Alice","avatar":"..."}] } }
  ]
}
\`\`\`

## 渲染 ID 类字段（硬规则）

**SingleSelect / MultiSelect / User / Group 字段的 cell 存的是 ID，不是显示名**。直接 \`<td>{record.cells[fid]}</td>\` 用户看到的就是 \`u_alice\` / \`opt_p0\`——这是用户最常抱怨"完成度低"的根源。

必须：

1. 组件 mount 时 \`describeTable(tableId)\` 一次
2. 为每个 ID 类字段建 label map：\`{[id]: name, [name]: name}\`（双键——系统里有些 cell 存 id 有些存 name，双键让两种都命中）
3. 渲染时 \`labelMap[fid]?.[cell] ?? cell\`——查不到才 fallback 到原值

\`\`\`tsx
const labelMaps = useMemo(() => {
  if (!schema) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const f of schema.fields ?? []) {
    if (f.type === "SingleSelect" || f.type === "MultiSelect") {
      const m: Record<string, string> = {};
      for (const o of f.config?.options ?? []) { m[o.id] = o.name; m[o.name] = o.name; }
      out[f.id] = m;
    } else if (f.type === "User" || f.type === "Group") {
      const m: Record<string, string> = {};
      for (const u of f.config?.users ?? []) m[u.id] = u.name;
      out[f.id] = m;
    }
  }
  return out;
}, [schema]);

const label = (fid: string, v: any) => {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(x => labelMaps[fid]?.[x] ?? x).join(", ");
  return labelMaps[fid]?.[v] ?? v;
};
// render：{label("fld_priority", r.cells.fld_priority)}
\`\`\`

## 预构建 preflight（按顺序，不能跳）

1. \`get_data_dictionary\` 或 \`describeTable\` 每个要用的 tableId
2. \`update_demo_capabilities\`——dataTables 声明 + per-resource 写类能力（\`createRecord\` / \`updateRecord\` / \`deleteRecord\`）显式加
3. \`write_demo_file\` 写代码（遵守上面的数据契约 + ID→label 规则）
4. \`build_demo\`
5. **构建后自检（下一节，不做不算交付）**

## 构建后自检（不跑完不宣告完成）

\`build_demo\` 返回 \`success\` **只代表 esbuild 没报错**，不代表 Demo 能跑。必须自检：

1. Preview URL 可通过 chat Demo Card 或 \`/workspace/:wsId/demo/:demoId\` 打开
2. SDK 已内置运行时错误拦截——iframe 里如果出现 id 为 \`__imagebase_err__\` 的红底覆盖层，说明代码抛了未捕获错误（含"mounted but empty"兜底）
3. 功能 smoke：至少在心里 walk through 一次读（数据能出）+ 一次写（如果声明了写 capability），看代码路径是不是闭环
4. 若发现错误：
   - \`Cannot read properties of undefined (reading '某字段')\` → 多半是 \`record.cells\` 没用上（见"数据形态契约"节）
   - 页面显示 \`u_xxx\` / \`opt_xxx\` 这种 ID → 没建 label map（见"渲染 ID 类字段"节）
   - \`window.ImageBase.createRecord is not a function\` → capability 漏声明
   - 读取返回空 → tableId 拼错或 capability 没声明
5. 定位 → 改代码 → 重新 build → 重新自检。**自检 retry 上限 3 次**，仍失败停下告诉用户具体报错
6. 全通过才可以说 "Demo 完成了"

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
