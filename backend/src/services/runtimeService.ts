/**
 * runtimeService — the Agent's always-on background loop.
 *
 * Phase 4 Day 1 scope (this file):
 *   - A single setInterval-based heartbeat that ticks every
 *     RUNTIME_HEARTBEAT_MS (default 5 min) and logs one entry per agent
 *     into state/heartbeat.log.
 *   - Per-tick fanout: for each agent row in the DB, run the configured
 *     `onTick` handler. The default handler is a no-op — downstream days
 *     (Cron / Inbox / Consolidator) will register real handlers.
 *   - No LLM calls. Everything on this path must stay cheap: a stuck
 *     Volcano ARK endpoint should not stall the heartbeat loop.
 *
 * Intentionally *not* in scope yet:
 *   - Cron schedule evaluation (Day 2)
 *   - Inbox message fanout into conversations (Day 2-3)
 *   - Haiku-driven "should I wake the user?" triage (Day 3+)
 *
 * Design notes:
 *   - Re-entrancy: if a tick is still running when the next interval fires
 *     (e.g. filesystem was slow or a handler blocked), we skip the new tick
 *     rather than stacking. `tickInFlight` is the guard. Better to miss a
 *     tick than to double-fire and corrupt heartbeat.log.
 *   - Graceful shutdown: stopHeartbeat() clears the interval and waits for
 *     any in-flight tick to settle. Tests and PM2 reloads rely on this.
 *   - Error isolation: one agent's broken handler must not starve the
 *     others. Each agent tick runs inside try/catch and logs an "error"
 *     entry to its own log file.
 *
 * See docs/chatbot-openclaw-plan.md §6 and §9 Phase 4 for the broader plan.
 */

import { randomUUID } from "crypto";
import {
  listAllAgents,
  appendHeartbeatLog,
  type AgentMeta,
  type HeartbeatLogEntry,
} from "./agentService.js";

/** Tick handler run once per agent per tick. Must be cheap + total. */
export type TickHandler = (ctx: TickContext) => Promise<TickResult>;

export interface TickContext {
  agentId: string;
  tickId: string;
  firedAt: Date;
}

export interface TickResult {
  outcome: "idle" | "triggered";
  details?: Record<string, unknown>;
}

export interface RuntimeOptions {
  /** Interval between ticks, in ms. Defaults to RUNTIME_HEARTBEAT_MS env or 5 min. */
  intervalMs?: number;
  /** Per-agent handler. Defaults to a no-op that returns `idle`. */
  onTick?: TickHandler;
  /** Optional logger; defaults to console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
  /**
   * Source of agents to tick. Defaults to `listAllAgents()` (DB). Tests can
   * inject a synthetic list so the smoke path doesn't require Postgres.
   */
  listAgents?: () => Promise<Pick<AgentMeta, "id">[]>;
}

interface RuntimeState {
  intervalMs: number;
  handler: TickHandler;
  logger: Pick<Console, "log" | "warn" | "error">;
  listAgents: () => Promise<Pick<AgentMeta, "id">[]>;
  timer: NodeJS.Timeout | null;
  tickInFlight: Promise<void> | null;
  /** Number of ticks fired since startHeartbeat() was called. For smoke tests. */
  ticksFired: number;
}

let state: RuntimeState | null = null;

const DEFAULT_INTERVAL_MS = (() => {
  const raw = process.env.RUNTIME_HEARTBEAT_MS;
  if (!raw) return 5 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1000 ? n : 5 * 60 * 1000;
})();

const NOOP_HANDLER: TickHandler = async () => ({ outcome: "idle" });

/**
 * Start the heartbeat loop. Safe to call multiple times — subsequent calls
 * are no-ops (returns the already-running state so callers can inspect it).
 */
export function startHeartbeat(opts: RuntimeOptions = {}): Readonly<RuntimeState> {
  if (state) return state;

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const handler = opts.onTick ?? NOOP_HANDLER;
  const logger = opts.logger ?? console;
  const listAgentsFn = opts.listAgents ?? listAllAgents;

  const local: RuntimeState = {
    intervalMs,
    handler,
    logger,
    listAgents: listAgentsFn,
    timer: null,
    tickInFlight: null,
    ticksFired: 0,
  };
  state = local;

  logger.log(`[runtime] heartbeat starting — interval=${intervalMs}ms`);

  // Fire-and-forget arming: we don't run an immediate tick on start because
  // PM2 reloads would otherwise double-fire during overlap. The user can
  // force an immediate tick via `tickNow()` in tests.
  local.timer = setInterval(() => {
    if (local.tickInFlight) {
      // Still processing the previous tick — skip to avoid stacking.
      logger.warn("[runtime] tick skipped: previous tick still in flight");
      return;
    }
    local.tickInFlight = runOneTick(local).finally(() => {
      local.tickInFlight = null;
    });
  }, intervalMs);

  // Don't keep the Node event loop alive solely for the heartbeat — the
  // Express server is what should be holding the process open. If Express
  // shuts down, the heartbeat should let the process exit cleanly.
  if (typeof local.timer.unref === "function") local.timer.unref();

  return local;
}

/**
 * Stop the heartbeat loop. Resolves only after any in-flight tick settles.
 * Always safe to call (no-op if not running).
 */
export async function stopHeartbeat(): Promise<void> {
  const local = state;
  if (!local) return;
  if (local.timer) {
    clearInterval(local.timer);
    local.timer = null;
  }
  if (local.tickInFlight) {
    try {
      await local.tickInFlight;
    } catch {
      // Already logged inside runOneTick; don't leak into shutdown path.
    }
  }
  local.logger.log(`[runtime] heartbeat stopped (${local.ticksFired} ticks fired)`);
  state = null;
}

/**
 * Force one immediate tick. Primary use: smoke tests and manual triggering.
 * Respects the in-flight guard — returns whatever the already-running tick
 * resolves to if called concurrently.
 */
export async function tickNow(): Promise<void> {
  if (!state) throw new Error("runtime not started");
  const local = state;
  if (local.tickInFlight) {
    await local.tickInFlight;
    return;
  }
  local.tickInFlight = runOneTick(local).finally(() => {
    local.tickInFlight = null;
  });
  await local.tickInFlight;
}

/** Inspect current runtime state. Returns null when heartbeat isn't running. */
export function getRuntimeState(): Pick<RuntimeState, "intervalMs" | "ticksFired"> | null {
  if (!state) return null;
  return { intervalMs: state.intervalMs, ticksFired: state.ticksFired };
}

async function runOneTick(local: RuntimeState): Promise<void> {
  local.ticksFired += 1;
  const firedAt = new Date();
  const tickId = randomUUID();

  let agents: Pick<AgentMeta, "id">[] = [];
  try {
    agents = await local.listAgents();
  } catch (err: any) {
    local.logger.error(`[runtime] tick ${tickId}: listAgents failed: ${err?.message ?? err}`);
    return;
  }

  // Run all per-agent ticks in parallel. This is fine at our scale (default
  // agent is 1, even with multi-user the count is small). If it ever grows
  // into the thousands we'd want a worker pool + rate-limit.
  await Promise.all(
    agents.map(async (a) => {
      const ctx: TickContext = { agentId: a.id, tickId, firedAt };
      let entry: HeartbeatLogEntry;
      try {
        const result = await local.handler(ctx);
        entry = {
          timestamp: firedAt.toISOString(),
          tickId,
          outcome: result.outcome,
          details: result.details,
        };
      } catch (err: any) {
        entry = {
          timestamp: firedAt.toISOString(),
          tickId,
          outcome: "error",
          details: { message: err?.message ?? String(err) },
        };
        local.logger.error(
          `[runtime] tick ${tickId}: handler error for agent ${a.id}: ${err?.message ?? err}`
        );
      }
      try {
        await appendHeartbeatLog(a.id, entry);
      } catch (err: any) {
        // If we can't even write the log, there's nothing sensible to do
        // beyond logging to stderr. The next tick will try again.
        local.logger.error(
          `[runtime] tick ${tickId}: failed to append heartbeat log for ${a.id}: ${err?.message ?? err}`
        );
      }
    })
  );
}
