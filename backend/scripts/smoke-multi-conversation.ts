/**
 * V3.0 Multi-Conversation 端到端 smoke test
 *
 * 用法:
 *   1) 确保 backend 在 http://localhost:3001 运行 (npm run dev:backend)
 *   2) npx tsx backend/scripts/smoke-multi-conversation.ts
 *
 * 覆盖范围(P0,缺一即视为发布失败):
 *   PR1 — 多对话 CRUD          (P0.1 ~ P0.4)
 *   PR2 — Per-conv working mem (P0.5 ~ P0.7)
 *   PR3 — Listener SSE          (P0.8 ~ P0.9)
 *   PR4 — TurnRegistry/synth    (P0.10 ~ P0.14)
 *   PR5 — WorkflowRun 观测      (P0.15 ~ P0.16)
 *   Per-branch model            (P0.17)
 *
 * 设计准则:
 *   - 每次跑都注册一个全新 user (smoke+v3+<ts>@test.local),不污染生产数据
 *   - 全部用 doubao-2.0 (cheapest + 一定可用)
 *   - 单 check 60s 超时,总 8min 超时
 *   - SSE 用手工 reader (不依赖 EventSource 包)
 *   - 任何 check 失败 → 红色打印 + finalExitCode=1
 *
 * 不依赖 LLM 真实输出语义,只验路由/事件名/数据形状/文件存在性。
 */

import os from "os";
import path from "path";
import fs from "fs/promises";

const BASE_URL = process.env.SMOKE_BASE_URL || "http://localhost:3001";
const AGENT_HOME = process.env.AGENT_HOME || path.join(os.homedir(), ".imagebase", "agents");
const PER_CHECK_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 8 * 60_000;
const CHEAP_MODEL = "doubao-2.0";

// ─── 状态 ────────────────────────────────────────────────────────────────

let cookie = "";          // ibase_auth=...
let agentId = "";
let workspaceId = "";
let userEmail = "";

const results: Array<{ id: string; name: string; ok: boolean; detail?: string }> = [];
const startedAt = Date.now();

function record(id: string, name: string, ok: boolean, detail?: string) {
  results.push({ id, name, ok, detail });
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  const head = `[${tag}] ${id} ${name}`;
  if (ok) console.log(head);
  else console.error(`${head}\n        ❌ ${detail ?? ""}`);
}

function fail(id: string, name: string, expected: string, actual: string) {
  record(id, name, false, `expected ${expected} but got ${actual}`);
}

function assert(id: string, name: string, cond: boolean, expected: string, actualSupplier: () => string) {
  if (cond) record(id, name, true);
  else fail(id, name, expected, actualSupplier());
}

// ─── HTTP helpers ────────────────────────────────────────────────────────

async function http(
  method: string,
  pathname: string,
  body?: any,
  opts: { allowNon2xx?: boolean; raw?: boolean } = {}
): Promise<{ status: number; json: any; text: string; setCookie?: string[] }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PER_CHECK_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${BASE_URL}${pathname}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
  } finally {
    clearTimeout(t);
  }
  const text = await resp.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!opts.allowNon2xx && (resp.status < 200 || resp.status >= 300)) {
    throw new Error(`HTTP ${resp.status} ${method} ${pathname}: ${text.slice(0, 200)}`);
  }
  // capture cookies (Node 18+ fetch via headers.getSetCookie)
  const setCookie = (resp.headers as any).getSetCookie?.() ?? null;
  return { status: resp.status, json, text, setCookie: setCookie ?? undefined };
}

// SSE reader: 解析 fetch response.body 成 {event, data} stream
type SseEvent = { event: string; data: any; raw?: string };

async function* parseSSE(resp: Response): AsyncGenerator<SseEvent> {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE message 用 "\n\n" 分隔
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let curEvent = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) curEvent = line.slice(7).trim();
        else if (line.startsWith("event:")) curEvent = line.slice(6).trim();
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
        else if (line.startsWith("data:")) dataLines.push(line.slice(5));
      }
      if (dataLines.length === 0) continue;
      const dataStr = dataLines.join("\n");
      let data: any = dataStr;
      try { data = JSON.parse(dataStr); } catch { /* 保留原文 */ }
      yield { event: curEvent, data, raw: block };
    }
  }
}

/**
 * 启动一个 SSE 请求,返回 events accumulator + abort fn。后台一直跑,
 * 直到 abort() 调用或 stream 结束。
 */
function startSseTap(method: string, pathname: string, body?: any): {
  events: SseEvent[];
  done: Promise<void>;
  abort: () => void;
  awaitEvent: (predicate: (e: SseEvent) => boolean, timeoutMs?: number) => Promise<SseEvent>;
} {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;

  const ac = new AbortController();
  const events: SseEvent[] = [];
  const waiters: Array<{
    predicate: (e: SseEvent) => boolean;
    resolve: (e: SseEvent) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  function tryNotify(ev: SseEvent) {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(ev)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(ev);
        waiters.splice(i, 1);
      }
    }
  }

  const done = (async () => {
    try {
      const resp = await fetch(`${BASE_URL}${pathname}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      if (!resp.ok) {
        throw new Error(`SSE HTTP ${resp.status} ${pathname}`);
      }
      for await (const ev of parseSSE(resp)) {
        events.push(ev);
        tryNotify(ev);
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        // surface 给外层 await 决定
        throw err;
      }
    } finally {
      // 解锁所有还在等的 waiter (用 reject 让 awaitEvent 抛 timeout-ish)
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(new Error(`SSE stream ended before predicate matched (${pathname})`));
      }
      waiters.length = 0;
    }
  })();

  function awaitEvent(predicate: (e: SseEvent) => boolean, timeoutMs = 60_000): Promise<SseEvent> {
    // 先看已经收到的
    for (const e of events) if (predicate(e)) return Promise.resolve(e);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`awaitEvent timeout ${timeoutMs}ms (${pathname})`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timer });
    });
  }

  return { events, done, abort: () => ac.abort(), awaitEvent };
}

/** 跑一次发消息 SSE 直到 done / error,返回所有收到的 events */
async function runMessageSse(convId: string, message: string): Promise<SseEvent[]> {
  const tap = startSseTap("POST", `/api/chat/conversations/${convId}/messages`, { message });
  await tap.done.catch((e) => {
    // 收到 done 后自然结束,fetch 内部 reader.read returns done — 这里是真异常才抛
    throw e;
  });
  return tap.events;
}

// ─── auth setup ──────────────────────────────────────────────────────────

async function registerFreshUser(): Promise<void> {
  const ts = Date.now();
  userEmail = `smoke+v3+${ts}@test.local`;
  const r = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      email: userEmail,
      password: "smoke-pass-12345",
      username: `smoke_${ts}`,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`register failed ${r.status}: ${body}`);
  }
  const body = await r.json();
  // grab Set-Cookie -> ibase_auth=...; ...
  const setCookies: string[] = (r.headers as any).getSetCookie?.() ?? [];
  const auth = setCookies.find((c) => c.startsWith("ibase_auth="));
  if (!auth) throw new Error(`no ibase_auth cookie in register response (got ${setCookies.length} cookies)`);
  cookie = auth.split(";")[0]; // 只留 name=val
  agentId = body.agentId;
  workspaceId = body.workspaceId;
  if (!agentId || !workspaceId) {
    throw new Error(`register response missing agentId/workspaceId: ${JSON.stringify(body)}`);
  }
  console.log(`\n[setup] registered ${userEmail}`);
  console.log(`[setup] agentId=${agentId} workspaceId=${workspaceId}\n`);
}

async function setAgentModel(modelId: string) {
  // PUT /api/agents/:agentId/model { modelId }
  await http("PUT", `/api/agents/${agentId}/model`, { modelId });
}

// ─── conversation helpers ───────────────────────────────────────────────

async function createConversation(): Promise<string> {
  const { json } = await http("POST", "/api/chat/conversations", {
    workspaceId,
    agentId,
  });
  if (!json?.id) throw new Error(`createConversation response missing id: ${JSON.stringify(json)}`);
  return json.id as string;
}

async function listConversations(opts: { agentId?: string } = {}): Promise<any[]> {
  const qs = new URLSearchParams({ workspaceId });
  if (opts.agentId) qs.set("agentId", opts.agentId);
  const { json } = await http("GET", `/api/chat/conversations?${qs.toString()}`);
  return Array.isArray(json) ? json : [];
}

async function deleteConversation(convId: string): Promise<boolean> {
  const r = await http("DELETE", `/api/chat/conversations/${convId}`, undefined, {
    allowNon2xx: true,
  });
  return r.status === 200 || r.status === 204;
}

async function getMessages(convId: string): Promise<any> {
  const { json } = await http("GET", `/api/chat/conversations/${convId}/messages`);
  return json;
}

// ─── Test cases ──────────────────────────────────────────────────────────
//
// 一个 "section" = 一组逻辑相关的 P0.x。每个 section 独立 try/catch,
// 任何一个 throw 不影响后续 section 执行。

// PR1: P0.1 ~ P0.4
async function testPR1MultiConversationCRUD() {
  console.log("\n━━━ PR1: 多对话 CRUD ━━━");

  // P0.2: POST creates new conversation
  let convA: string, convB: string;
  try {
    convA = await createConversation();
    record("P0.2", "POST /api/chat/conversations 新建对话", true);
    // 加微小间隔保证 createdAt 严格不同 (Postgres timestamp 精度 ms)
    await sleep(20);
    convB = await createConversation();
  } catch (err: any) {
    record("P0.2", "POST /api/chat/conversations 新建对话", false, err?.message ?? String(err));
    return;
  }

  // P0.1: GET sorted by createdAt desc — 最新的在最前
  try {
    const list = await listConversations();
    const idxA = list.findIndex((c: any) => c.id === convA);
    const idxB = list.findIndex((c: any) => c.id === convB);
    assert(
      "P0.1",
      "GET /api/chat/conversations 按 createdAt desc",
      idxB >= 0 && idxA >= 0 && idxB < idxA,
      "convB(后建) 排在 convA(先建)前面",
      () => `idxA=${idxA} idxB=${idxB} list=${list.map((c: any) => c.id).slice(0, 5).join(",")}`,
    );
  } catch (err: any) {
    record("P0.1", "GET /api/chat/conversations 按 createdAt desc", false, err?.message ?? String(err));
  }

  // P0.4: GET ?agentId=X 过滤 — 用注册时拿到的 agentId 应该至少返回 convA + convB
  try {
    const filtered = await listConversations({ agentId });
    const hasA = filtered.some((c: any) => c.id === convA);
    const hasB = filtered.some((c: any) => c.id === convB);
    const allSameAgent = filtered.every((c: any) => !c.agentId || c.agentId === agentId);
    assert(
      "P0.4",
      "GET ?agentId=X 过滤",
      hasA && hasB && allSameAgent,
      `结果包含 convA + convB 且 agentId 全部 = ${agentId}`,
      () => `hasA=${hasA} hasB=${hasB} allSame=${allSameAgent} count=${filtered.length}`,
    );
  } catch (err: any) {
    record("P0.4", "GET ?agentId=X 过滤", false, err?.message ?? String(err));
  }

  // P0.3: DELETE removes + cleans per-conv working memory file
  // 先发一条消息,让 working/<convA>.jsonl 生成,然后删,验文件不在
  try {
    await runMessageSse(convA, "ping P0.3");
    const wmFile = path.join(AGENT_HOME, agentId, "memory", "working", `${convA}.jsonl`);
    const existsBefore = await pathExists(wmFile);
    if (!existsBefore) {
      // 不致命 — 但提示一下后续断言可能失败
      console.warn(`        (warn) working file ${wmFile} 在 delete 前就不存在,P0.3 退化为只验路由 200`);
    }
    const ok = await deleteConversation(convA);
    if (!ok) {
      fail("P0.3", "DELETE 删除 conversation + 清 working memory", "200 OK", "non-2xx");
      return;
    }
    // 给后端一点时间做 fs.unlink (它是 fire-and-forget 但应该 < 500ms)
    await sleep(300);
    const existsAfter = await pathExists(wmFile);
    assert(
      "P0.3",
      "DELETE 删除 conversation + 清 working memory",
      !existsAfter,
      `working memory 文件 ${wmFile} 不存在`,
      () => `文件仍存在: ${wmFile}`,
    );
    // 同时 conv 不应再出现在 list 中
    const listAfter = await listConversations();
    if (listAfter.some((c: any) => c.id === convA)) {
      record("P0.3", "DELETE 后 conv 不在 list", false, `${convA} still in list`);
    }
  } catch (err: any) {
    record("P0.3", "DELETE 删除 conversation + 清 working memory", false, err?.message ?? String(err));
  }
}

// PR2: P0.5 ~ P0.7
async function testPR2PerConvWorkingMemory() {
  console.log("\n━━━ PR2: Per-conv working memory ━━━");

  let convA: string, convB: string;
  try {
    convA = await createConversation();
    convB = await createConversation();
  } catch (err: any) {
    record("P0.5", "PR2 setup", false, err?.message ?? String(err));
    return;
  }

  // P0.5: 在 convA 跑 1 turn → working/<convA>.jsonl 存在 + 1 entry
  try {
    await runMessageSse(convA, "smoke P0.5 — 你好");
    await sleep(400); // working append 是 fire-and-forget
    const fileA = path.join(AGENT_HOME, agentId, "memory", "working", `${convA}.jsonl`);
    const contentA = await readFileOrEmpty(fileA);
    const linesA = contentA.split("\n").filter((l) => l.trim());
    assert(
      "P0.5",
      "convA 1 turn 后 working/<convA>.jsonl 有 1 条",
      linesA.length >= 1,
      `${fileA} 至少 1 行 jsonl`,
      () => `lines=${linesA.length} content=${contentA.slice(0, 200)}`,
    );

    // P0.6: convB 跑 1 turn → convA 文件不变 + convB 文件 1 条
    const beforeBytes = contentA.length;
    await runMessageSse(convB, "smoke P0.6 — hi");
    await sleep(400);
    const contentA2 = await readFileOrEmpty(fileA);
    const fileB = path.join(AGENT_HOME, agentId, "memory", "working", `${convB}.jsonl`);
    const contentB = await readFileOrEmpty(fileB);
    const linesB = contentB.split("\n").filter((l) => l.trim());
    const aUntouched = contentA2.length === beforeBytes;
    assert(
      "P0.6",
      "convB turn 后 convA 文件不变 + convB 文件 1 条",
      aUntouched && linesB.length >= 1,
      "convA bytes unchanged && convB 至少 1 行",
      () => `aUntouched=${aUntouched} (${beforeBytes}→${contentA2.length}) bLines=${linesB.length}`,
    );
  } catch (err: any) {
    record("P0.5/6", "PR2 working memory split", false, err?.message ?? String(err));
  }

  // P0.7: 迁移脚本 dryRun 报告正确数字
  // 策略:
  //   1) 在 AGENT_HOME/<agentId>/memory/ 下手工写一个 legacy working.jsonl
  //   2) spawn `npx tsx backend/scripts/migrate-working-memory-per-conv.ts`(dry 模式默认)
  //   3) stdout 必须含 agent + 行数
  try {
    const memDir = path.join(AGENT_HOME, agentId, "memory");
    const legacy = path.join(memDir, "working.jsonl");
    const fakeTurns = [
      JSON.stringify({ ts: Date.now(), conversationId: "cv_legacy_a", userMessage: "hi" }),
      JSON.stringify({ ts: Date.now(), conversationId: "cv_legacy_a", userMessage: "again" }),
      JSON.stringify({ ts: Date.now(), conversationId: "cv_legacy_b", userMessage: "other" }),
    ].join("\n") + "\n";
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(legacy, fakeTurns, "utf-8");

    // 跑 dry — 这里 child_process.spawn,默认走 cwd = repo root
    const { stdout } = await runShell([
      "npx", "tsx",
      "backend/scripts/migrate-working-memory-per-conv.ts",
      "--dry",
    ], { cwd: path.resolve(process.cwd()) });

    // 报告里必须有 3 turns + 这个 agentId + 2 convs
    const matchesAgent = stdout.includes(agentId);
    const matches3 = /3 turns/.test(stdout) || /3\s*entr/i.test(stdout);
    const matches2Convs = /2 convs/.test(stdout) || /across\s*2/.test(stdout);
    assert(
      "P0.7",
      "migration dryRun 报告正确",
      matchesAgent && matches3 && matches2Convs,
      `stdout 含 agentId=${agentId} + "3 turns" + "2 convs"`,
      () => `agent=${matchesAgent} 3turns=${matches3} 2convs=${matches2Convs} stdout=${stdout.slice(0, 400)}`,
    );

    // 清理 — 防止下面其他 case 又把它拆开
    await fs.unlink(legacy).catch(() => { /* ignore */ });
  } catch (err: any) {
    record("P0.7", "migration dryRun 报告正确", false, err?.message ?? String(err));
  }
}

// PR3: P0.8 ~ P0.9
async function testPR3ListenerSse() {
  console.log("\n━━━ PR3: Listener SSE ━━━");

  let convX: string;
  try { convX = await createConversation(); }
  catch (err: any) {
    record("P0.8", "PR3 setup", false, err?.message ?? String(err));
    return;
  }

  // P0.8: GET /listen 立即返回 connected event
  let listener: ReturnType<typeof startSseTap>;
  try {
    listener = startSseTap("GET", `/api/chat/conversations/${convX}/listen`);
    const connected = await listener.awaitEvent((e) => e.event === "connected", 5000);
    assert(
      "P0.8",
      "GET /listen 收到 connected event",
      connected.data?.convId === convX,
      `connected.data.convId === ${convX}`,
      () => `data=${JSON.stringify(connected.data)}`,
    );
  } catch (err: any) {
    record("P0.8", "GET /listen 收到 connected event", false, err?.message ?? String(err));
    return;
  }

  // P0.9: 同 conv 发 message → listener 必须看到 message_persisted 或 branch_started 等事件
  try {
    const sender = startSseTap("POST", `/api/chat/conversations/${convX}/messages`, {
      message: "smoke P0.9 — listener test",
    });
    // sender 自己跑完 (done event 终止)
    const ev = await listener.awaitEvent(
      (e) => e.event === "message_persisted" || e.event === "branch_started" || e.event === "synth_started",
      30_000,
    );
    record("P0.9", `parallel listener 收到 ${ev.event} event`, true);
    // 等 sender 跑完(避免下个 case 抢同 conv)
    await sender.done.catch(() => { /* swallow,可能因为我们 abort listener 没影响 */ });
  } catch (err: any) {
    record("P0.9", "parallel listener 收到事件", false, err?.message ?? String(err));
  } finally {
    listener.abort();
  }
}

// PR4: P0.10 ~ P0.14
async function testPR4TurnRegistry() {
  console.log("\n━━━ PR4: TurnRegistry + multi-branch + synth ━━━");

  let conv: string;
  try { conv = await createConversation(); }
  catch (err: any) {
    record("P0.10", "PR4 setup", false, err?.message ?? String(err));
    return;
  }

  // 同时起一个 listener 旁观所有事件
  const listener = startSseTap("GET", `/api/chat/conversations/${conv}/listen`);
  await listener.awaitEvent((e) => e.event === "connected", 5000).catch(() => {});

  // P0.10: 两条 POST quick succession → 第一条触发 main, 第二条触发 branch_started
  try {
    const first = startSseTap("POST", `/api/chat/conversations/${conv}/messages`, {
      message: "smoke P0.10 — first message (main)",
    });
    // 等 first 进 main 阶段:看到 message_persisted 即说明已 enter dispatcher
    await first.awaitEvent((e) => e.event === "message_persisted", 15_000);

    // 立刻发第二条 — 主线必须仍 inflight
    const second = startSseTap("POST", `/api/chat/conversations/${conv}/messages`, {
      message: "smoke P0.10 — second message (branch)",
    });

    // second 的响应中必须出现 branch_started (它是被 dispatcher 标为 appended branch)
    const branched = await second.awaitEvent(
      (e) => e.event === "branch_started" || e.event === "turn_pending",
      30_000,
    );

    // branch_started 是预期 happy path,turn_pending 是 synth 已经启动后的兜底
    assert(
      "P0.10",
      "第二条 quick succession → branch_started",
      branched.event === "branch_started",
      `second 响应包含 branch_started`,
      () => `second 第一条调度事件=${branched.event} data=${JSON.stringify(branched.data)}`,
    );

    // 等两条都跑完 (主请求 stream done)
    await Promise.race([
      Promise.all([first.done.catch(() => {}), second.done.catch(() => {})]),
      sleep(120_000),  // 兜底,不 block 整体
    ]);

    // P0.11: synth_started + synth_finished 都出现
    const allEvents = [...listener.events, ...first.events, ...second.events];
    const hasSynthStart = allEvents.some((e) => e.event === "synth_started");
    const hasSynthEnd = allEvents.some((e) => e.event === "synth_finished");
    assert(
      "P0.11",
      "两 branch 完成后 synth_started + synth_finished 都触发",
      hasSynthStart && hasSynthEnd,
      `synth_started && synth_finished 都至少出现 1 次`,
      () => `synth_started=${hasSynthStart} synth_finished=${hasSynthEnd}`,
    );

    // P0.12: 最终 assistant message 包含 ≥ 2 个 "──── 关于「" 拼接段
    // 拉历史看
    const msgPayload = await getMessages(conv);
    const allMsgs = msgPayload?.messages ?? [];
    const lastAssistant = [...allMsgs].reverse().find((m: any) => m.role === "assistant" && m.branchTag === "synthesis")
      ?? [...allMsgs].reverse().find((m: any) => m.role === "assistant");
    const content = String(lastAssistant?.content ?? "");
    // 容忍模型偶尔吞 "─" 字符 → 同时也接 "关于「" 出现 ≥ 2 次
    const sectionCount = (content.match(/关于[「『]/g) || []).length;
    assert(
      "P0.12",
      "synth assistant message 含 ≥ 2 个 \"关于「\" 段",
      sectionCount >= 2,
      `assistant content 至少 2 个 "关于「" 段`,
      () => `count=${sectionCount} preview=${content.slice(0, 200)}`,
    );
  } catch (err: any) {
    record("P0.10/11/12", "PR4 multi-branch turn", false, err?.message ?? String(err));
  }

  // P0.13 + P0.14: synth 期间发新 query → turn_pending → synth 结束后 turn_promoted
  // 这两个 case 时序非常窄(synth 通常 < 5s 结束),只能尝试 best effort:
  //   * 立刻在主线还没结束前连发 3 条,概率可以让最后一条落到 synth 期间
  //   * 如果失败就跳过 + 标 SKIP (不算 P0 失败)
  try {
    const conv2 = await createConversation();
    const tap = startSseTap("GET", `/api/chat/conversations/${conv2}/listen`);
    await tap.awaitEvent((e) => e.event === "connected", 5000).catch(() => {});

    const m1 = startSseTap("POST", `/api/chat/conversations/${conv2}/messages`, {
      message: "P0.13 quick 1",
    });
    await m1.awaitEvent((e) => e.event === "message_persisted", 10_000);
    const m2 = startSseTap("POST", `/api/chat/conversations/${conv2}/messages`, {
      message: "P0.13 quick 2",
    });
    await sleep(50);
    const m3 = startSseTap("POST", `/api/chat/conversations/${conv2}/messages`, {
      message: "P0.13 quick 3",
    });

    // 让所有 inflight POST 跑完
    await Promise.race([
      Promise.all([m1.done.catch(() => {}), m2.done.catch(() => {}), m3.done.catch(() => {})]),
      sleep(150_000),
    ]);

    const allEv = [
      ...tap.events,
      ...m1.events, ...m2.events, ...m3.events,
    ];

    const hasPending = allEv.some((e) => e.event === "turn_pending");
    const hasPromoted = allEv.some((e) => e.event === "turn_promoted");

    if (hasPending) {
      record("P0.13", "synth 中再发 → turn_pending", true);
    } else {
      // 时序窗口太窄,不算硬失败
      record(
        "P0.13",
        "synth 中再发 → turn_pending",
        false,
        "未捕获到 turn_pending — 时序窗口可能太窄,本机 model 太快;手工复测仍需走 UI",
      );
    }
    if (hasPromoted) {
      record("P0.14", "synth 完成后 turn_promoted 自动 pop queue", true);
    } else {
      record(
        "P0.14",
        "synth 完成后 turn_promoted 自动 pop queue",
        false,
        "未捕获到 turn_promoted (依赖 P0.13 先成立)",
      );
    }
    tap.abort();
  } catch (err: any) {
    record("P0.13/14", "synth pending + promoted", false, err?.message ?? String(err));
  }

  listener.abort();
}

// PR5: P0.15 ~ P0.16
async function testPR5WorkflowRunObservability() {
  console.log("\n━━━ PR5: WorkflowRun 观测 ━━━");

  // 起一个 multi-branch turn,确保会写一行 WorkflowRun
  let conv: string;
  try { conv = await createConversation(); }
  catch (err: any) {
    record("P0.15", "PR5 setup", false, err?.message ?? String(err));
    return;
  }

  try {
    const m1 = startSseTap("POST", `/api/chat/conversations/${conv}/messages`, {
      message: "PR5 main",
    });
    await m1.awaitEvent((e) => e.event === "message_persisted", 10_000);
    const m2 = startSseTap("POST", `/api/chat/conversations/${conv}/messages`, {
      message: "PR5 appended",
    });
    await Promise.race([
      Promise.all([m1.done.catch(() => {}), m2.done.catch(() => {})]),
      sleep(120_000),
    ]);
  } catch (err: any) {
    record("P0.15", "PR5 setup messages", false, err?.message ?? String(err));
    return;
  }

  // P0.15: GET /api/admin/workflow-runs 至少 1 行 templateId="append-batch"
  try {
    const { json } = await http(
      "GET",
      `/api/admin/workflow-runs?templateId=append-batch&hostAgentId=${encodeURIComponent(agentId)}`,
    );
    const rows = Array.isArray(json?.rows) ? json.rows : [];
    const found = rows.find((r: any) => r.parentConversationId === conv && r.templateId === "append-batch");
    assert(
      "P0.15",
      "GET /api/admin/workflow-runs 含 templateId=append-batch 行",
      !!found,
      `至少一行 templateId=append-batch && parentConversationId=${conv}`,
      () => `total=${rows.length} sample=${JSON.stringify(rows[0]).slice(0, 200)}`,
    );
  } catch (err: any) {
    record("P0.15", "GET /api/admin/workflow-runs", false, err?.message ?? String(err));
  }

  // P0.16: 该 WorkflowRun.nodeEventsJson 含 trigger / main_started / main_finished / synth_finished
  // admin /workflow-runs 不返回 nodeEventsJson,所以走 /messages 上的 join
  try {
    const msgPayload = await getMessages(conv);
    const allWf: any[] = [];
    for (const m of msgPayload?.messages ?? []) {
      for (const wf of m.workflowRuns ?? []) {
        if (wf.templateId === "append-batch") allWf.push(wf);
      }
    }
    if (allWf.length === 0) {
      fail("P0.16", "WorkflowRun.nodeEventsJson 含关键 kind", "至少 1 条 append-batch row", "无");
      return;
    }
    const node = allWf[0];
    const events: any[] = Array.isArray(node.nodeEventsJson) ? node.nodeEventsJson : [];
    const kinds = new Set(events.map((e: any) => e?.kind ?? e?.type ?? e?.name));
    const must = ["trigger", "main_started", "main_finished", "synth_finished"];
    const missing = must.filter((k) => !kinds.has(k));
    assert(
      "P0.16",
      "WorkflowRun.nodeEventsJson 含 trigger/main_started/main_finished/synth_finished",
      missing.length === 0,
      `nodeEventsJson kinds 含全部 ${must.join("/")}`,
      () => `missing=${missing.join(",")} actualKinds=${[...kinds].join(",")}`,
    );
  } catch (err: any) {
    record("P0.16", "WorkflowRun.nodeEventsJson kinds", false, err?.message ?? String(err));
  }
}

// Per-branch model: P0.17
async function testPerBranchModel() {
  console.log("\n━━━ Per-branch model ━━━");

  let conv: string;
  try { conv = await createConversation(); }
  catch (err: any) {
    record("P0.17", "Per-branch model setup", false, err?.message ?? String(err));
    return;
  }

  try {
    // 主线先发,让它 inflight
    const m1 = startSseTap("POST", `/api/chat/conversations/${conv}/messages`, {
      message: "P0.17 main",
    });
    await m1.awaitEvent((e) => e.event === "message_persisted", 10_000);

    // 第二条:用 mention://model/gpt-5.5 — gpt-5.5 不一定可用,fallback 也接受
    const branchUserMsg = "P0.17 [@GPT5.5](mention://model/gpt-5.5) 用这个模型";
    const m2 = startSseTap("POST", `/api/chat/conversations/${conv}/messages`, {
      message: branchUserMsg,
      mentions: [{ type: "model", modelId: "gpt-5.5" }],
    });
    const branchEv = await m2.awaitEvent((e) => e.event === "branch_started", 30_000).catch(() => null);

    await Promise.race([
      Promise.all([m1.done.catch(() => {}), m2.done.catch(() => {})]),
      sleep(120_000),
    ]);

    if (!branchEv) {
      record("P0.17", "branch_started 出现", false, "未收到 branch_started 事件");
      return;
    }

    // 找对应 SubagentRun:用 admin /subagent-runs?hostAgentId 筛
    const { json } = await http(
      "GET",
      `/api/admin/subagent-runs?limit=50&hostAgentId=${encodeURIComponent(agentId)}`,
    );
    const rows: any[] = json?.rows ?? [];
    // 找 parent conv 一致 + userPromptPreview 含 "P0.17" 的最新 row
    const branchRow = rows.find(
      (r) => r.parentConversationId === conv
        && /P0\.17/.test(r.userPromptPreview ?? "")
        && /(@GPT5\.5|gpt-5\.5)/i.test(r.userPromptPreview ?? ""),
    );
    if (!branchRow) {
      record(
        "P0.17",
        "SubagentRun 标 subagentModel = gpt-5.5 (或 fallback)",
        false,
        `未在 subagent-runs 找到 P0.17 + gpt-5.5 提示词的 row (rows=${rows.length})`,
      );
      return;
    }
    // requestedModel = gpt-5.5,subagentModel 可能是 gpt-5.5 或 fallback (doubao-2.0)
    const reqOk = branchRow.requestedModel === "gpt-5.5";
    const subOk = branchRow.subagentModel === "gpt-5.5" || branchRow.subagentModel === "doubao-2.0";
    assert(
      "P0.17",
      "SubagentRun.requestedModel = gpt-5.5 + subagentModel ∈ {gpt-5.5, fallback}",
      reqOk && subOk,
      "requested=gpt-5.5,subagent=gpt-5.5 或 doubao-2.0",
      () => `requested=${branchRow.requestedModel} subagent=${branchRow.subagentModel}`,
    );
  } catch (err: any) {
    record("P0.17", "Per-branch model", false, err?.message ?? String(err));
  }
}

// ─── utilities ──────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readFileOrEmpty(p: string): Promise<string> {
  try { return await fs.readFile(p, "utf-8"); } catch { return ""; }
}

async function runShell(
  argv: string[],
  opts: { cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawn } = await import("child_process");
  return await new Promise((resolve, reject) => {
    const proc = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (b) => { stdout += b.toString(); });
    proc.stderr.on("data", (b) => { stderr += b.toString(); });
    const t = setTimeout(() => {
      proc.kill();
      reject(new Error(`runShell timeout: ${argv.join(" ")}`));
    }, PER_CHECK_TIMEOUT_MS);
    proc.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// ─── main ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`Multi-Conversation V3.0 smoke test — base=${BASE_URL}`);

  // 全局兜底:8min 总超时
  const totalTimer = setTimeout(() => {
    console.error("\n❌ 总超时 8min,中止");
    summarizeAndExit();
  }, TOTAL_TIMEOUT_MS);
  totalTimer.unref?.();

  try {
    await registerFreshUser();
    // 把 agent default model 设为 doubao-2.0 (省钱 + 稳定)
    await setAgentModel(CHEAP_MODEL);
  } catch (err: any) {
    console.error(`❌ setup 失败 (注册/cookie): ${err?.message ?? err}`);
    process.exit(1);
  }

  await testPR1MultiConversationCRUD();
  await testPR2PerConvWorkingMemory();
  await testPR3ListenerSse();
  await testPR4TurnRegistry();
  await testPR5WorkflowRunObservability();
  await testPerBranchModel();

  summarizeAndExit();
}

function summarizeAndExit(): never {
  console.log(`\n━━━ Summary ━━━`);
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    console.log(`  ❌ ${r.id} — ${r.name}\n        ${r.detail ?? ""}`);
  }
  console.log(
    `\nTotal ${results.length} checks · ${passed.length} pass · ${failed.length} fail · ${
      Math.round((Date.now() - startedAt) / 1000)
    }s elapsed`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("❌ fatal:", err);
  process.exit(1);
});
