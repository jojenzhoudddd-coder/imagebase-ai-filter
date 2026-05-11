# Funature

> **Fu**ture + **Nature** — 面向未来的原生 AI 平台

## 愿景

Funature 覆盖三大板块：

| 板块 | 定位 | 状态 |
|------|------|------|
| **Work** | AI-native 多维表格 + 文档 + 画布 + Demo | ✅ 已实现 |
| **Home** | AI-native 生活空间 | 🔮 规划中 |
| **Muse** | AI-native 创意工作室 | 🔮 规划中 |

## 功能特性（Work 板块）

- 多维表格视图，支持列拖拽排序、列宽调整、单元格编辑
- AI 智能筛选 / 排序：输入自然语言，自动生成条件
- AI 数据分析（Analyst）：DuckDB 引擎 + 多领域 skill（互联网/财务/金融）
- 文档（Idea）：Markdown 双模编辑器（CodeMirror + Tiptap）
- 画布（Taste/Design）：SVG 可视化画布
- Vibe Demo：AI 生成可运行前端应用
- Agent 系统：多模型（doubao/Claude/GPT-5）、记忆、技能、习惯、知识库
- Magic Canvas：多 block 自由布局仪表盘

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/jojenzhoudddd-coder/ai-filter-lark.git
cd ai-filter-lark

# 安装依赖
npm run install:all

# 配置环境变量
cp backend/.env.example backend/.env
# 编辑 backend/.env，填入你的 Volcano ARK API Key

# 启动开发环境（前后端同时启动）
npm run dev
```

启动后访问 http://localhost:5173

### 生产部署

```bash
# 构建前端
npm run build

# 启动生产服务（后端同时提供前端静态文件）
npm run start
```

## 在线体验

https://www.imagebase.cc

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + TypeScript + Vite |
| 后端 | Express + TypeScript + tsx |
| 编辑器 | CodeMirror + Tiptap/ProseMirror |
| AI | Volcano ARK / OneAPI (Claude, GPT-5) |
| 数据分析 | DuckDB + Parquet |
| 部署 | Nginx + PM2 |

## 项目结构

```
├── backend/            # 后端服务
│   ├── src/
│   │   ├── index.ts          # 服务入口
│   │   ├── routes/           # API 路由
│   │   ├── services/         # 业务逻辑
│   │   └── mcp-server/       # MCP 工具层
│   └── .env.example          # 环境变量模板
├── frontend/           # 前端应用
│   ├── src/
│   │   ├── App.tsx           # 主组件
│   │   ├── components/       # UI 组件
│   │   ├── canvas/           # Magic Canvas 布局引擎
│   │   └── i18n/             # 国际化（中/英）
│   └── vite.config.ts
├── docs/               # 设计文档 & 技术方案
├── CLAUDE.md           # Claude Code 项目指南
└── package.json        # 根目录脚本
```

## License

MIT
