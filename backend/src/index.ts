import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import tableRoutes from "./routes/tableRoutes.js";
import aiRoutes from "./routes/aiRoutes.js";
import sseRoutes from "./routes/sseRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import folderRoutes from "./routes/folderRoutes.js";
import agentRoutes from "./routes/agentRoutes.js";
import designRoutes from "./routes/designRoutes.js";
import tasteRoutes from "./routes/tasteRoutes.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { mockTable } from "./mockData.js";
import { connectDB, loadTable, getTable, getWorkspace, updateWorkspace, listTablesForWorkspace, ensureDefaults } from "./services/dbStore.js";
import { eventBus } from "./services/eventBus.js";
import { startSuggestionScheduler } from "./services/suggestionService.js";
import { ensureDefaultAgent } from "./services/agentService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// Prisma client for tree queries (folders, designs)
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const treePrisma = new PrismaClient({ adapter } as any);

app.use(cors());
app.use(express.json());

// ── Request logging middleware ──
function gmt8() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 23);
}
app.use("/api", (req, res, next) => {
  // Skip SSE and health check from verbose logging
  if (req.path.includes("/events") || req.path === "/health") return next();

  const start = Date.now();
  const clientId = req.headers["x-client-id"] || "-";
  const method = req.method;
  const path = req.originalUrl;

  // Log request body for mutations
  if (method !== "GET") {
    const bodySnippet = JSON.stringify(req.body).slice(0, 500);
    console.log(`[${gmt8()}] → ${method} ${path} client=${clientId} body=${bodySnippet}`);
  }

  // Capture response
  const origJson = res.json.bind(res);
  res.json = (body: any) => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const respSnippet = JSON.stringify(body).slice(0, 300);
    const level = status >= 400 ? "⚠️" : "✓";
    console.log(`[${gmt8()}] ${level} ${method} ${path} → ${status} (${ms}ms) client=${clientId} resp=${respSnippet}`);
    return origJson(body);
  };

  next();
});

app.use("/api/tables", tableRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/sync", sseRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/folders", folderRoutes);
app.use("/api/agents", agentRoutes);
// designRoutes 和 tasteRoutes 都挂在 /api/designs 下：
//  - designRoutes: 基础 CRUD (POST /, PUT /:designId, DELETE /:designId, PUT /reorder)
//  - tasteRoutes : /:designId/tastes/* (upload / from-figma / batch-update / 单条 CRUD / source)
// 路径不冲突，Express 会按 handler 顺序匹配。
app.use("/api/designs", designRoutes);
app.use("/api/designs", tasteRoutes);

// Serve uploaded SVG files
app.use("/uploads", express.static(path.resolve(__dirname, "../../uploads")));

// ═══════ Workspace API ═══════

// GET /api/workspaces/:workspaceId
app.get("/api/workspaces/:workspaceId", async (req, res) => {
  const ws = await getWorkspace(req.params.workspaceId);
  if (!ws) { res.status(404).json({ error: "Workspace not found" }); return; }
  res.json(ws);
});

// PUT /api/workspaces/:workspaceId — rename workspace
app.put("/api/workspaces/:workspaceId", async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "工作空间名不能为空" }); return;
  }
  const ws = await updateWorkspace(req.params.workspaceId, { name: name.trim() });
  if (!ws) { res.status(404).json({ error: "Workspace not found" }); return; }
  const clientId = (req.headers["x-client-id"] as string) || "unknown";
  // Broadcast to all tables under this workspace
  eventBus.emitChange({
    type: "workspace:update",
    tableId: "tbl_requirements", // primary table for SSE channel
    clientId,
    timestamp: Date.now(),
    payload: { workspaceId: ws.id, name: ws.name },
  });
  res.json(ws);
});

// GET /api/workspaces/:workspaceId/tables — list tables in workspace
app.get("/api/workspaces/:workspaceId/tables", async (req, res) => {
  const tables = await listTablesForWorkspace(req.params.workspaceId);
  res.json(tables);
});

// GET /api/workspaces/:workspaceId/tree — full tree (folders + tables + designs)
app.get("/api/workspaces/:workspaceId/tree", async (req, res) => {
  try {
    const wsId = req.params.workspaceId;
    const [folders, tables, designs] = await Promise.all([
      treePrisma.folder.findMany({ where: { workspaceId: wsId }, orderBy: { order: "asc" } }),
      treePrisma.table.findMany({ where: { workspaceId: wsId }, orderBy: { order: "asc" } }),
      treePrisma.design.findMany({ where: { workspaceId: wsId }, orderBy: { order: "asc" } }),
    ]);
    res.json({ folders, tables, designs });
  } catch (err: any) {
    console.error("[tree] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// Serve frontend static files in production
const publicDir = path.resolve(__dirname, "../../frontend/dist");
app.use(express.static(publicDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

async function start() {
  // Connect to PostgreSQL
  await connectDB();
  console.log("Connected to PostgreSQL");

  // Seed mock data only if the table doesn't exist yet
  const existing = await getTable(mockTable.id);
  if (!existing) {
    await loadTable(mockTable);
    console.log("Mock data seeded (first run)");
  } else {
    console.log("Table already exists, skipping seed");
  }

  // Ensure the default Agent exists (DB row + identity filesystem).
  // ensureDefaults() seeds the default user/org/workspace the agent depends on.
  try {
    await ensureDefaults();
    const agent = await ensureDefaultAgent();
    console.log(`Default agent ready: ${agent.id} (${agent.name})`);
  } catch (err) {
    console.error("Failed to ensure default agent:", err);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`AI Filter running on http://0.0.0.0:${PORT}`);
  });

  // Kick off the chat-sidebar prompt-suggestion scheduler. Runs an initial
  // pass on `doc_default` after a short delay and refreshes every 10 min.
  startSuggestionScheduler(["doc_default"]);
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
