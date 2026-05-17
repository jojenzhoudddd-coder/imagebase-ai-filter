# Funature 正式上线 Checklist V2

> **基线**：2026-05-11，109K 行代码，27 个 Prisma 模型，395 个源文件
> **目标**：支撑 **10 万 DAU**，全球访问，数据不丢，费用可控，安全合规
> **当前状态**：单机雅加达 163.7.1.94（7.5GB RAM）+ Docker PG + PM2 单进程
>
> 命名说明：对外品牌统一为 **Funature**。当前 `~/.imagebase/`
> 是历史内部存储路径，迁移到对象存储前继续保留。

---

## 与 V1 Checklist 的差异

自 V1（2026-04-27）以来新增的代码/能力，影响上线方案：

| 新增模块 | 上线影响 |
|----------|---------|
| Admin Block + admin/related 用户体系 | requireAdmin 已落地，但需全量 admin gate 审计 |
| DailySnapshot + sparkline | 新 cron 任务，需确保只跑一个实例 |
| SwipeDelete（去掉了所有 ConfirmDialog） | 无直接上线影响 |
| User timezone（preferences.timezone） | 前端已就绪，无后端影响 |
| pg.types.setTypeParser(1114) 覆盖 | 仅 adminRoutes + agentRoutes 的 pool，全局 pool 未覆盖，需统一 |
| 多处 new pg.Pool() 散落（2+ 处） | 连接泄漏风险，必须收口 |
| SortPanel + AI Sort | 新增 aiRoutes 端点，需限频 |
| Folder CRUD + MCP tools | 新增 folderRoutes + folderTools |
| 系统 habits 默认关闭 | token 成本已优化 |

---

## Phase 0：阻塞上线（~3 周）

### 0.1 数据库：托管 + 读写分离 + 连接池

**10 万 DAU 级别必须**：单机 Docker PG 不可能撑住。

**架构**：
- **写库**：AWS RDS PostgreSQL 15 `db.r6g.xlarge`（4C32G），Multi-AZ
- **读库**：2 个 Read Replica `db.r6g.large`（2C16G），分布在不同 AZ
- 开 PITR 7 天 + 跨区 snapshot（雅加达 → 新加坡）
- Performance Insights 开启

**代码改动（我来做）**：
- [ ] **连接池收口**：当前有 2 个 `pg.Pool` + 2 个 `PrismaClient` 散落在 `index.ts` / `adminRoutes.ts` / `agentRoutes.ts`。收口为 `lib/db.ts` 导出单一 `{ pool, prisma, prismaRead }`
- [ ] **全局 `pg.types.setTypeParser(1114)`**：移到 `lib/db.ts` 入口，不再各文件单独设
- [ ] **读写分离**：`prismaRead` 走 Read Replica，用于所有 GET 路由；`prisma`（写）走主库
- [ ] 连接池参数：`max=30, idleTimeoutMillis=30000, connectionTimeoutMillis=5000`
- [ ] graceful shutdown：`SIGTERM` 时 `pool.end()` drain

**你来做**：
- [ ] 开 RDS 实例 + 2 个 Read Replica
- [ ] 配 VPC + Security Group
- [ ] 把连接字符串放 AWS Secrets Manager

**月成本**：~$400（写库 $200 + 2 读库 $200）

---

### 0.2 应用层：多实例 + 负载均衡

**10 万 DAU 的并发计算**：
- 10 万 DAU × 5% 同时在线率 = **5000 并发用户**
- 每用户 2 SSE 连接 = **10000 长连接**
- 每用户每分钟 0.5 次 API 调用 = **2500 QPS**

**架构**：
- **4-8 个 Node 实例**（PM2 cluster 或 ECS Fargate）
- **ALB**（Application Load Balancer）做流量分发
- SSE 连接需要 **sticky session**（ALB 支持，基于 cookie）
- 或改用 **Redis Pub/Sub** 替代进程内 EventBus，实现跨实例 SSE 广播

**代码改动（我来做）**：
- [ ] **EventBus 改 Redis Pub/Sub**：当前 `eventBus.ts` 是进程内 EventEmitter，多实例时 SSE 事件只在发起实例广播。改为 Redis channel 发布，每个实例订阅
- [ ] **Session store 改 Redis**：JWT 无状态不需要，但 `ideaStreamSessionService`（in-memory Map）、`subagentDangerPending`、`skillStateByConv` 等 in-memory 状态需要迁移到 Redis
- [ ] **Cron 分布式锁**：`runtimeService.ts` heartbeat 改 Redis `SET NX EX`，只有一个实例执行 cron
- [ ] **DailySnapshot**：同上，加分布式锁防多实例重复写入
- [ ] **PM2 ecosystem.config.js**：`instances: "max"` 或固定 4-8

**你来做**：
- [ ] 开 ALB + Target Group
- [ ] 决策：PM2 cluster（单机多进程）还是 ECS Fargate（多机容器）
  - 建议：先 PM2 cluster 4 进程，DAU 过 5 万再加机器

**月成本**：ALB ~$20，额外 EC2 实例 ~$100-200/台

---

### 0.3 Redis：限频 + 分布式锁 + EventBus

**10 万 DAU 必须有 Redis**，否则多实例无法协调。

**用途**：
1. **限频**：per-user/per-IP 滑动窗口
2. **分布式锁**：cron / dailySnapshot / build_demo
3. **EventBus**：SSE 跨实例广播
4. **会话状态**：ideaStreamSession / subagentDangerPending

**代码改动（我来做）**：
- [ ] `lib/redis.ts` 单例（`ioredis`）
- [ ] `quotaService.ts`：
  ```
  chat.concurrent_turns: 3/user
  chat.messages_per_minute: 20/user
  chat.messages_per_day: 1000/user
  chat.tokens_per_day: 2_000_000/user（opus 系数 5x）
  api.requests_per_minute: 60/IP
  login.failures_per_hour: 10/IP（超了锁 15min）
  ```
- [ ] `chatRoutes.ts` / `aiRoutes.ts` 入口加 `quota.acquire()`，429 + Retry-After
- [ ] Demo runtime 已有的滑动窗口限流迁到 Redis（目前 in-memory）

**你来做**：
- [ ] 开 ElastiCache Redis `cache.r6g.large`（2C13G，支撑 10 万 DAU 连接）
- [ ] Security Group 只允许 backend

**月成本**：~$100

---

### 0.4 对象存储（S3）

当前所有文件写本地磁盘 `~/.imagebase/`，多实例时各自文件不共享。

**代码改动（我来做）**：
- [ ] 实现 `S3Storage implements BlobStorage`（`LocalFsStorage` 接口已有）
- [ ] env 切 `BLOB_STORAGE_BACKEND=s3`
- [ ] 迁移脚本：本地 → S3
- [ ] `/share/:slug/*` 改 S3 redirect 或 CloudFront
- [ ] DuckDB `.duckdb` 文件保留本地（不支持 S3），但 parquet snapshot 上 S3
- [ ] Demo build `dist/` 上 S3，preview 走 CloudFront

**你来做**：
- [ ] 开 S3 bucket（分 agents / demos / analyst / attachments）
- [ ] 开跨区复制 + Versioning + Lifecycle（90 天转 Glacier）
- [ ] IAM Role 给 EC2

**月成本**：~$10-50（按用量）

---

### 0.5 CDN + 全球加速

**10 万 DAU 分布全球**必须有 CDN。

**架构**：
- **Cloudflare Pro**（$20/月）：WAF + Bot 防护 + 自定义规则
- 或 **CloudFront**：和 S3/ALB 原生集成
- 静态资源（JS/CSS/images）→ CDN 缓存，`Cache-Control: immutable`
- API 请求 → ALB 直通，不缓存
- SSE 路径 → bypass CDN（`Cache-Control: no-store`）
- `/share/:slug/*` → CloudFront 直接 serve S3

**你来做**：
- [ ] 域名 NS 改到 Cloudflare（或配 CloudFront distribution）
- [ ] 开 WAF 规则（rate limit per IP、bot challenge）
- [ ] SSL 证书（Cloudflare 免费）

**月成本**：~$20-100

---

### 0.6 监控 + 告警

**代码改动（我来做）**：
- [ ] **Sentry**：backend `@sentry/node` + frontend `@sentry/react`
- [ ] **结构化日志**：`console.log` → `pino` JSON stdout
- [ ] **healthz 端点**：`GET /healthz` → `{db, redis, version}`
- [ ] **Grafana dashboard**（或 Sentry Performance）：
  - chat turn p50/p95/p99
  - token 花费（按模型/按用户/按天）
  - SSE 活跃连接数
  - 429 rate limit 命中率
  - DB 慢查询 > 500ms

**你来做**：
- [ ] 注册 Sentry Team plan（$26/月）
- [ ] Grafana Cloud free（10k metrics）
- [ ] 告警通道（飞书机器人 / PagerDuty）

**月成本**：~$30

---

### 0.7 安全加固

**代码改动（我来做）**：
- [ ] **Helmet**：一键加默认安全 headers
- [ ] **CORS**：严格 origin `https://www.funature.fun`
- [ ] **CSP**：先 Report-Only 跑两周再强制
- [ ] **Body limit**：全局 1MB，idea content 256KB，demo file 1MB
- [ ] **Login 限频**：per-IP 10/min 失败锁 15min（走 Redis）
- [ ] **Cookie**：`HttpOnly + Secure + SameSite=Lax`
- [ ] **Admin gate 审计**：确认所有 `/api/admin/*` 都有 `requireAdmin`
- [ ] **API key 不落盘**：改读 Secrets Manager

**你来做**：
- [ ] 隐私政策 + 用户协议（含数据出境告知、Cookie 用途）
- [ ] SSL 证书配置

---

### 0.8 数据增长治理

**代码改动（我来做）**：
- [ ] `Conversation.archivedAt`：6 个月无活动自动归档
- [ ] `Message` 12 个月以上转冷存储（S3 JSON.gz）→ PG 删
- [ ] `TokenUsage` 90 天以上聚合为日粒度，明细删
- [ ] `DailySnapshot` 保留 365 天
- [ ] Analyst session 清理已有（2h idle close、7d file delete）
- [ ] Agent memory 压缩已有（10 条 working → 1 episodic）

---

## Phase 1：上线后第一个月

### 1.1 CI/CD 流水线
- [ ] GitHub Actions：PR → lint + typecheck + 单测
- [ ] Push main → build Docker image → push ECR
- [ ] Deploy：blue-green（PM2 双实例切换）
- [ ] Migration 自动化：`prisma migrate diff` 检测破坏性变更

### 1.2 多 Region（DAU > 3 万时）
- [ ] 第二 region（新加坡或东京）
- [ ] DB Read Replica 跟过去
- [ ] Cloudflare/CloudFront GeoDNS 路由
- [ ] 写流量 forced 回主 region

### 1.3 LLM API 成本控制
- [ ] per-user token 日限额（free: 100K/天, pro: 2M/天）
- [ ] opus/gpt 模型按 5x 系数计费
- [ ] Admin dashboard token 花费面板（已有基础）
- [ ] 自动降级：当日额度用完 → 只能用 doubao-2.0

---

## Phase 2：成熟期（DAU > 5 万）

- [ ] PG 读写分离升级：按表拆分（messages 表最大，独立 replica）
- [ ] Redis Cluster（当前单节点 → 3 节点集群）
- [ ] ECS Fargate 自动伸缩（CPU > 70% → 加实例）
- [ ] 完整审计日志（谁删了什么，90 天保留）
- [ ] GDPR/PIPL 数据导出 + 账号删除
- [ ] 第三方安全审计 / Pen test

---

## 10 万 DAU 架构总览

```
用户 → Cloudflare CDN (WAF + 静态缓存)
       ↓
       ALB (sticky session for SSE)
       ↓
   ┌───┴───┐
   │ Node  │ × 4-8 实例 (PM2 cluster 或 ECS)
   │ 进程  │
   └───┬───┘
       ├── Redis (限频 + 分布式锁 + EventBus Pub/Sub)
       ├── RDS PostgreSQL (写主库 + 2 读库)
       ├── S3 (文件存储 + Demo 发布 + Analyst 快照)
       └── 外部 API (ARK / OneAPI / Tavily)
```

---

## 成本估算

### 月固定成本（10 万 DAU 配置）

| 项目 | 规格 | 月成本 |
|------|------|--------|
| RDS PostgreSQL（写 + 2 读） | r6g.xlarge + 2×r6g.large | ~$400 |
| EC2（4 个 Node 实例） | t4g.large × 4 | ~$240 |
| ElastiCache Redis | r6g.large | ~$100 |
| ALB | 按 LCU | ~$30 |
| S3 + CloudFront | 按用量 | ~$50-200 |
| Cloudflare Pro | Pro plan | ~$20 |
| Sentry | Team plan | ~$26 |
| Grafana Cloud | Free → Pro | ~$0-50 |
| **合计** | | **~$870-1070/月** |

### 变动成本（LLM API）

| 模型 | 单价估 | 10 万 DAU 日均 |
|------|--------|---------------|
| doubao-2.0 | ~$0.001/1K tokens | ~$50-100/天 |
| claude-opus | ~$0.03/1K tokens | ~$300-500/天（仅 related 用户） |
| gpt-5.4 | ~$0.02/1K tokens | ~$200-300/天（仅 related 用户） |

**月 LLM 成本**：$3,000-15,000（取决于 related 用户比例和使用强度）

---

## 只能你来做的事情（按优先级）

### 必须在上线前完成

| 序号 | 事项 | 预计耗时 |
|------|------|---------|
| 1 | **选云厂商 + 开 RDS 实例**（写 + 2 读，配 VPC/SG） | 1 天 |
| 2 | **开 ElastiCache Redis** | 0.5 天 |
| 3 | **开 S3 bucket**（4-5 个，开 CRR + Versioning） | 0.5 天 |
| 4 | **开 ALB + Target Group** | 0.5 天 |
| 5 | **域名接 Cloudflare / CloudFront** | 0.5 天 |
| 6 | **注册 Sentry + Grafana** | 0.5 天 |
| 7 | **隐私政策 + 用户协议草稿** | 1 天 |
| 8 | **SSL 证书配置** | 0.5 天 |
| 9 | **把所有 API Key / DB 密码放 Secrets Manager** | 0.5 天 |
| 10 | **决策：免费/付费用户配额** → 写 `docs/pricing.md` | 1 天 |

### 上线后定期

| 事项 | 频率 |
|------|------|
| DB restore drill（从 snapshot 恢复验证） | 每月 1 次 |
| Secret 轮换（ARK/OneAPI/DB 密码） | 每 90 天 |
| 费用审计（LLM API + 云资源） | 每周 |
| 安全扫描 / 依赖更新 | 每月 |

---

## 时间线

```
Week 1:  你开资源（RDS/Redis/S3/ALB）+ 我收口连接池 + 读写分离
Week 2:  我改 EventBus → Redis Pub/Sub + 分布式锁 + 限频
Week 3:  我做 S3 迁移 + Sentry + Helmet + 安全加固
Week 4:  我做 CI/CD + healthz + 你接 Cloudflare + 隐私政策
Week 5:  灰度上线（1000 用户）+ 24h on-call
Week 6:  扩到 1 万 DAU，观察指标
Week 7-8: 逐步放量到 10 万
```
