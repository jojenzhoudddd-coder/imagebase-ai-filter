# Desktop App 方案 — 暂存,不动手

**状态**:仅分析,未排期。决策完成后再启动。
**创建日期**:2026-05-07

## 核心结论

桌面 app **不等于** 把后端搬到本地。最优解是 Electron 壳 + 现有云后端,等价于 Slack / Notion / Linear 的做法 —— 数据库、`/share/:slug`、API key 全部不动,所有改动集中在前端打包 + 系统集成。

> 之前(此 plan v0)误把"桌面化"理解成"必须本地化",列了 Postgres → SQLite 迁移、API key 本地存 keychain、share 砍 / 留等大坑。**作废**。当前 plan 走 thin-client 路线。

## 推荐路径:Electron Thin-Client

主进程 `loadURL("https://www.funature.fun")`,Electron 装一个 persistent session 让登录态跨重启保留。零后端改动,等于"app 化的浏览器标签页"。

```js
new BrowserWindow({
  webPreferences: { partition: 'persist:funature' }
})
```

## 工作量分期

| 阶段 | 时长 | 内容 | 产物 |
|------|------|------|------|
| Phase 0 验证 | 1 天 | Electron 壳载入线上域名,跑通登录 / SSE / 文件上传 | 本机 .app 双击能用 |
| Phase 1 MVP | 4-6 天 | electron-builder 配置 + macOS DMG + Win exe(unsigned) + 系统托盘 + 菜单栏 | 可分发的 alpha 版 |
| Phase 2 上线 | 4-6 天 | Apple notarization + Win 签名(可选) + auto-update(electron-updater + GitHub Releases) + Deep link `funature://` | 正式发布版 |
| Phase 3 加分项 | 按需 | 后台常驻 + 系统通知 + 全局快捷键 + 离线只读缓存 + 原生文件 drag | 真正"app 感"的版本 |

**单人全栈** ~2 周完成 Phase 1+2,Phase 3 按需追加。

## 桌面相对网页的真实价值

只套壳意义不大。值得做的功能(由价值排序):

1. **系统通知** —— habit 完成 / agent 主动来消息直接弹原生通知(浏览器通知体验差)
2. **全局快捷键** —— `Cmd+Shift+I` 任意位置唤起 chat
3. **后台常驻** —— 关窗不退出,系统托盘看 agent 活动
4. **Deep link** —— `funature://share/xxx` 从 IM / 邮件跳转直接落桌面 app
5. **自动更新** —— 必备
6. **离线只读缓存** —— 断网仍能查最近内容(难,3-5 天)

如果只做 Phase 1,等于"独立窗口 + dock 图标",没什么吸引力。**做 1+2+3 才有意义。**

## 待决策事项(用户回答完才启动)

1. **目标平台**:macOS-only 起步 / 同时上 Win+Mac?
2. **桌面价值取舍**:Phase 3 哪些功能必须做?(系统通知 / 全局快捷键 / 后台常驻 / 离线缓存)
3. **签名 & 上线**:走 Apple Developer Program($99/年)还是先发 unsigned 内测版?
4. **分发渠道**:GitHub Releases(免费,建议)/ 自建 update server / Mac App Store(审核长)?

## 用户需要付费的部分

| 项 | 成本 | 何时需要 |
|----|------|---------|
| Apple Developer Program | $99/年 | Phase 2 macOS 签名 / 公证 |
| Windows EV 代码签名证书 | $200-400/年 | 可选(Win 不签也能跑,有 SmartScreen 警告)|
| GitHub Releases | 免费 | 自动更新分发 |

## 真实需要解决的技术点(不多)

| 问题 | 解法 | 工作量 |
|------|------|--------|
| 跨域 (CORS) | `loadURL` 同域加载,零后端改动 | 0 |
| 登录态持久化 | `partition: 'persist:funature'` | 5 分钟 |
| SSE 长连接 | Electron 原生支持 | 0 |
| 文件上传 | 走原生 file dialog,比浏览器顺 | 0 |
| 系统通知接入 | 后端 SSE event → main process → `Notification` API | 1 天 |
| 全局快捷键 | `globalShortcut.register` | 半天 |
| 后台常驻 | `app.on('window-all-closed')` 不退出 + tray | 半天 |
| 自动更新 | electron-updater + GitHub Releases | 1-2 天 |
| Deep link | `app.setAsDefaultProtocolClient('funature')` | 半天 |
| 离线只读缓存 | 拦截 fetch / SSE 写 IndexedDB,断网回放 | 3-5 天(可选)|

## 启动条件

用户回答上述 4 个决策点 → 我开 Phase 0(1 天验证)→ 用户试用 → 再决定 Phase 1+ 排期。
