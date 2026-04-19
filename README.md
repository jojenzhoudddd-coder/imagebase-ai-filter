# AI Filter for Lark Base

飞书多维表格 AI 智能筛选 Demo - 通过自然语言生成表格筛选条件

## 功能特性

- 多维表格视图，支持列拖拽排序、列宽调整、单元格编辑
- 手动筛选：支持多字段、多操作符、AND/OR 逻辑组合
- AI 智能筛选：输入自然语言，自动生成筛选条件
- 支持字段类型：文本、单选、多选、日期、数字、用户、复选框

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

### 使用 Claude Code 开发

1. 安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)：
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

2. 进入项目目录并启动：
   ```bash
   cd ai-filter-lark
   claude
   ```

3. Claude Code 会自动读取项目中的 `CLAUDE.md` 了解项目结构和开发规范，你可以直接用自然语言描述需求，例如：
   - "添加一个新的字段类型：评分"
   - "修复筛选面板中日期选择的 bug"
   - "优化表格大数据量下的渲染性能"

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
| AI | Volcano ARK Responses API |
| 部署 | Nginx + PM2 |

## 项目结构

```
├── backend/            # 后端服务
│   ├── src/
│   │   ├── index.ts          # 服务入口
│   │   ├── mockData.ts       # 模拟数据
│   │   ├── routes/           # API 路由
│   │   └── services/         # 业务逻辑（AI、筛选、数据存储）
│   └── .env.example          # 环境变量模板
├── frontend/           # 前端应用
│   ├── src/
│   │   ├── App.tsx           # 主组件
│   │   ├── components/       # UI 组件
│   │   └── services/         # 客户端筛选引擎
│   └── vite.config.ts
├── CLAUDE.md           # Claude Code 项目指南
└── package.json        # 根目录脚本
```

## License

MIT
