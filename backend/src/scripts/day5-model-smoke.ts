/**
 * Day 5 — per-model end-to-end smoke.
 *
 * For each visible+available model:
 *   1) PUT /api/agents/agent_default/model   (switch selection)
 *   2) POST  /api/chat/conversations         (fresh convo, avoids history bias)
 *   3) POST  /api/chat/conversations/:id/messages (SSE)
 *        prompt: "请用一句话回答：1+1=?"
 *   4) Count by event kind: thinking, message, tool_start, tool_result, done, error
 *
 * Success criteria per model:
 *   - stream emits ≥1 `message` event
 *   - thinking-capable models: emit ≥1 `thinking` event (even if empty text for
 *     OneAPI Claude — the marker still fires so the UI indicator animates)
 *   - completes with `done` (no `error`)
 *
 * Usage: node --loader tsx src/scripts/day5-model-smoke.ts
 */

const BASE = process.env.BASE_URL || "http://localhost:3001";
const AGENT = "agent_default";

interface ModelListResp {
  models: Array<{
    id: string;
    displayName: string;
    group: string;
    available: boolean;
    capabilities: { thinking: boolean; toolUse: boolean };
  }>;
}

interface SmokeCounts {
  thinking: number;
  thinkingTextChars: number;
  message: number;
  messageTextChars: number;
  tool_start: number;
  tool_result: number;
  done: number;
  error: number;
  firstMessageMs: number | null;
  firstThinkingMs: number | null;
  totalMs: number;
}

async function listModels(): Promise<ModelListResp> {
  const r = await fetch(`${BASE}/api/agents/models`);
  if (!r.ok) throw new Error(`list models ${r.status}`);
  return r.json();
}

async function setModel(id: string) {
  const r = await fetch(`${BASE}/api/agents/${AGENT}/model`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: id }),
  });
  if (!r.ok) throw new Error(`set model ${id}: ${r.status} ${await r.text()}`);
}

async function newConversation(): Promise<string> {
  const r = await fetch(`${BASE}/api/chat/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: AGENT, workspaceId: "doc_default" }),
  });
  if (!r.ok) throw new Error(`new conv: ${r.status} ${await r.text()}`);
  const data = (await r.json()) as { id: string };
  return data.id;
}

async function streamChat(convId: string, prompt: string): Promise<SmokeCounts> {
  const t0 = Date.now();
  const counts: SmokeCounts = {
    thinking: 0,
    thinkingTextChars: 0,
    message: 0,
    messageTextChars: 0,
    tool_start: 0,
    tool_result: 0,
    done: 0,
    error: 0,
    firstMessageMs: null,
    firstThinkingMs: null,
    totalMs: 0,
  };
  const r = await fetch(`${BASE}/api/chat/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: prompt }),
  });
  if (!r.ok || !r.body) throw new Error(`stream: ${r.status}`);

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let currentEvent: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        currentEvent = null;
        continue;
      }
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:") && currentEvent) {
        const payload = line.slice(5).trim();
        let parsed: any = {};
        try {
          parsed = JSON.parse(payload);
        } catch {
          /* ignore */
        }
        const elapsed = Date.now() - t0;
        switch (currentEvent) {
          case "thinking":
            counts.thinking++;
            counts.thinkingTextChars += typeof parsed.text === "string" ? parsed.text.length : 0;
            if (counts.firstThinkingMs === null) counts.firstThinkingMs = elapsed;
            break;
          case "message":
            counts.message++;
            counts.messageTextChars += typeof parsed.text === "string" ? parsed.text.length : 0;
            if (counts.firstMessageMs === null) counts.firstMessageMs = elapsed;
            break;
          case "tool_start":
            counts.tool_start++;
            break;
          case "tool_result":
            counts.tool_result++;
            break;
          case "done":
            counts.done++;
            break;
          case "error":
            counts.error++;
            break;
        }
      }
    }
  }
  counts.totalMs = Date.now() - t0;
  return counts;
}

async function main() {
  const { models } = await listModels();
  const prompt = process.env.SMOKE_PROMPT ||
    "请用一句话解释：为什么天空是蓝色的？请先在内部思考光的散射原理，再给出给小学生听得懂的解答。";
  console.log(`\nDay 5 per-model smoke — prompt: "${prompt}"\n`);
  console.log(
    `${"model".padEnd(20)} ${"avail".padEnd(6)} ${"think?".padEnd(7)} ${"events(th/msg/tool)".padEnd(21)} ${"chars(msg)".padEnd(11)} ${"ms".padEnd(6)} result`
  );
  console.log("-".repeat(100));
  for (const m of models) {
    if (!m.available) {
      console.log(
        `${m.id.padEnd(20)} ${"no".padEnd(6)} ${String(m.capabilities.thinking).padEnd(7)} ${"-".padEnd(21)} ${"-".padEnd(11)} ${"-".padEnd(6)} SKIPPED (offline)`
      );
      continue;
    }
    try {
      await setModel(m.id);
      const convId = await newConversation();
      const c = await streamChat(convId, prompt);
      const events = `${c.thinking}/${c.message}/${c.tool_start}`;
      const verdict =
        c.error > 0
          ? `❌ error`
          : c.message === 0
            ? `⚠ no message events`
            : m.capabilities.thinking && c.thinking === 0
              ? `⚠ thinking declared but 0 events`
              : `✓ ok`;
      console.log(
        `${m.id.padEnd(20)} ${"yes".padEnd(6)} ${String(m.capabilities.thinking).padEnd(7)} ${events.padEnd(21)} ${String(c.messageTextChars).padEnd(11)} ${String(c.totalMs).padEnd(6)} ${verdict}`
      );
    } catch (err: any) {
      console.log(
        `${m.id.padEnd(20)} ${"yes".padEnd(6)} ${String(m.capabilities.thinking).padEnd(7)} ${"-".padEnd(21)} ${"-".padEnd(11)} ${"-".padEnd(6)} ❌ ${err.message}`
      );
    }
  }
  // Reset selection to the project default so future dev runs aren't confused.
  try {
    await setModel("claude-opus-4.7");
    console.log(`\nReset selection to claude-opus-4.7`);
  } catch {
    /* non-fatal */
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
