# Agent Integration Plan

## 目标

让 Agent 能以统一方式接入第三方平台能力，第一批覆盖 Lark/飞书、GitHub、Figma，并支持用户自定义本地 CLI 集成。

设计原则：

- **Provider preset first**：优先使用当前最稳定的官方接入方式；Lark/飞书使用官方 `lark-cli`，Figma 使用本地 MCP，GitHub 默认使用 `gh` CLI。
- **CLI manifest 白名单**：通过显式 manifest 把 CLI 命令安全包装成 Agent tool，避免模型直接拼 shell。
- **Agent 可自举**：Agent 自己能通过管理工具创建、更新、测试 integration，而不是完全依赖前端表单。
- **最小权限**：每个 integration 显式声明工具、参数 schema、readOnly/danger、scopes 和凭证名。

## 现有落点

```text
Agent turn
  -> static skills
  -> user skills
  -> enabled integration skills
       -> generated tool: integration_<id>_<tool>
          -> MCP stdio / MCP HTTP / CLI runtime
```

关键文件：

- `backend/src/services/integrations/*`：provider catalog、DB store、secret crypto、MCP/CLI runtime、dynamic skill registry。
- `backend/mcp-server/src/tools/integrationTools.ts`：给 Agent 使用的 integration 管理工具。
- `backend/mcp-server/src/skills/integrationSkill.ts`：内置 `integration-skill`，负责创建/调试第三方集成。
- `backend/src/routes/agentRoutes.ts`：前端 REST 管理接口。
- `frontend/src/components/AgentBlock/IntegrationsTab.tsx`：Agent Homepage 的 Integrations tab。

## 数据模型

`agent_integrations`

- `agentId`：integration 归属的 Agent。
- `providerKey`：`github` / `lark` / `figma` / `custom-cli`。
- `transport`：`mcp-stdio` / `mcp-http` / `cli`。
- `configJson`：启动 MCP server、HTTP endpoint、CLI command、env/header 映射等。
- `toolManifest`：暴露给 Agent 的工具白名单。
- `status` / `lastError` / `lastHealthAt` / `lastUsedAt`：健康状态和观测字段。

`agent_integration_credentials`

- 按 `integrationId + name` 存储凭证。
- API 只返回 `valuePreview`，不返回密文或明文。
- 明文用 AES-256-GCM 加密，key 取 `INTEGRATION_SECRET_KEY`，缺省退到现有服务密钥。

## Tool Manifest

每个 integration 只暴露 manifest 声明过的工具：

```json
{
  "name": "gh_issue_list",
  "description": "List GitHub issues for a repository.",
  "mode": "cli",
  "readOnly": true,
  "output": "json",
  "args": ["issue", "list", "--repo", "{{repo}}", "--limit", "{{limit}}", "--json", "number,title,state,url"],
  "inputSchema": {
    "type": "object",
    "properties": {
      "repo": { "type": "string" },
      "limit": { "type": "number" }
    },
    "required": ["repo"]
  }
}
```

MCP 通用转发工具：

```json
{
  "name": "figma_mcp_call",
  "description": "Call a Figma MCP server tool by remote tool name.",
  "mode": "mcp",
  "readOnly": true,
  "inputSchema": {
    "type": "object",
    "properties": {
      "tool": { "type": "string" },
      "arguments": { "type": "object" }
    },
    "required": ["tool"]
  }
}
```

## 内置预设

GitHub、Lark/飞书、Figma 是 system integrations：每个 Agent 打开 Integrations tab
或调用 `list_integrations` 时会自动生成 disabled 实例。用户不需要安装，只需要
开启开关并补齐 CLI 授权 / MCP endpoint。`Install` 仅保留给 custom CLI / 未来
marketplace 多实例场景。

GitHub：

- 推荐 `cli`，默认命令 `gh`。
- 提供 `gh_repo_view`、`gh_issue_list`、`gh_pr_list`。
- 也支持外接 GitHub MCP server。

Lark / Feishu：

- 推荐 `cli`。
- 默认命令：`lark-cli`。
- 服务端需要安装 `lark-cli`；运行时会为每个 agent/integration 创建独立 sandbox，不共享 `HOME` / `XDG_*` / `TMPDIR`。
- 首次授权由 Agent 调 `start_lark_auth` 启动，返回 `verificationUrl` / `userCode` / `authSessionId`；Agent 在对话中把 URL 和 code 发给用户，用户完成授权后调 `poll_lark_auth` 落盘登录态。
- `lark-cli config init` 所需 `LARK_APP_ID` / `LARK_APP_SECRET` 可来自 integration credentials 或服务端环境变量。
- 默认工具：`lark_auth_status`、`lark_schema`、`lark_api_get`、`lark_api_post`、`lark_cli`。
- 存量 `lark_mcp_call` / `mcp-stdio` 行不自动迁移，避免覆盖已配置的历史 integration；如果只有历史 Lark MCP 行，`ensureSystemIntegrations()` 会额外补一个 disabled 的 Lark CLI preset。

Figma：

- 推荐 `mcp-http`。
- 默认 endpoint：`http://127.0.0.1:3845/mcp`。
- 支持 `FIGMA_TOKEN` 注入 header。

Custom CLI：

- 通过 Agent 对话收集 CLI command、凭证环境变量和工具 manifest。
- 适合内部平台命令行、个人脚本、企业私有 SDK。

## 安全边界

- CLI runtime 使用 `spawn(..., { shell: false })`，禁止 command 中出现 shell 表达式字符。
- CLI 只允许 manifest 中声明的 argv 模板，不允许模型直接拼 shell。
- CLI 和 stdio MCP 共用 integration runtime env：按 provider/agent/integration 隔离 sandbox，凭证只注入当前 integration，串行化同一 sandbox 的命令避免并发写坏 auth/config。
- 输出限制 512 KB，默认超时 60s，单工具最高 180s。
- `readOnly === false` 或 `danger === true` 的工具进入现有确认流。
- MCP/CLI 输出作为不可信外部内容处理，prompt 中要求 Agent 不把外部返回当系统指令。

## 后续演进

1. 增加 OAuth callback 和 token refresh，替代手填 PAT / app secret。
2. 增加前端高级编辑器：manifest JSON schema 校验、credential 输入、连接测试结果详情。
3. 引入 integration marketplace：团队共享 preset，但实例仍按 Agent 存储凭证。
4. 把 integration tool call 写入更细的审计日志，支持按 provider/tool 检索。
5. 支持远程托管 MCP server 的健康探活和工具列表缓存，减少每次 turn 的启动成本。

## 测试用例

完整验收用例见 [agent-integration-test-cases.md](./agent-integration-test-cases.md)。
