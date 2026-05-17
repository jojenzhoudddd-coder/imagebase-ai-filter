# Agent Integration 测试用例

## 范围

覆盖 Agent Integration 的完整链路：

- System integrations：GitHub、Lark、Figma 自动出现、配置、启用、测试连接、调用工具。
- Custom CLI：通过 chat 创建、配置凭证、测试、启用、删除。
- Runtime：MCP stdio、MCP HTTP、CLI 三种 transport。
- 安全：凭证脱敏、CLI shell 注入防护、danger confirmation。
- 联动：ChatSidebar、Skills、Models、Habits、Acknowledge、Activities、Agent Home 刷新。

## 环境

- 本地前端：`http://127.0.0.1:5174`
- 本地后端：`http://127.0.0.1:3002`
- 测试账号：使用本地测试账号登录。
- 默认进入 Agent Home 的 `Integrations` tab。
- GitHub/Lark/Figma 可使用真实凭证或 stub MCP/CLI；Lark 使用官方 `lark-cli`；涉及外部写操作的用例必须使用测试空间、测试仓库、测试 Figma 文件。

## P0 用例

| ID | 用例 | 前置条件 | 步骤 | 预期结果 |
|----|------|----------|------|----------|
| AI-INT-P0-01 | System integrations 自动出现 | 已登录，当前 agent 无手动创建 integration | 打开 Agent Home → Integrations tab | 列表自动出现 GitHub、Lark、Figma 三张卡；卡片带 `Official` 标签；默认关闭；关闭态不展示 `Needs config / Healthy / Error` |
| AI-INT-P0-02 | System integration 开启但未配置 | GitHub 卡未配置凭证 | 打开 GitHub 开关 | 开关变为开启；卡片展示 `Needs config`；不出现 Install 概念；无额外 custom card 被创建 |
| AI-INT-P0-03 | Configure by chat 引导配置 | GitHub 卡存在 | 点击 GitHub 卡 `Configure by chat` | 打开 Chat block，输入框预填包含 integrationId、provider、displayName、transport 的配置提示；不会在提示中要求用户安装 system integration |
| AI-INT-P0-04 | GitHub CLI 连接测试成功 | 本机安装 `gh`，测试账号已登录 gh 或配置 token；GitHub integration 已补齐 read-only manifest | 点击 `Test connection` | Toast 显示健康；开启态卡片显示 `Healthy`；后端 `lastHealthAt` 更新；凭证只显示 preview，不显示完整 token |
| AI-INT-P0-05 | GitHub CLI 连接测试失败 | GitHub integration 使用错误命令或错误 token | 点击 `Test connection` | Toast 显示测试失败；开启态卡片显示 `Error`；卡片描述显示错误摘要；不会泄露完整 secret |
| AI-INT-P0-06 | Lark CLI 授权成功 | 服务端已安装 `lark-cli`，并通过 integration credentials 或服务端环境提供 `LARK_APP_ID` / `LARK_APP_SECRET`；使用测试 tenant | 打开 Lark 卡片 → `Test connection` 返回 `needsAuth` → Agent 调 `start_lark_auth` 并把 URL/code 发给用户 → 用户授权后调 `poll_lark_auth` → 再次测试 | 登录态写入该 agent/integration sandbox；后端运行 `lark-cli auth status` 成功；卡片变为 `Healthy`；用户无需 SSH 到服务器 |
| AI-INT-P0-07 | Figma MCP HTTP 配置成功 | 本地 Figma MCP server 在 `127.0.0.1:3845/mcp`；配置 FIGMA_TOKEN | 开启 Figma → 配置 endpoint/token → 点击 `Test connection` | HTTP MCP list tools 成功；卡片变为 `Healthy`；失败时错误展示为摘要 |
| AI-INT-P0-08 | Custom CLI 通过 chat 创建 | 无 custom CLI integration | 点击 `Add by chat`，按对话提供 CLI 名称、command、env 凭证名、read-only tool manifest | 创建成功后 Integrations tab 自动刷新，出现新的 `Custom` card；不再出现单独的 custom CLI preset card；卡片可配置、可测试、可删除 |
| AI-INT-P0-09 | Custom CLI 调用只使用 manifest 白名单 | 已创建 custom CLI，manifest 暴露 `echo_status` | 在 chat 中要求 agent 调用该 custom CLI | 模型只能调用生成的 `integration_<id>_echo_status` 工具；CLI 使用 `spawn(shell:false)`；输出显示在 tool result；integration `lastUsedAt` 更新 |
| AI-INT-P0-10 | CLI shell 注入被拒绝 | Custom CLI command 配成包含 `;`、`&&`、反引号或管道字符 | 保存或测试该 integration | 后端拒绝执行或返回安全错误；不会启动 shell；错误进入测试失败提示 |
| AI-INT-P0-11 | readOnly=false 触发确认流 | Custom CLI manifest 中某个工具 `readOnly:false` 或 `danger:true` | 在 chat 中请求执行该写操作 | Chat 出现确认卡；未确认前工具不执行；点击取消后活动不写入成功记录；点击确认后工具执行 |
| AI-INT-P0-12 | danger confirm 后仍可执行 integration tool | 已有 danger integration tool，确认卡已出现 | 点击确认 | 后端恢复路径能加载 integration skill；工具执行成功或失败都有 tool_result；不出现 `UNKNOWN_TOOL` |
| AI-INT-P0-13 | Integration 调用写入 Activities | 已启用并成功调用某个 integration tool | 在对应 integration card 菜单点击 `View activities` | 切到 Activities tab；搜索框带当前 integration id；列表展示本轮调用记录；记录 `source` 为 `integration:<id>` 或包含该 id |
| AI-INT-P0-14 | danger confirm 调用写入 Activities | 已执行并确认一个 danger integration tool | 在该 integration card 点击 `View activities` | Activities 能看到确认后执行产生的记录；记录有 duration；不会只停留在 awaiting confirmation 的半截消息 |
| AI-INT-P0-15 | Integration 与 Skills 动态激活联动 | Integration 已启用，触发词包含 provider/displayName | 在 chat 中提出明确第三方平台请求，如“查一下 GitHub repo 的 issue” | Agent 自动激活对应 integration skill；可见 tool call；不会要求用户手动 activate skill |
| AI-INT-P0-16 | Integration 不污染 Skills activities | 已调用 integration tool | 在 Skills card 点击 `View activities` | Skill activities 不会因为 `integration-<id>` 动态 skill 名误命中；integration 使用记录应从 Integration card 进入 |
| AI-INT-P0-17 | Model activities 联动仍然可用 | 选择任意模型完成一轮 integration 调用 | 在 Model card 点击 `View activities` | Activities 可按 modelId 查到同一轮 assistant message；同一条记录同时保留 modelId 和 integration source |
| AI-INT-P0-18 | Habits 调用 integration | 创建一个测试 habit，prompt 要求定时读取 GitHub/Lark/Figma 测试数据 | 手动触发或等待 habit 执行 | Habit 执行生成 conversation；assistant message source 至少包含 habit 或 integration 信息；从 Habits 和 Integration 的 View activities 都能定位相关记录 |
| AI-INT-P0-19 | Acknowledge 联动：integration 结果可沉淀知识 | 已配置 read-only integration | 在 chat 中要求“读取第三方信息并保存为 knowledge” | 工具调用成功；Acknowledge tab 自动刷新，新增知识卡；knowledge 内容不包含完整 secret |
| AI-INT-P0-20 | Agent Home 自动刷新 | Integrations tab 已打开，同时打开 Chat block | 在 chat 中创建 custom CLI 或更新 integration 配置并完成对话 | Chat 完成后 Integrations tab 自动 reload；无需切 tab 或刷新页面 |
| AI-INT-P0-21 | Disabled integration 不可被 runtime 调用 | Integration 已存在但关闭 | 在 chat 中要求使用该平台工具 | 不应暴露或调用该 integration tool；如强行调用则后端返回 disabled 错误；Activities 不新增成功调用记录 |
| AI-INT-P0-22 | 删除 custom integration | 已存在 custom integration | 卡片菜单点击 delete | 卡片消失；刷新页面后不再出现；system GitHub/Lark/Figma 不允许删除，只允许关闭 |

## P1 用例

| ID | 用例 | 前置条件 | 步骤 | 预期结果 |
|----|------|----------|------|----------|
| AI-INT-P1-01 | 关闭态 card 视觉不降权 | 任意 integration 关闭 | 观察 card | card 样式不灰掉；仅开关表达开启/关闭；关闭态不展示健康状态标签 |
| AI-INT-P1-02 | Official / Custom 标签展示 | 同时存在 system 和 custom integration | 打开 Integrations tab | GitHub/Lark/Figma 显示 `Official`；用户创建的 CLI 显示 `Custom` |
| AI-INT-P1-03 | Add by chat 与 card grid 间距 | Integrations tab 打开 | 对照 Skills tab 的 toolbar/card 间距 | Add by chat 与 card 区域间距一致；无额外 section title |
| AI-INT-P1-04 | Test connection 按钮状态 | 正在测试某个 integration | 连续点击 Test connection | 按钮进入 testing/disabled 状态；不会并发多次测试；完成后恢复 |
| AI-INT-P1-05 | 长输出截断 | CLI 输出超过 512KB | 调用该 CLI tool | UI 不崩溃；tool result 有截断或错误提示；后续对话仍可继续 |
| AI-INT-P1-06 | MCP server 启动超时 | MCP stdio command 长时间不返回 | 点击 Test connection | 超时后显示错误；进程被清理；卡片显示 Error |
| AI-INT-P1-07 | 凭证更新后立即生效 | Integration 已有旧 token | 通过 chat 更新 credential → Test connection | 使用新 credential；旧 preview 被替换；完整旧 token 不可见 |
| AI-INT-P1-08 | Activities 搜索分页 | Integration 有超过 20 条调用记录 | 点击 View activities，翻页 | total、页码、下一页正确；刷新后仍保留搜索条件 |
| AI-INT-P1-09 | 多 integration 同一轮调用 | 同一轮 chat 调用 GitHub 和 Figma | 完成对话后分别点击两个 card 的 View activities | 两个 integration 都能命中同一条或对应活动记录 |
| AI-INT-P1-10 | 切换 agent 隔离 | 两个 agent 分别有不同 integration | 切换账号或 agent | A agent 的 integration、credential、activities 不出现在 B agent |
| AI-INT-P1-11 | CLI runtime sandbox 隔离 | 两个 agent 都配置 Lark CLI | 分别完成授权并调用 `lark_auth_status` | 两个 integration 的 `HOME`/`XDG_*` 路径不同；A 的 Lark 登录态不影响 B；同一 integration 的命令串行执行 |

## P2 / 回归扩展

| ID | 用例 | 预期结果 |
|----|------|----------|
| AI-INT-P2-01 | Backend restart 后 integration 仍存在 | DB 中 integration、credentials、health、lastUsedAt 保留 |
| AI-INT-P2-02 | 未配置 `INTEGRATION_SECRET_KEY` 的 dev fallback | 本地可运行；日志/文档提示生产必须配置独立密钥 |
| AI-INT-P2-03 | MCP HTTP header 注入 | Figma token 只进入请求 header，不出现在 UI 和日志 |
| AI-INT-P2-04 | provider preset 幂等 | 多次打开 Integrations tab 不重复创建 GitHub/Lark/Figma card |
| AI-INT-P2-04b | Lark legacy MCP 保留并补齐 CLI | DB 已存在 `providerKey=lark`、`transport=mcp-stdio` 或 `lark_mcp_call`，但没有 Lark `cli` row | 再次打开 Integrations tab 或调用 `list_integrations` | 原有 row 不被自动改写为 CLI，已有 MCP config/credential 不被删除；额外出现 disabled 的 Lark CLI row，后续可单独授权 |
| AI-INT-P2-05 | manifest schema 非法 | 创建或更新失败，错误提示字段明确 |
| AI-INT-P2-06 | tool remoteName 映射 | MCP manifest 中 remoteName 与本地 tool name 不同，仍调用正确远端工具 |

## 后端接口用例

| ID | 接口 | 场景 | 断言 |
|----|------|------|------|
| AI-INT-API-01 | `GET /api/agents/:agentId/integrations` | 首次查询 | 自动补齐 system integrations；无重复行 |
| AI-INT-API-02 | `PUT /api/agents/:agentId/integrations/:id` | 开关切换 | 只更新 enabled；不因关闭覆盖 health status |
| AI-INT-API-03 | `POST /api/agents/:agentId/integrations/:id/test` | disabled 但已配置 | 可以测试连接并更新 health；UI 关闭态不展示 health label |
| AI-INT-API-04 | `POST /api/agents/:agentId/integrations` | custom CLI 创建 | 返回 card 所需完整 summary；credentials 只返回 preview |
| AI-INT-API-05 | `DELETE /api/agents/:agentId/integrations/:id` | 删除 custom | 删除 integration 和 credential；system integration 不走删除入口 |
| AI-INT-API-06 | `GET /api/agents/:agentId/activities?search=<integrationId>` | Integration 使用后查询 | 返回包含 `source=integration:<id>` 的活动记录 |

## 自动化建议

- P0-01、P0-02、P0-08、P0-13、P0-20 适合做 Playwright UI E2E。
- P0-09、P0-10、P0-11、P0-12 适合后端集成测试，使用 fake CLI 和 fake MCP server，避免依赖真实第三方平台。
- P0-18、P0-19 作为跨模块冒烟测试，建议只跑本地/stub provider。
- 所有 secret 相关断言都要检查 UI、API response、日志三处不暴露明文。
