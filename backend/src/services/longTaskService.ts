/**
 * Long-task service — chatbot-wide infrastructure for workflow-style tools.
 *
 * Any MCP tool can report progress via `ctx.progress({phase, pct, message})`.
 * The chat agent forwards these to the client as SSE `tool_progress` events,
 * and synthesizes `tool_heartbeat` events during prolonged silence so
 * intermediate proxies (nginx, browser) keep the connection warm.
 *
 * This module is transport-agnostic: it provides the per-call state machine
 * (start / progress / heartbeat / complete / timeout), the SSE format
 * conventions (through type-only exports), and a small interface the agent
 * loop plugs into.
 */

export interface ProgressPayload {
  /** Coarse phase label — planning / computing / finalizing by convention. */
  phase?: string;
  /** Optional 0..1 fraction — omit when the work has no quantifiable total. */
  progress?: number;
  /** Free-text human message. */
  message: string;
  /** Optional, for cardinality-based work: current/total. */
  current?: number;
  total?: number;
}

export interface ProgressEvent extends ProgressPayload {
  callId: string;
  elapsedMs: number;
}

export interface HeartbeatEvent {
  callId: string;
  elapsedMs: number;
}

export interface LongTaskState {
  callId: string;
  tool: string;
  startedAt: number;
  lastProgressAt: number;
  lastHeartbeatAt: number;
}

export interface LongTaskBus {
  /** Called by a tool's `ctx.progress()` — emits a `tool_progress` event. */
  onProgress: (payload: ProgressEvent) => void;
  /** Synthesized during silence — emits a `tool_heartbeat` event. */
  onHeartbeat: (payload: HeartbeatEvent) => void;
  /** Fired when a task is aborted due to timeout. */
  onTimeout: (payload: { callId: string; tool: string; elapsedMs: number }) => void;
}

export interface LongTaskOptions {
  /** Maximum time a single tool call can run before being aborted. */
  timeoutMs?: number;
  /** How long without any `onProgress` before we emit a heartbeat. */
  heartbeatAfterMs?: number;
  /** How often to emit subsequent heartbeats. */
  heartbeatIntervalMs?: number;
}

export const DEFAULT_LONG_TASK_OPTIONS: Required<LongTaskOptions> = {
  timeoutMs: 180_000,
  heartbeatAfterMs: 15_000,
  heartbeatIntervalMs: 15_000,
};

/**
 * Manages long-task state for a single agent turn. One instance per runAgent
 * call. The `beginTool` method returns a controller the agent loop uses while
 * a tool is executing; `settleTool` clears the heartbeat.
 */
export class LongTaskTracker {
  private readonly bus: LongTaskBus;
  private readonly opts: Required<LongTaskOptions>;
  private active: LongTaskState | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private abortController: AbortController | null = null;

  constructor(bus: LongTaskBus, opts: LongTaskOptions = {}) {
    this.bus = bus;
    this.opts = { ...DEFAULT_LONG_TASK_OPTIONS, ...opts };
  }

  /** Start tracking a new tool call. Returns its AbortController. */
  beginTool(callId: string, tool: string, parentSignal?: AbortSignal): AbortController {
    this.settleTool(); // defensive — clear any leftover
    const now = Date.now();
    this.active = {
      callId,
      tool,
      startedAt: now,
      lastProgressAt: now,
      lastHeartbeatAt: now,
    };
    this.abortController = new AbortController();
    if (parentSignal) {
      const onParentAbort = () => this.abortController?.abort(parentSignal.reason);
      if (parentSignal.aborted) this.abortController.abort(parentSignal.reason);
      else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
    this.heartbeatTimer = setInterval(() => this.maybeHeartbeat(), 2000).unref();
    this.timeoutTimer = setTimeout(() => this.onTimeout(), this.opts.timeoutMs).unref();
    return this.abortController;
  }

  /** Fire a progress event for the currently-active tool. No-op if nothing is active. */
  emitProgress(callId: string, payload: ProgressPayload): void {
    if (!this.active || this.active.callId !== callId) return;
    const now = Date.now();
    this.active.lastProgressAt = now;
    this.active.lastHeartbeatAt = now;
    this.bus.onProgress({
      ...payload,
      callId,
      elapsedMs: now - this.active.startedAt,
    });
  }

  /** Mark the current tool as done. Stops heartbeat + timeout timers. */
  settleTool(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.active = null;
    this.abortController = null;
  }

  /** Cancel the entire turn (called on end-of-runAgent). */
  dispose(): void {
    this.settleTool();
  }

  private maybeHeartbeat(): void {
    if (!this.active) return;
    const now = Date.now();
    const sinceLastSignal = now - this.active.lastHeartbeatAt;
    if (sinceLastSignal < this.opts.heartbeatAfterMs) return;
    this.active.lastHeartbeatAt = now;
    this.bus.onHeartbeat({
      callId: this.active.callId,
      elapsedMs: now - this.active.startedAt,
    });
  }

  private onTimeout(): void {
    if (!this.active) return;
    const { callId, tool, startedAt } = this.active;
    const elapsedMs = Date.now() - startedAt;
    try {
      this.abortController?.abort(new Error(`tool timeout (${elapsedMs}ms)`));
    } catch {
      /* ignore */
    }
    this.bus.onTimeout({ callId, tool, elapsedMs });
    this.settleTool();
  }
}

/** Factory used by tool handlers to build a per-call progress callback.
 * The callback closes over the callId + tracker so tools don't need to plumb
 * the id manually on every emit. */
export function makeProgressCallback(
  tracker: LongTaskTracker,
  callId: string,
): (payload: ProgressPayload) => void {
  return (payload) => tracker.emitProgress(callId, payload);
}
