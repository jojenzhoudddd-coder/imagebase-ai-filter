/**
 * Keepalive smoke — verifies tool_progress / tool_heartbeat events
 * actually reach the SSE client in real time (not queued until tool end).
 *
 * Strategy: spin up a minimal HTTP server that exposes a fake SSE endpoint
 * mirroring the real chatAgentService pump pattern. Drive a "slow tool"
 * that emits progress every 3s over a 20s run. Client (fetch + stream
 * reader) must observe tool_progress events within a few seconds of each
 * emission, NOT all at the end.
 *
 * No main backend needed.
 */

import express from "express";
import { LongTaskTracker, type LongTaskBus } from "../services/longTaskService.js";

const PORT = 3088;

interface SseEvent { event: string; data: Record<string, unknown>; }

async function* simulateAgent(): AsyncGenerator<SseEvent> {
  // Simulate a slow tool: 20s with 7 progress events + 1 heartbeat gap
  const queuedEvents: SseEvent[] = [];
  let resolveQueueWaiter: (() => void) | null = null;
  const signalQueue = () => {
    const r = resolveQueueWaiter;
    resolveQueueWaiter = null;
    if (r) r();
  };
  const waitForQueue = () =>
    new Promise<void>((resolve) => {
      if (queuedEvents.length > 0) return resolve();
      resolveQueueWaiter = resolve;
    });

  const bus: LongTaskBus = {
    onProgress: (p) => {
      queuedEvents.push({
        event: "tool_progress",
        data: { callId: p.callId, message: p.message, elapsedMs: p.elapsedMs },
      });
      signalQueue();
    },
    onHeartbeat: (p) => {
      queuedEvents.push({
        event: "tool_heartbeat",
        data: { callId: p.callId, elapsedMs: p.elapsedMs },
      });
      signalQueue();
    },
    onTimeout: () => {},
  };
  const tracker = new LongTaskTracker(bus, {
    heartbeatAfterMs: 5_000,
    heartbeatIntervalMs: 5_000,
    timeoutMs: 60_000,
  });

  yield { event: "tool_start", data: { callId: "c1", tool: "slow_fn", args: {} } };

  tracker.beginTool("c1", "slow_fn");

  let toolSettled = false;
  // Progress every 3s for 20s
  const toolPromise = (async () => {
    try {
      for (let i = 1; i <= 7; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        tracker.emitProgress("c1", {
          phase: "computing",
          message: `step ${i}/7`,
          progress: i / 7,
        });
      }
    } finally {
      toolSettled = true;
      signalQueue();
    }
  })();

  while (!toolSettled || queuedEvents.length > 0) {
    while (queuedEvents.length) yield queuedEvents.shift()!;
    if (toolSettled) break;
    await waitForQueue();
  }
  await toolPromise;
  tracker.settleTool();
  tracker.dispose();

  yield { event: "tool_result", data: { callId: "c1", success: true, result: "ok" } };
  yield { event: "done", data: {} };
}

async function startServer(): Promise<() => Promise<void>> {
  const app = express();
  app.post("/fake-sse", async (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
    for await (const ev of simulateAgent()) {
      res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    }
    res.end();
  });
  const server = app.listen(PORT);
  return () =>
    new Promise((resolve) => server.close(() => resolve()));
}

async function runClient(): Promise<{ events: Array<{ event: string; receivedAt: number }> }> {
  const t0 = Date.now();
  const res = await fetch(`http://localhost:${PORT}/fake-sse`, { method: "POST" });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Array<{ event: string; receivedAt: number }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const raw of parts) {
      const match = /event:\s*(\w+)/.exec(raw);
      if (match) {
        events.push({ event: match[1], receivedAt: Date.now() - t0 });
      }
    }
  }
  return { events };
}

async function runKeepaliveSmoke() {
  const stop = await startServer();
  try {
    const { events } = await runClient();
    console.log(`[keepalive] received ${events.length} events:`);
    for (const e of events) {
      console.log(`  +${String(e.receivedAt).padStart(5, " ")}ms  ${e.event}`);
    }

    // Validation: we should see at least one tool_progress event before 5s
    // into the run. If all events cluster in the final moment, the pump is
    // broken.
    const progressEvents = events.filter((e) => e.event === "tool_progress");
    const firstProgress = progressEvents[0]?.receivedAt ?? Number.POSITIVE_INFINITY;
    if (firstProgress > 5_000) {
      throw new Error(
        `first tool_progress arrived at ${firstProgress}ms — pump broken`,
      );
    }
    if (progressEvents.length < 5) {
      throw new Error(
        `expected ≥ 5 progress events in stream, got ${progressEvents.length}`,
      );
    }
    // And the final tool_result must come at the very end (~21s mark)
    const toolResult = events.find((e) => e.event === "tool_result");
    if (!toolResult || toolResult.receivedAt < 18_000) {
      throw new Error("tool_result arrived too early — simulation failed");
    }
    console.log("[keepalive] ✓ events stream in real time (first progress <5s, total ≥5)");
    console.log("[keepalive] PASSED");
  } finally {
    await stop();
  }
}

runKeepaliveSmoke().catch((err) => {
  console.error("[keepalive] FAILED:", err);
  process.exit(1);
});
