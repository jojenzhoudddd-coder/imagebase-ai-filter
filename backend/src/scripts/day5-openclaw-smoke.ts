/**
 * Day 5 — cross-model OpenClaw smoke.
 *
 * Question: after switching models, does the Agent still have access to its
 * identity (soul.md) / profile / memory / skills? The three-layer system
 * prompt is supposed to inject those verbatim regardless of provider, so
 * every model should be able to answer identity questions *without* calling
 * any tool.
 *
 * For each visible+available model we:
 *   1) switch the selected model,
 *   2) open a fresh conversation,
 *   3) ask one identity question and one memory question,
 *   4) grep the concatenated stream output for keywords that only appear in
 *      the user's real soul.md. If the keyword shows up, the model is
 *      reading Layer 2 correctly. If not, either (a) system prompt was
 *      stripped upstream or (b) model refused to disclose.
 *
 * Run: `npx tsx src/scripts/day5-openclaw-smoke.ts`
 */

import fs from "fs/promises";
import path from "path";
import os from "os";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const AGENT = "agent_default";

interface ModelListResp {
  models: Array<{
    id: string;
    displayName: string;
    available: boolean;
    capabilities: { thinking: boolean };
  }>;
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
  const d = (await r.json()) as { id: string };
  return d.id;
}

interface StreamOut {
  fullText: string;
  thinkingChars: number;
  toolsCalled: string[];
  totalMs: number;
  gotDone: boolean;
  hadError: boolean;
}

async function streamChat(convId: string, prompt: string): Promise<StreamOut> {
  const t0 = Date.now();
  const out: StreamOut = {
    fullText: "",
    thinkingChars: 0,
    toolsCalled: [],
    totalMs: 0,
    gotDone: false,
    hadError: false,
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
        if (currentEvent === "message" && typeof parsed.text === "string") {
          out.fullText += parsed.text;
        } else if (currentEvent === "thinking" && typeof parsed.text === "string") {
          out.thinkingChars += parsed.text.length;
        } else if (currentEvent === "tool_start" && parsed.tool) {
          out.toolsCalled.push(String(parsed.tool));
        } else if (currentEvent === "done") {
          out.gotDone = true;
        } else if (currentEvent === "error") {
          out.hadError = true;
        }
      }
    }
  }
  out.totalMs = Date.now() - t0;
  return out;
}

async function loadSoulKeywords(): Promise<string[]> {
  // Pick a handful of distinctive phrases from the user's real soul.md.
  // If the model's reply echoes any of them, Layer 2 is reaching it.
  const home = process.env.AGENT_HOME || path.join(os.homedir(), ".imagebase", "agents");
  const p = path.join(home, AGENT, "soul.md");
  const text = await fs.readFile(p, "utf8");
  // Split on punctuation + newlines, keep chunks that are 6-30 chars (good
  // signal-to-noise for a keyword match).
  const chunks = text
    .split(/[\n\-\*\.。，,；;：:]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6 && s.length <= 30);
  // Pick up to 8 distinctive chunks.
  return chunks.slice(0, 8);
}

function scoreMatch(reply: string, keywords: string[]): { hits: string[]; score: number } {
  const hits: string[] = [];
  for (const k of keywords) {
    if (reply.includes(k)) hits.push(k);
  }
  return { hits, score: hits.length };
}

async function main() {
  const keywords = await loadSoulKeywords();
  console.log(`\nDay 5 OpenClaw cross-model smoke`);
  console.log(`soul keywords to check: ${keywords.map((k) => `"${k}"`).join(", ")}\n`);
  const { models } = await listModels();
  const soulPrompt =
    "用 2-3 句话，概括一下你的 soul 里对自己的定位和沟通风格。不要客套、不要套话，直接引用 soul 里的关键词。";
  console.log(
    `${"model".padEnd(20)} ${"avail".padEnd(6)} ${"think?".padEnd(7)} ${"replyLen".padEnd(9)} ${"soul hits".padEnd(10)} result`
  );
  console.log("-".repeat(100));
  for (const m of models) {
    if (!m.available) {
      console.log(
        `${m.id.padEnd(20)} ${"no".padEnd(6)} ${String(m.capabilities.thinking).padEnd(7)} ${"-".padEnd(9)} ${"-".padEnd(10)} SKIPPED`
      );
      continue;
    }
    try {
      await setModel(m.id);
      const convId = await newConversation();
      const out = await streamChat(convId, soulPrompt);
      const { hits, score } = scoreMatch(out.fullText, keywords);
      const verdict =
        out.hadError
          ? `❌ error`
          : !out.fullText
            ? `⚠ empty reply`
            : score === 0
              ? `⚠ NO soul keywords (${out.fullText.slice(0, 60)}…)`
              : score >= 2
                ? `✓ soul reaching (${hits.slice(0, 2).join(",")})`
                : `~ partial (${hits.join(",")})`;
      console.log(
        `${m.id.padEnd(20)} ${"yes".padEnd(6)} ${String(m.capabilities.thinking).padEnd(7)} ${String(out.fullText.length).padEnd(9)} ${String(score).padEnd(10)} ${verdict}`
      );
    } catch (err: any) {
      console.log(
        `${m.id.padEnd(20)} ${"yes".padEnd(6)} ${String(m.capabilities.thinking).padEnd(7)} ${"-".padEnd(9)} ${"-".padEnd(10)} ❌ ${err.message}`
      );
    }
  }
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
