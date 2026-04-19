/**
 * /api/chat/* routes — Table Agent chat endpoints.
 *
 * REST:
 *   GET    /api/chat/conversations?documentId=xxx  — list conversations
 *   POST   /api/chat/conversations                  — create conversation { documentId }
 *   GET    /api/chat/conversations/:id/messages     — fetch message history
 *   DELETE /api/chat/conversations/:id              — delete conversation
 *
 * SSE:
 *   POST   /api/chat/conversations/:id/messages     — send user message, stream response
 *   POST   /api/chat/conversations/:id/confirm      — resolve pending danger-tool
 *   POST   /api/chat/conversations/:id/stop         — abort the current streaming turn
 */

import express, { type Request, type Response } from "express";
import * as convStore from "../services/conversationStore.js";
import { runAgent, resumeAfterConfirm, type AgentContext, type SseEvent } from "../services/chatAgentService.js";
import * as store from "../services/dbStore.js";
import {
  getSuggestions,
  refreshSuggestions,
  DEFAULT_SUGGESTIONS,
} from "../services/suggestionService.js";

const router = express.Router();

// ─── Per-conversation ephemeral state (stored in the running server) ─────
// Aborts + pending confirmations are not persisted — they are ephemeral to
// the lifetime of a streaming turn.

interface TurnState {
  abortController: AbortController;
  pendingConfirmations: Map<string, { tool: string; args: Record<string, unknown> }>;
}

const turnStates = new Map<string, TurnState>();

function getOrCreateTurnState(conversationId: string): TurnState {
  let state = turnStates.get(conversationId);
  if (!state) {
    state = {
      abortController: new AbortController(),
      pendingConfirmations: new Map(),
    };
    turnStates.set(conversationId, state);
  }
  return state;
}

function resetAbortController(conversationId: string): AbortController {
  const state = getOrCreateTurnState(conversationId);
  state.abortController = new AbortController();
  return state.abortController;
}

// ─── SSE helpers ─────────────────────────────────────────────────────────

function setupSse(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function writeEvent(res: Response, e: SseEvent) {
  res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
}

// ─── REST endpoints ──────────────────────────────────────────────────────

// GET /api/chat/context-snapshot?documentId=xxx
// Thin summary of the current document — used by the chat sidebar's
// "refresh / new conversation" flow to render a "已加载 N 张表、M 个字段"
// hint so the user knows what the Agent will see before their first prompt.
// The full context (Document Snapshot) is still built inside chatAgentService
// on each message; this endpoint is purely a UX warm-up.
router.get("/context-snapshot", async (req: Request, res: Response) => {
  const documentId = (req.query.documentId as string) || "doc_default";
  try {
    const tables = await store.listTablesForDocument(documentId);
    let fieldCount = 0;
    let recordCount = 0;
    for (const t of tables) {
      const detail = await store.getTable(t.id);
      if (!detail) continue;
      fieldCount += detail.fields.length;
      recordCount += detail.records.length;
    }
    res.json({
      documentId,
      tableCount: tables.length,
      fieldCount,
      recordCount,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to build context snapshot",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// GET /api/chat/suggestions?documentId=xxx
// Returns the cached 3-5 AI-generated prompt suggestions for the document's
// welcome page. On cache-miss, kicks off an async refresh and returns
// defaults so the UI never shows an empty state.
router.get("/suggestions", (req: Request, res: Response) => {
  const documentId = (req.query.documentId as string) || "doc_default";
  const entry = getSuggestions(documentId);
  if (entry) {
    res.json({
      documentId,
      suggestions: entry.suggestions,
      updatedAt: entry.updatedAt,
      stale: false,
    });
    return;
  }
  // Fire-and-forget refresh so the next call is warm
  void refreshSuggestions(documentId);
  res.json({
    documentId,
    suggestions: DEFAULT_SUGGESTIONS,
    updatedAt: 0,
    stale: true,
  });
});

// POST /api/chat/suggestions/refresh
// Force-refresh hook (e.g. after significant document edits). Returns the
// freshly generated pack once ready — the scheduler will also pick it up on
// its next tick, this is just an impatient shortcut.
router.post("/suggestions/refresh", async (req: Request, res: Response) => {
  const { documentId = "doc_default" } = (req.body as { documentId?: string }) || {};
  try {
    const suggestions = await refreshSuggestions(documentId);
    const entry = getSuggestions(documentId);
    res.json({
      documentId,
      suggestions,
      updatedAt: entry?.updatedAt ?? Date.now(),
      stale: false,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to refresh suggestions",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// GET /api/chat/conversations?documentId=xxx
router.get("/conversations", async (req: Request, res: Response) => {
  const documentId = (req.query.documentId as string) || "doc_default";
  const list = await convStore.listConversations(documentId);
  res.json(list);
});

// POST /api/chat/conversations
router.post("/conversations", async (req: Request, res: Response) => {
  const { documentId } = req.body as { documentId?: string };
  if (!documentId) {
    res.status(400).json({ error: "documentId is required" });
    return;
  }
  const conv = await convStore.createConversation(documentId);
  res.json(conv);
});

// GET /api/chat/conversations/:id/messages
router.get("/conversations/:id/messages", async (req: Request, res: Response) => {
  const conv = await convStore.getConversation(req.params.id);
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const messages = await convStore.getMessages(req.params.id);
  res.json({ conversation: conv, messages });
});

// DELETE /api/chat/conversations/:id
router.delete("/conversations/:id", async (req: Request, res: Response) => {
  const ok = await convStore.deleteConversation(req.params.id);
  turnStates.delete(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.json({ ok: true });
});

// ─── SSE: send message ──────────────────────────────────────────────────
// POST /api/chat/conversations/:id/messages
// Body: { message: string }
router.post("/conversations/:id/messages", async (req: Request, res: Response) => {
  const conv = await convStore.getConversation(req.params.id);
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const { message } = req.body as { message?: string };
  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  setupSse(res);

  const state = getOrCreateTurnState(req.params.id);
  const ac = resetAbortController(req.params.id);

  // Client disconnect → abort
  // Detect client disconnect during response streaming. For POST requests
  // with a body, `req.on("close")` can fire once the body is consumed —
  // which is immediate for us. `res.on("close")` only fires when the
  // response connection is actually closed.
  let responseEnded = false;
  res.on("close", () => {
    if (!responseEnded) ac.abort();
  });

  const ctx: AgentContext = {
    conversationId: req.params.id,
    documentId: conv.documentId,
    pendingConfirmations: state.pendingConfirmations,
  };

  try {
    for await (const event of runAgent(ctx, message.trim(), ac.signal)) {
      writeEvent(res, event);
    }
  } catch (err) {
    writeEvent(res, {
      event: "error",
      data: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    responseEnded = true;
    res.end();
  }
});

// ─── SSE: confirm danger tool ──────────────────────────────────────────
// POST /api/chat/conversations/:id/confirm
// Body: { callId: string, confirmed: boolean }
router.post("/conversations/:id/confirm", async (req: Request, res: Response) => {
  const conv = await convStore.getConversation(req.params.id);
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const { callId, confirmed } = req.body as { callId?: string; confirmed?: boolean };
  if (!callId || typeof confirmed !== "boolean") {
    res.status(400).json({ error: "callId and confirmed are required" });
    return;
  }

  setupSse(res);

  const state = getOrCreateTurnState(req.params.id);
  const ac = resetAbortController(req.params.id);
  // See /messages handler for why res.on("close") is preferred over req.on("close").
  let responseEnded = false;
  res.on("close", () => {
    if (!responseEnded) ac.abort();
  });

  const ctx: AgentContext = {
    conversationId: req.params.id,
    documentId: conv.documentId,
    pendingConfirmations: state.pendingConfirmations,
  };

  try {
    for await (const event of resumeAfterConfirm(ctx, callId, confirmed, ac.signal)) {
      writeEvent(res, event);
    }
  } catch (err) {
    writeEvent(res, {
      event: "error",
      data: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    responseEnded = true;
    res.end();
  }
});

// ─── Stop current turn ──────────────────────────────────────────────────
// POST /api/chat/conversations/:id/stop
router.post("/conversations/:id/stop", (req: Request, res: Response) => {
  const state = turnStates.get(req.params.id);
  if (state) {
    state.abortController.abort();
  }
  res.json({ ok: true });
});

export default router;
