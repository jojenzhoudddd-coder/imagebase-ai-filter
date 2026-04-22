/**
 * Idea stream-write sessions (V2 streaming writes).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ Problem                                                              │
 * │ The Agent can generate 100s–1000s of tokens of content to drop into │
 * │ an idea doc. Doing that through dozens of `append_to_idea` tool     │
 * │ round-trips is slow (each tool call = full model re-inference). We  │
 * │ want one "open write channel → stream tokens in → close" bracket.   │
 * │                                                                      │
 * │ Protocol                                                             │
 * │   1) Agent calls begin_idea_stream_write({ideaId, baseVersion,      │
 * │      anchor}) → returns {sessionId, startOffset, baseContent}.      │
 * │      This service records an active session keyed by ideaId (one    │
 * │      active stream per idea — second begin kicks the first).        │
 * │   2) chatAgentService intercepts subsequent model text_delta events │
 * │      and forwards them to `pushDelta(sessionId, text)`. The delta   │
 * │      accumulates in the session buffer and is broadcast on the      │
 * │      per-idea eventBus channel so IdeaEditor can render live.       │
 * │   3) Agent calls end_idea_stream_write({sessionId, finalize}).      │
 * │      `finalize:true` → commit the buffered text into the DB via the │
 * │      same transactional pipeline as POST /api/ideas/:id/write       │
 * │      (mention diff + sections re-extract + version bump). The       │
 * │      authoritative content is broadcast on `idea:stream-finalize`.  │
 * │      `finalize:false` → discard; DB is untouched; FE rolls back to  │
 * │      the pre-stream baseContent.                                    │
 * │                                                                      │
 * │ Safety                                                               │
 * │   • 2-minute inactivity timeout → auto-abort (discard) so a crashed │
 * │     Agent turn can't leave the editor locked forever.               │
 * │   • chatAgentService calls `abortByConversation(convId)` on         │
 * │     abort/error/done to sweep orphan sessions.                      │
 * │   • PUT /api/ideas/:id/content checks `isIdeaLocked(ideaId)` and    │
 * │     rejects concurrent user saves to avoid clobbering the stream.   │
 * │                                                                      │
 * │ Why in-memory                                                        │
 * │   Sessions are ephemeral (seconds to minutes) and tied to a single  │
 * │ Node process. If the backend restarts mid-stream, the FE loses the  │
 * │ SSE connection and re-hydrates from the DB on reconnect — the stream│
 * │ is silently dropped, which is the correct failure mode.             │
 * └──────────────────────────────────────────────────────────────────────┘
 */

import { randomUUID } from "crypto";
import { eventBus } from "./eventBus.js";
import { applyIdeaWrite, type IdeaAnchor } from "./ideaWriteService.js";
import { extractIdeaSections } from "./ideaSections.js";
import { buildMentionRows } from "./mentionIndex.js";
import { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

// Keep a single shared Prisma client (one pool) across this service. We could
// pull from a centralized DI, but the rest of the codebase instantiates
// per-module (see routes/ideaRoutes.ts) and the connection cost is trivial.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/** How long a session can sit idle before we auto-abort it. */
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

export interface IdeaStreamSession {
  sessionId: string;
  ideaId: string;
  workspaceId: string;
  baseVersion: number;
  baseContent: string;
  anchor: IdeaAnchor;
  /** Character offset into baseContent where deltas visually start. FE uses this to splice. */
  startOffset: number;
  /** Accumulated delta text so far. */
  buffer: string;
  createdAt: number;
  updatedAt: number;
  /** Agent/chat context so we can sweep on conversation abort. */
  conversationId: string | null;
  /** SSE clientId for the Agent (matches chatAgentService clientId). */
  clientId: string;
  /** auto-abort timer handle. */
  timer: NodeJS.Timeout;
}

// sessionId → session. Lookup from the MCP `end_idea_stream_write` call + chatAgentService text-delta routing.
const sessions = new Map<string, IdeaStreamSession>();
// ideaId → sessionId. Lookup from PUT /content lock check + "second begin kicks first" semantics.
const ideaToSession = new Map<string, string>();
// conversationId → Set<sessionId>. Lookup for chatAgentService sweep on abort/done.
const conversationToSessions = new Map<string, Set<string>>();

/**
 * Compute where the first delta visually lands. Only three anchor shapes
 * today, matching applyIdeaWrite's contract:
 *   position:end   → content.length
 *   position:start → 0
 *   section:X,mode → at the section boundary (append: bodyEnd, after/replace: bodyStart)
 *
 * This is *visual* offset — the DB commit at finalize runs the full
 * applyIdeaWrite pipeline which may insert surrounding newlines, so the
 * final content may differ by a few chars. That's OK: finalize broadcasts
 * the authoritative content and the FE overwrites its local preview.
 */
function computeStartOffset(content: string, anchor: IdeaAnchor): number {
  if ("position" in anchor) {
    return anchor.position === "start" ? 0 : content.length;
  }
  const sections = extractIdeaSections(content);
  const idx = sections.findIndex((s) => s.slug === anchor.section);
  if (idx === -1) {
    const available = sections.map((s) => s.slug).join(", ") || "(no headings)";
    throw new Error(`Section "${anchor.section}" not found. Available sections: ${available}`);
  }
  // Re-scan lines to find absolute char offset of this heading.
  const lines = content.split(/\r?\n/);
  const lineStarts: number[] = [];
  let acc = 0;
  for (const l of lines) { lineStarts.push(acc); acc += l.length + 1; }
  const isFence = (l: string) => /^\s{0,3}(`{3,}|~{3,})/.test(l);
  const headingRe = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
  let inFence = false;
  let cursor = 0;
  let bodyStart = 0;
  let bodyEnd = content.length;
  let foundIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFence(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!headingRe.test(line)) continue;
    if (cursor === idx) {
      bodyStart = Math.min(lineStarts[i] + line.length + 1, content.length);
      foundIdx = i;
    } else if (foundIdx !== -1 && cursor === idx + 1) {
      bodyEnd = Math.min(lineStarts[i], content.length);
      break;
    }
    cursor++;
  }
  if (foundIdx === -1) return content.length; // defensive fallback
  const mode = anchor.mode ?? "append";
  if (mode === "append") return bodyEnd;
  return bodyStart; // after / replace
}

/** Broadcast helper — all three stream event types flow through emitIdeaChange so FE only needs one subscription. */
function broadcast(
  session: IdeaStreamSession,
  type: "idea:stream-begin" | "idea:stream-delta" | "idea:stream-finalize",
  payload: Record<string, unknown>
): void {
  eventBus.emitIdeaChange({
    type,
    ideaId: session.ideaId,
    clientId: session.clientId,
    timestamp: Date.now(),
    payload,
  });
}

/** Schedule (or reset) the idle auto-abort timer. */
function armIdleTimer(session: IdeaStreamSession): void {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    // Auto-abort — log via console for observability; cleanup is silent otherwise.
    console.warn(`[ideaStream] session ${session.sessionId} idle ${SESSION_IDLE_TIMEOUT_MS}ms → auto-abort`);
    abort(session.sessionId, "timeout");
  }, SESSION_IDLE_TIMEOUT_MS);
  // Don't hold the event loop open solely for this timer.
  (session.timer as any).unref?.();
}

export interface BeginInput {
  ideaId: string;
  workspaceId: string;
  baseVersion: number;
  anchor: IdeaAnchor;
  conversationId?: string | null;
  clientId: string;
}

export interface BeginResult {
  sessionId: string;
  startOffset: number;
  baseContent: string;
  baseVersion: number;
}

/**
 * Open a streaming write session. If `ideaId` already has an active session,
 * the old one is aborted (discarded) first — "last begin wins" matches user
 * expectation (agent retrying). Version check rejects stale writes so we
 * don't commit onto a doc someone else already edited.
 */
export async function begin(input: BeginInput): Promise<BeginResult> {
  const idea = await prisma.idea.findUnique({
    where: { id: input.ideaId },
    select: { id: true, content: true, version: true, workspaceId: true },
  });
  if (!idea) throw new Error(`Idea not found: ${input.ideaId}`);
  if (idea.version !== input.baseVersion) {
    throw new Error(
      `Stale baseVersion: got ${input.baseVersion}, current ${idea.version}. Re-read the idea and try again.`
    );
  }

  // Evict any prior session on the same idea — agent retry.
  const priorId = ideaToSession.get(input.ideaId);
  if (priorId) {
    abort(priorId, "superseded");
  }

  const sessionId = `stream_${randomUUID()}`;
  const baseContent = idea.content ?? "";
  const startOffset = computeStartOffset(baseContent, input.anchor);

  const session: IdeaStreamSession = {
    sessionId,
    ideaId: input.ideaId,
    workspaceId: input.workspaceId,
    baseVersion: input.baseVersion,
    baseContent,
    anchor: input.anchor,
    startOffset,
    buffer: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    conversationId: input.conversationId ?? null,
    clientId: input.clientId,
    timer: null as any, // assigned by armIdleTimer below
  };
  sessions.set(sessionId, session);
  ideaToSession.set(input.ideaId, sessionId);
  if (input.conversationId) {
    const set = conversationToSessions.get(input.conversationId) ?? new Set();
    set.add(sessionId);
    conversationToSessions.set(input.conversationId, set);
  }
  armIdleTimer(session);

  broadcast(session, "idea:stream-begin", {
    sessionId,
    startOffset,
    anchor: input.anchor,
    baseVersion: input.baseVersion,
  });

  console.log(
    `[ideaStream] begin session=${sessionId} idea=${input.ideaId} startOffset=${startOffset} baseVersion=${input.baseVersion}`
  );
  return { sessionId, startOffset, baseContent, baseVersion: input.baseVersion };
}

/**
 * Append a text chunk from the model's stream into the session buffer +
 * broadcast to all SSE subscribers on the idea channel. Called by
 * chatAgentService from inside the text_delta handler; idempotent-ish
 * (same delta twice = duplicate content, but that's a provider bug).
 */
export function pushDelta(sessionId: string, delta: string): void {
  const session = sessions.get(sessionId);
  if (!session) return; // session was aborted/ended already — silently drop
  if (!delta) return;
  session.buffer += delta;
  session.updatedAt = Date.now();
  armIdleTimer(session); // reset idle clock
  broadcast(session, "idea:stream-delta", {
    sessionId,
    delta,
    bufferLength: session.buffer.length,
  });
}

/**
 * Close a session. `commit:true` writes the accumulated buffer into the
 * idea via the same transactional pipeline as POST /api/ideas/:id/write
 * (content + version bump + mention diff + sections re-extract). On any
 * write error, we still emit a stream-finalize event so the FE can exit
 * streaming mode, but with `discarded:true`.
 *
 * Returns the new version (when committed) so the Agent gets accurate
 * feedback for subsequent tool calls.
 */
export async function finalize(
  sessionId: string,
  opts: { commit: boolean }
): Promise<{ ok: boolean; newVersion?: number; discarded: boolean; reason?: string }> {
  const session = sessions.get(sessionId);
  if (!session) {
    return { ok: false, discarded: true, reason: "session not found (already ended?)" };
  }

  // Always clear timers + index entries first so we don't double-commit.
  const { ideaId, conversationId, buffer, baseContent, anchor, workspaceId } = session;
  clearTimeout(session.timer);
  sessions.delete(sessionId);
  if (ideaToSession.get(ideaId) === sessionId) ideaToSession.delete(ideaId);
  if (conversationId) {
    const set = conversationToSessions.get(conversationId);
    if (set) {
      set.delete(sessionId);
      if (set.size === 0) conversationToSessions.delete(conversationId);
    }
  }

  if (!opts.commit || buffer.length === 0) {
    // Discard path — no DB write. Broadcast finalize so FE rolls back local preview.
    broadcast(session, "idea:stream-finalize", {
      sessionId,
      discarded: true,
      finalContent: baseContent,
      newVersion: session.baseVersion,
      reason: buffer.length === 0 ? "empty" : "discarded",
    });
    console.log(
      `[ideaStream] finalize session=${sessionId} discarded=true bufferLen=${buffer.length}`
    );
    return { ok: true, discarded: true, newVersion: session.baseVersion, reason: buffer.length === 0 ? "empty" : "discarded" };
  }

  // Commit path — apply the buffered text at the requested anchor and persist.
  try {
    const { content: finalContent } = applyIdeaWrite(baseContent, anchor, buffer);
    const sectionsJson = extractIdeaSections(finalContent) as unknown as any;

    const result = await prisma.$transaction(async (tx: any) => {
      const updated = await tx.idea.update({
        where: { id: ideaId },
        data: {
          content: finalContent,
          sections: sectionsJson,
          version: { increment: 1 },
        },
        select: { id: true, version: true },
      });
      await tx.mention.deleteMany({ where: { sourceType: "idea", sourceId: ideaId } });
      const rows = buildMentionRows(finalContent, "idea", ideaId, workspaceId);
      if (rows.length > 0) {
        await tx.mention.createMany({ data: rows });
      }
      return updated;
    });

    broadcast(session, "idea:stream-finalize", {
      sessionId,
      discarded: false,
      finalContent,
      newVersion: result.version,
    });
    // Also emit a regular content-change event so non-stream subscribers
    // (e.g. a second tab opened by the user on the same idea) refresh.
    eventBus.emitIdeaChange({
      type: "idea:content-change",
      ideaId,
      clientId: session.clientId,
      timestamp: Date.now(),
      payload: { content: finalContent, version: result.version },
    });
    console.log(
      `[ideaStream] finalize session=${sessionId} commit=true v${session.baseVersion}→v${result.version} bufferLen=${buffer.length}`
    );
    return { ok: true, discarded: false, newVersion: result.version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ideaStream] finalize session=${sessionId} commit failed:`, msg);
    broadcast(session, "idea:stream-finalize", {
      sessionId,
      discarded: true,
      finalContent: baseContent,
      newVersion: session.baseVersion,
      reason: `commit failed: ${msg}`,
    });
    return { ok: false, discarded: true, newVersion: session.baseVersion, reason: msg };
  }
}

/**
 * Force-end a session without committing. Safe to call on a session that's
 * already gone (returns silently). Used by the idle timer and by
 * chatAgentService sweep paths (abort/error/forgot-to-end).
 */
export function abort(sessionId: string, reason: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  // finalize handles cleanup + broadcast — just call it with commit:false.
  // Ignore the returned promise; broadcast side-effects are what matter.
  finalize(sessionId, { commit: false }).catch((err) => {
    console.error(`[ideaStream] abort(${sessionId}) finalize threw:`, err);
  });
  console.log(`[ideaStream] abort session=${sessionId} reason=${reason}`);
}

/**
 * Sweep all sessions belonging to a conversation — chatAgentService calls
 * this on turn-end / abort / error so a forgotten end_idea_stream_write
 * doesn't leave the editor locked.
 */
export function abortByConversation(conversationId: string, reason: string): void {
  const set = conversationToSessions.get(conversationId);
  if (!set || set.size === 0) return;
  console.log(
    `[ideaStream] abortByConversation ${conversationId} reason=${reason} count=${set.size}`
  );
  for (const sessionId of Array.from(set)) {
    abort(sessionId, reason);
  }
}

/**
 * Attach a conversationId to a session *after* `begin` — used when the begin
 * call flows through the MCP server (separate process) which can't supply
 * chatAgentService's in-process conversation id. chatAgentService calls this
 * right after parsing the tool result so `abortByConversation()` sweeps can
 * find the session on turn-end.
 */
export function attachConversation(sessionId: string, conversationId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.conversationId && session.conversationId !== conversationId) {
    // Detach from old bucket first.
    const old = conversationToSessions.get(session.conversationId);
    if (old) {
      old.delete(sessionId);
      if (old.size === 0) conversationToSessions.delete(session.conversationId);
    }
  }
  session.conversationId = conversationId;
  const set = conversationToSessions.get(conversationId) ?? new Set<string>();
  set.add(sessionId);
  conversationToSessions.set(conversationId, set);
}

/** Called by PUT /api/ideas/:id/content to reject concurrent user writes during an active stream. */
export function isIdeaLocked(ideaId: string): string | null {
  return ideaToSession.get(ideaId) ?? null;
}

/** Test / observability hook. */
export function getSession(sessionId: string): IdeaStreamSession | undefined {
  return sessions.get(sessionId);
}
