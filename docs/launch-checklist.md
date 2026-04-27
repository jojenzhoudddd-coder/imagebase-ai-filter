# ImageBase 上线 Hardening Checklist

> 现状(2026-04-27 V2.9.11):single-region (雅加达 / 163.7.1.94) + docker postgres + ssh+pm2 部署 + 无 CDN + 无监控
> 目标:能扛 1k DAU、跨大洲访问、数据不丢、错误可观测、滥用不烧钱

---

## 阶段总览

| 阶段 | 重点 | 阻塞上线? | 时间预估 |
|---|---|---|---|
| **Phase 0:不上线就完蛋的 P0** | 数据安全 + 限频 + 监控 + 安全基线 | ✅ 阻塞 | 1.5 周 |
| **Phase 1:体验关卡** | CDN + admin / 隐私 + CI/CD | ✅ 阻塞 | 1 周 |
| **Phase 2:规模化** | 多 region + 读写分离 + 配额看板 | 上线后做 | 2-3 周 |
| **Phase 3:成熟期** | 审计 / 备份演练 / DR drill | DAU > 500 后 | 持续 |

---

## Phase 0:P0 上线必做

### 0.1 数据库迁移到 managed 服务

**👤 你来做**
- [ ] 选云厂商 + 实例规格(对标推荐:**AWS RDS PostgreSQL 15** `db.t4g.medium` 起 / 阿里云 PolarDB PG 4C8G)
- [ ] 开 **跨区 snapshot 复制**:雅加达主 → 新加坡 + 东京 backup
- [ ] 开 **PITR 7 天**(默认就有,但确认开了)
- [ ] 把 RDS endpoint + master password 放 **AWS Secrets Manager** / Vault,**不要落盘到 .env**
- [ ] 开 RDS 的 **Performance Insights**(免费 7 天保留)
- [ ] 配 **VPC + Security Group** 只允许 backend 实例访问,关闭公网

**🛠 我来做**
- [ ] 写迁移脚本:`pg_dump` 当前 docker → restore 到 RDS,验证 row count
- [ ] 改 `backend/src/services/agentService.ts` 等所有 `new pg.Pool({ connectionString: process.env.DATABASE_URL })`,统一从 secrets manager 读
- [ ] 加连接池参数:`max=20`(单实例),`idleTimeoutMillis=30000`,`connectionTimeoutMillis=5000`
- [ ] 加 graceful shutdown:`SIGTERM` 时 `pool.end()` 等连接 drain 再退出
- [ ] **跑一次 restore drill**:从昨天的 snapshot restore 到测试环境,验证数据完整(写到 `docs/runbooks/db-restore.md`)

---

### 0.2 文件存储迁 S3 / OSS

**👤 你来做**
- [ ] 开 **S3 bucket**(或阿里 OSS):`imagebase-prod-{agents,demos,analyst,worktrees}` 分别一个
- [ ] 开 **跨区复制 (CRR)** 雅加达 → 新加坡
- [ ] 开 **Object Versioning**(误删恢复)
- [ ] 开 **Lifecycle**:90 天前的 worktree / analyst snapshot 自动转 Glacier
- [ ] 给 backend EC2 一个 IAM Role,只能 `s3:GetObject/PutObject` 这几个 bucket

**🛠 我来做**
- [ ] 抽象一个 `storage.ts` 接口:`readFile(prefix, key)` / `writeFile(prefix, key, content)` / `listFiles(prefix)`
- [ ] 加 `STORAGE_BACKEND=local|s3` env 切换;dev 仍用本地,prod 用 S3
- [ ] 改 `~/.imagebase/agents/` 路径 → `s3://imagebase-prod-agents/<agentId>/`
  - `agentService.ts` (soul/profile/config/memory/state)
- [ ] 改 `~/.imagebase/demos/` → `s3://imagebase-prod-demos/<demoId>/{files,dist,published}/`
  - `demoRoutes.ts` 的 build/publish/preview/sdk 全要改读 S3
  - `publicDemoRoutes.ts` (`/share/:slug/*`) 改 S3 redirect 或 stream
- [ ] 改 `~/.imagebase/analyst/` → `s3://imagebase-prod-analyst/`
  - `snapshotService.ts`(parquet 写 S3)
  - `duckdbRuntime.ts`(DuckDB 支持 `s3://` 直接 attach,不用先下载)
  - `resultCache.ts`
- [ ] 改 `~/.imagebase/agent-worktrees/` → ⚠️ 这个特殊:git worktree 必须本地磁盘,**保持本地 + EFS/NFS** 或者把 worktree 挂在 backend 实例上,但要在 cleanup cron 里加"实例重启自动清理"
- [ ] 写 一次性迁移脚本 `scripts/migrate-storage-to-s3.ts`

---

### 0.3 Body size + 输入硬限

**🛠 我来做**
- [ ] `backend/src/index.ts` 加 `express.json({ limit: "1mb" })` 全局
- [ ] `idea content`:在 `ideaRoutes.ts` `PUT /content` 单独 `express.json({ limit: "256kb" })`,超限 413
- [ ] `demoRoutes.ts` `PUT /:id/file`:单文件 `1mb`,demo 总文件数 ≤ 50,总大小 ≤ 5mb
- [ ] `tasteRoutes.ts` SVG 上传:已在? 没有就加 `multer` 限 1mb
- [ ] `agentService.ts` 已有 `MAX_IDENTITY_BYTES=64KiB` ✅
- [ ] `chatRoutes.ts` 单条 user message 限 32KB(含 mention 也够)

**测试用例(写到 test-plan.md)**
- [ ] 上传 5MB markdown 到 idea → 413
- [ ] 单 demo 写 51 个文件 → 第 51 个被拒

---

### 0.4 限频 + 配额(防烧钱)

**🛠 我来做**

新建 `backend/src/services/quotaService.ts`,基于 Redis(下面 0.5 会装):
```ts
// per-user 配额
- chat.concurrent_turns: 3
- chat.messages_per_minute: 20
- chat.messages_per_day: 500
- chat.tokens_per_day: 1_000_000  (按模型加权,opus 系数 5x)
- workflow.concurrent_runs: 2
- cron.max_jobs: 10
- cron.min_interval_minutes: 5
- subagent.depth: 2  (已有)
```

- [ ] `chatRoutes.ts` POST messages 入口:`await quota.acquire(userId, "chat.turn")`,失败返 429 + `Retry-After`
- [ ] `chatAgentService.ts` 每轮结束:`await quota.consumeTokens(userId, prompt+completion, model)`
- [ ] `cronTools.ts` `schedule_task`:验证 user 总 cron 数 + cron interval ≥ 5min
- [ ] 已有的 `demoCapabilityGuard` 限流统一搬到 quotaService 里
- [ ] `/api/admin/quotas/:userId` 端点查看 + 调整(覆盖默认值)

**👤 你来做**
- [ ] 决策:免费用户配额是多少?付费用户?(数字我可以建议,但你定)
- [ ] 把决策写进 `docs/pricing.md`

---

### 0.5 Redis(限频 + 分布式锁 + 缓存)

**👤 你来做**
- [ ] 开 **ElastiCache Redis**(`cache.t4g.micro` 够,~$15/月)或 阿里云 Redis
- [ ] 单可用区即可(不存关键数据,挂了配额暂时失效不致命)
- [ ] Security Group 只允许 backend

**🛠 我来做**
- [ ] 加 `ioredis` 依赖
- [ ] `lib/redisClient.ts` 单例
- [ ] `quotaService.ts` 用 sliding window(`ZADD` + `ZREMRANGEBYSCORE`)
- [ ] `runtimeService.ts` heartbeat 改 distributed lock(`SET key value NX EX 300`),只有持锁的实例跑 cron
- [ ] `subagentDangerPending` / `ideaStreamSessionService` Map 改 Redis(否则多实例时对不上)

---

### 0.6 Sentry + 结构化日志

**👤 你来做**
- [ ] 注册 Sentry,创建两个 project:`imagebase-backend` / `imagebase-frontend`
- [ ] 拿到 DSN,放 secrets manager
- [ ] (可选)开 Sentry Performance(APM 替代品,够用 + 便宜)

**🛠 我来做**
- [ ] backend:`@sentry/node` + `@sentry/profiling-node`,在 `index.ts` 最顶端 init
- [ ] frontend:`@sentry/react`,带 `BrowserTracing`
- [ ] 加 release tag(用 `git rev-parse --short HEAD`)
- [ ] 用户 context:登录后 `Sentry.setUser({ id: agentId, email })`
- [ ] **改 `logAgent()` 为 pino**:输出 JSON `{level, time, msg, ...meta}`,stdout 就行(PM2 / docker 自动收集)
- [ ] 关键路径加 trace span:每个 chat turn 一个 span,subagent / tool / DB query 都是子 span
- [ ] error 边界:`<ErrorBoundary>` 包 ChatSidebar / IdeaEditor / SvgCanvas / DemoPreviewPanel,捕获组件级崩溃

---

### 0.7 Admin role gate(我自己埋的 TODO)

**🛠 我来做**
- [ ] `backend/src/middleware/requireAdmin.ts`:读 `Agent.config.json.admin === true`,否 403
- [ ] `/api/admin/*` 全套上 `requireAdmin`
- [ ] `/api/_schemas` 也套上(目前公开)
- [ ] 加 `scripts/grant-admin.ts <agentId>` 一次性脚本

**👤 你来做**
- [ ] 上线后立刻给自己 `node scripts/grant-admin.ts agent_xxx`

---

### 0.8 安全基线

**🛠 我来做**
- [ ] **CSRF**:`csurf` 中间件,所有 state-changing endpoint(POST/PUT/PATCH/DELETE)校验,GET 不校验
  - 改 `frontend/src/api.ts` `mutationFetch` 自动带 `X-CSRF-Token` header
  - SSE endpoints 例外(SSE 是 GET)
- [ ] **HSTS**:nginx `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload";`
- [ ] **CSP**(渐进):先 `Content-Security-Policy-Report-Only`,跑两周收报告再改成强制
  - 主域:`default-src 'self'; script-src 'self' 'unsafe-inline' cdn.tailwindcss.com esm.sh`
  - `/share/:slug/*` 严格隔离:`default-src 'self'; connect-src 'self' /api/demo-runtime/`
- [ ] **CORS**:目前没看到严格配置,加 `cors({ origin: "https://www.imagebase.cc", credentials: true })`
- [ ] **Helmet**:加 `helmet()` 一锅端默认 headers
- [ ] **Login 限频**:`/api/auth/login` per-IP 5/min 失败锁定 15min
- [ ] **Cookie**:`HttpOnly + Secure + SameSite=Lax`,session 7 天

**👤 你来做**
- [ ] 申请 SSL 证书(Let's Encrypt 自动续)或 **直接用 Cloudflare 的免费 SSL**(Phase 1 接 CF 时一并)
- [ ] 隐私政策 + 用户协议起草(模板 https://termly.io 改改即可),包含:
  - 数据出境告知(对话内容发给 Volcano ARK / OneAPI 等模型供应商)
  - Cookie 用途
  - 数据保留期限
- [ ] 把链接挂到登录页 / settings 页脚

---

### 0.9 Conversation / Message 增长治理

**🛠 我来做**
- [ ] 加 `Conversation.archivedAt` 字段(prisma migration)
- [ ] cleanup cron(已有 `cleanupCron.ts` 框架):每天 02:00 跑
  - 把 6 个月没活动的 conversation `archivedAt = now()`,从 list 接口默认隐藏
  - 12 个月以上的 message 转储到 S3 cold storage(JSON.gz),从 PG 删
- [ ] `Message` 表加 partial index:`WHERE conversationId IN (active conversations)` 加速查询
- [ ] `/api/chat/conversations` 默认只返回未归档的,`?includeArchived=1` 才返全量

---

## Phase 1:CDN / CI/CD / 体验

### 1.1 Cloudflare 全站接入

**👤 你来做**
- [ ] `imagebase.cc` 域名 NS 改到 Cloudflare(免费 plan 够用,Pro $20/月有更细规则)
- [ ] 开 **Proxy(橙色云)** for `www.imagebase.cc`
- [ ] 开 **Argo Smart Routing**($5 + $0.1/GB,显著降全球延迟)
- [ ] 开 **Tiered Cache**(免费,边缘命中率 +30%)
- [ ] 开 **Bot Fight Mode**(免费防爬虫)
- [ ] **WAF rules** 关键几条:
  - block 非中国/东南亚以外的 `/api/auth/login` POST(可选,看你客户群)
  - rate limit `/api/*` per IP 100/min
  - challenge `/share/:slug/*` if Cloudflare 检测 bot
- [ ] **DNS**:`@` + `www` proxy on,`api.imagebase.cc` 也 proxy

**🛠 我来做**
- [ ] 静态资源 fingerprint(Vite 默认有)→ nginx `/assets/*` 加 `Cache-Control: public, max-age=31536000, immutable`
- [ ] `/index.html` `Cache-Control: no-cache`(立即生效新版本)
- [ ] **SSE 路径绕过 CDN cache**:nginx 给 `/api/chat/*messages` 加 `Cache-Control: no-store`,Cloudflare 看到自动 bypass
- [ ] 改前端字体加载:用 Cloudflare 自带 fontawesome / 或者放 cdnjs,不要 self-host(降首字节)
- [ ] vite split chunk:把 `embed-BTWdaf0w.js`(823KB,vega-embed)`dynamic import` 化(已经做了 ✅)

---

### 1.2 CI/CD

**👤 你来做**
- [ ] GitHub repo 设 secrets:`AWS_ACCESS_KEY_ID` / `SSH_DEPLOY_KEY` / `SENTRY_AUTH_TOKEN`
- [ ] 注册一个 ECR / Docker Hub(私有 repo)
- [ ] 决定:用 **PM2 + 单实例**(够 1k DAU)还是 **ECS Fargate / k8s**(扩展性更好但运维复杂)
  - **建议**:先 PM2 + 2 实例 + ALB,等到 DAU 上 500 再 ECS

**🛠 我来做**
- [ ] `.github/workflows/ci.yml`:
  - on PR: `npm ci` + lint + typecheck + 单测
  - on push main: build → tag with `git sha` → push image
- [ ] `.github/workflows/deploy.yml`:手动触发,拉指定 sha,SSH 到 prod 跑 pull image + blue-green
- [ ] **blue-green 脚本**(不上 k8s 的简化版):
  ```
  pm2 start ecosystem.config.js --name ai-filter-green
  curl http://localhost:3002/healthz  # 新实例
  if 200, nginx switch upstream → green
  pm2 delete ai-filter-blue
  ```
- [ ] **healthz endpoint**:`GET /healthz` 返 `{db: ok, redis: ok, version: <sha>}`,DB / Redis 任一挂返 503
- [ ] **Migration 自动化**:CI 跑 `prisma migrate diff --to-schema-datamodel ./prisma/schema.prisma`,如果有破坏性变更(drop col / non-null no default),PR 上贴 ⚠️ comment 要求 reviewer 手动确认

---

### 1.3 备份演练 + Runbook

**🛠 我来做**
- [ ] 写 `docs/runbooks/` 目录:
  - `db-restore.md` — 从 RDS snapshot 恢复全流程
  - `deploy-rollback.md` — blue-green 回滚步骤
  - `incident-response.md` — 504 / Sentry 告警 / DB 慢查询的排查 SOP
  - `secret-rotation.md` — ARK / OneAPI / DB password 90 天轮换流程

**👤 你来做**
- [ ] **每月跑一次 restore drill**(钉日历提醒)
- [ ] **找一个备份联系人**(团队 ≥ 2 人才能 oncall)

---

## Phase 2:规模化(上线后第 1-2 月做)

### 2.1 业务 dashboard

**🛠 我来做**
- [ ] `/api/admin/metrics` 已有 → 接 Grafana(免费 cloud plan)
- [ ] Panel:
  - 当日 token 花费(按模型 / 按 user)
  - p50 / p95 / p99 chat turn duration
  - tool_timeout / TOOL_TIMEOUT_FORCED 错误率
  - subagent depth=2 比例(异常高 = 模型陷入嵌套)
  - workflow success rate by template
  - active SSE connections
- [ ] 告警 PagerDuty / 飞书机器人:
  - error rate > 5% 持续 5 分钟
  - DB p99 > 500ms 持续 10 分钟
  - 单 user 一小时 token > 100k(疑似滥用)

---

### 2.2 多 region(只在 DAU > 200 后做)

> 现在做太早,空跑多 region 一个月烧 $300+

**👤 你来做(到时候)**
- [ ] 在 us-east-1(弗吉尼亚)或 eu-central-1(法兰克福)开第二个 region 实例
- [ ] DB:开 RDS read replica 在该 region
- [ ] **GeoDNS**:Cloudflare Load Balancer($5/月)按用户 IP 路由

**🛠 我来做(到时候)**
- [ ] 把 `runtimeService.ts` heartbeat / cron 锁定主 region(用 Redis 分布式锁)
- [ ] 边缘 region 只 serve 静态 + 读 API(`GET /api/tables`、`GET /api/ideas`)
- [ ] 写 `/api/chat/*` / `/api/ideas/:id/content`(写流量)forced 路由主 region

---

### 2.3 读写分离

**🛠 我来做(到时候)**
- [ ] Prisma 不原生支持读写分离,要写 `prismaRead` / `prismaWrite` 两个 client
- [ ] 标注 read-only 路由(`GET /api/tables` / `GET /api/ideas`)走 `prismaRead`
- [ ] 写路由 + 读完即写场景(优惠券领取那种)走 `prismaWrite`

---

## Phase 3:成熟期(DAU > 1000 后)

- [ ] **完整审计日志**:谁删了什么,90 天保留(合规)
- [ ] **数据导出 / 删除**(GDPR / PIPL):用户能下载自己所有数据 + 一键删除账号
- [ ] **Bug bounty**:hackerone 上挂 program
- [ ] **Pen test**:第三方安全公司,$5k 起
- [ ] **SOC2** 准备(如果做 to B)

---

## 你需要决策 / 采购的清单(汇总)

### 立刻要做(Phase 0+1)

| 项 | 推荐方案 | 月成本估 | 备注 |
|---|---|---|---|
| **托管 DB** | AWS RDS PostgreSQL `db.t4g.medium` Multi-AZ + 7d PITR + 跨区 snapshot | ~$120 | 必选 |
| **对象存储** | S3 Standard + 跨区复制 + Versioning | ~$10 起,按用量 | 必选 |
| **Redis** | ElastiCache `cache.t4g.micro` 单 AZ | ~$15 | 必选 |
| **Sentry** | Team plan ($26/月,50k events) | $26 | 必选 |
| **Cloudflare** | Free plan + Argo($5+流量) | $5-30 | 必选 |
| **CI/CD** | GitHub Actions (公共 repo 免费,私有 2000 min/月) | $0-21 | 必选 |
| **VPC / 安全组 / SSL** | 自己配 | $0 | 必选 |
| **监控** | Grafana Cloud Free(10k metrics) | $0 | Phase 2 |
| **域名 SSL** | Cloudflare 免费 / Let's Encrypt | $0 | 必选 |
| **Backup S3 cold storage** | Glacier Deep Archive | ~$1/100GB | Phase 0.9 |

**Phase 0+1 月固定成本约 $200-250**,加上 LLM API 自费(ARK / OneAPI 按用量),每个 DAU $0.5-2 的 API 成本是合理预期。

### 后续(Phase 2+)

| 项 | 触发条件 | 月成本 |
|---|---|---|
| 第二 region | DAU > 200 | +$150 |
| RDS read replica | p99 读 > 200ms | +$60 |
| Cloudflare Pro | WAF 自定规则需要 | $20 |
| PagerDuty / Opsgenie | 团队 ≥ 2 人 | $20/人 |
| 第三方 pen test | 拿融资 / to B | $5k 一次性 |

---

## 时间线建议

```
Week 1:  Phase 0.1 (DB)  + 0.2 (S3)        — 你买资源 + 我写迁移
Week 2:  Phase 0.3-0.6 (限制/限频/Sentry)   — 我写代码,你提供 Sentry / Redis 资源
Week 3:  Phase 0.7-0.9 (admin/安全/归档)    — 我写代码,你起草隐私政策
Week 4:  Phase 1.1 (Cloudflare) + 1.2 (CI/CD) + 1.3 (Runbook) — 我写代码,你接 CF
Week 5:  灰度上线(50 用户)+ 24h on-call
Week 6:  公开上线
```

---

## 启动顺序建议

1. **今天 / 明天**:决定云厂商(AWS / 阿里云),开 RDS + Redis + S3 实例,把 DSN / endpoint 给我
2. **同时**:可以并行做 Phase 0.3 / 0.4 / 0.7(body limit / 限频 / admin gate),这些纯代码改动,不依赖云资源
3. **本周末**:写隐私政策草稿,我整理 runbook 模板
