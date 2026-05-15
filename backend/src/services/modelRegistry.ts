/**
 * Model registry — single source of truth for which models the Table Agent
 * can use, and how to reach them.
 *
 * The whitelist below is confirmed by the user (see chat history):
 *   doubao-2.0       (Volcano ARK, current production model, default fallback)
 *   claude-opus-4.7  (via OneAPI, default-preferred)
 *   claude-opus-4.6  (via OneAPI, currently available)
 *   gpt-5.5          (via OneAPI)
 *   gpt-5.4          (via OneAPI)
 *   gpt-5.4-mini     (via OneAPI)
 *
 * `claude-sonnet-4.6` was removed on 2026-04-22 — upstream whitelist state
 * was unstable enough to not be worth keeping in the picker. Same-group
 * fallback still covers existing selections: agents previously saved with
 * `claude-sonnet-4.6` now resolve to `claude-opus-4.7` or `claude-opus-4.6`
 * (whichever is available) without overwriting their preference.
 *
 * ## Availability
 *
 * `available` is filled by an async probe (`probeModels`) that:
 *   - Hits OneAPI `/v1/models` and matches each entry's `providerModelId`
 *   - Checks ARK env (`ARK_API_KEY` + `ARK_MODEL`) for the ark entry
 * When a model's `available: false`, the resolve step falls back along the
 * `fallbackChain` preference: same-group first, then `FALLBACK_MODEL_ID`.
 * We never overwrite the user's saved preference — once the preferred model
 * comes back online, the very next turn uses it automatically.
 */

import type { ProviderAdapter } from "./providers/types.js";

// ─── Per-model concurrency control ─────────────────────────────────────
//
// AsyncSemaphore enforces the `parallelLimit` declared on each ModelEntry.
// Without this, N concurrent users all hitting Claude Opus (parallelLimit=3)
// fire N simultaneous requests to OneAPI → upstream 429/503/terminated.
//
// acquire() returns a promise that resolves when a slot is available.
// The caller MUST call the returned release() when done (even on error).

/** Request priority levels. Lower number = higher priority. */
export const enum ModelRequestPriority {
  /** User directly typing in chat — must feel instant. */
  USER_CHAT = 0,
  /** Subagent spawned by the user's turn — user is waiting. */
  SUBAGENT = 1,
  /** Workflow branch — user is waiting but tolerates some delay. */
  WORKFLOW = 2,
  /** Background tasks: habit/cron, taste-meta, suggestion refresh. */
  BACKGROUND = 3,
}

export class AsyncSemaphore {
  private _current = 0;
  private _queue: Array<{ priority: number; resolve: () => void }> = [];
  constructor(readonly capacity: number) {}

  get current() { return this._current; }
  get waiting() { return this._queue.length; }

  /**
   * Acquire a concurrency slot. Lower `priority` number = served first.
   * Returns a release function that MUST be called when done.
   */
  acquire(priority: number = ModelRequestPriority.USER_CHAT): Promise<() => void> {
    if (this._current < this.capacity) {
      this._current++;
      return Promise.resolve(this._release.bind(this));
    }
    return new Promise<() => void>((resolve) => {
      const entry = { priority, resolve: () => { this._current++; resolve(this._release.bind(this)); } };
      // Insert sorted by priority (lower = earlier in queue)
      const idx = this._queue.findIndex(e => e.priority > priority);
      if (idx === -1) this._queue.push(entry);
      else this._queue.splice(idx, 0, entry);
    });
  }

  private _release() {
    this._current--;
    if (this._queue.length > 0) {
      const next = this._queue.shift()!;
      next.resolve();
    }
  }
}

// One semaphore per model id, lazily created from parallelLimit.
const _semaphores = new Map<string, AsyncSemaphore>();

export function getModelSemaphore(modelId: string): AsyncSemaphore {
  let sem = _semaphores.get(modelId);
  if (!sem) {
    const entry = MODELS.find((m) => m.id === modelId);
    const cap = entry?.parallelLimit ?? 5; // safe default
    sem = new AsyncSemaphore(cap);
    _semaphores.set(modelId, sem);
  }
  return sem;
}

export type ModelGroup = "volcano" | "anthropic" | "openai";
export type ModelProvider = "ark" | "oneapi" | "ark-image" | "ark-video";

export interface ModelCapabilities {
  /** Model supports extended thinking / reasoning (Claude thinking, o-series reasoning). */
  thinking: boolean;
  /** Model supports function/tool calling. Must be true for Table Agent. */
  toolUse: boolean;
  /** Context window in tokens (approximate). */
  contextWindow: number;
  /** Claude extended-thinking budget_tokens. Only meaningful when `thinking: true`. */
  thinkingBudget?: number;
}

/**
 * Specialty (PR2 of agent-workflow series) — 内置专长枚举,代码级维护,不开放
 * 给用户改。host agent / workflow-skill 用这个做模型路由决策(e.g. "需要图像
 * 生成 → 路由到 image-gen specialty 的模型")。
 *
 * 6 类映射:
 *   - code               代码生成 / 审查 / 重构(claude-opus-4.7, gpt-5.5)
 *   - reasoning          复杂推理 / 规划 / 数学(claude-opus thinking, gpt-5.5 reasoning)
 *   - general            通用对话 / 总结(doubao-2.0, claude-opus-4.6)
 *   - image-gen          文生图(nano-banana stub)
 *   - image-understand   图像理解(gemini-flash stub)
 *   - fast-cheap         高吞吐 / 低延迟分类(doubao-2.0, gpt-5.4-mini)
 */
export type ModelSpecialty =
  | "code"
  | "reasoning"
  | "general"
  | "image-gen"
  | "image-understand"
  | "fast-cheap";

/**
 * Strengths(PR2)—— 软标签集合,系统给定的固定枚举。FE 用作"擅长 XX,
 * 推荐用 XX"的小气泡;workflow 路由时也作启发式参考。V1 read-only;V2 计划
 * 让用户在固定枚举里选。
 */
export type ModelStrength =
  | "long-context"
  | "structured-output"
  | "creative-writing"
  | "translation"
  | "math"
  | "data-analysis"
  | "ui-design"
  | "code-review"
  | "low-latency"
  | "video-generation"
  | "image-generation"
  | "multimodal"
  | "creative"
  | "2K-output"
  | "art-style";

export type ModelModality = "text" | "image" | "video" | "audio";
export type ModelCostHint = "cheap" | "mid" | "premium";

export interface ModelEntry {
  /** Stable app-side id. Stored in AgentConfig.model. Never changes across UI renames. */
  id: string;
  /** UI display name. */
  displayName: string;
  /** Which adapter to dispatch to. */
  provider: ModelProvider;
  /** The model id string the provider itself expects in request body. */
  providerModelId: string;
  capabilities: ModelCapabilities;
  defaults: {
    temperature: number;
    maxOutputTokens: number;
  };
  group: ModelGroup;
  /** UI exposure. `false` = internal/hidden (debug, deprecated). */
  visible: boolean;
  /** Set by probeModels(). `undefined` means "not yet probed". */
  available?: boolean;

  // ─── PR2 routing fields ──────────────────────────────────────────────
  /** Single primary specialty — drives workflow routing(image-gen 一定用 image-gen 模型)。 */
  specialty: ModelSpecialty;
  /** Soft tags shown on hover / used for "推荐"。 */
  strengths: ModelStrength[];
  /** Input/output modality. text-only models → ["text"]。 */
  modality: ModelModality[];
  /** Rough cost tier for budget-aware routing。 */
  costHint: ModelCostHint;
  /** Hint for max parallel requests in a concurrent workflow。Optional;
   *  registry-default if omitted。 */
  parallelLimit?: number;

  // ─── Custom model overrides (per-user models loaded from DB) ────────
  /** Custom API base URL — used instead of ONEAPI_BASE_URL when set. */
  customBaseUrl?: string;
  /** Custom API key — used instead of ONEAPI_API_KEY when set. */
  customApiKey?: string;
}

// ─── Registry ────────────────────────────────────────────────────────────

export const MODELS: ModelEntry[] = [
  // ── Volcano ARK (legacy / default-fallback, zero-change behavior) ────
  {
    id: "doubao-2.0",
    displayName: "Doubao 2.0 pro",
    provider: "ark",
    providerModelId:
      process.env.SEED_MODEL ||
      process.env.ARK_MODEL ||
      "ep-20260412192731-vwdh7",
    capabilities: { thinking: false, toolUse: true, contextWindow: 128000 },
    defaults: { temperature: 0.1, maxOutputTokens: 32768 },
    group: "volcano",
    visible: true,
    specialty: "general",
    strengths: ["low-latency", "translation", "creative-writing"],
    modality: ["text"],
    costHint: "cheap",
    parallelLimit: 10,
  },

  // ── Anthropic family (via OneAPI) ────────────────────────────────────
  {
    id: "claude-opus-4.7",
    displayName: "Claude 4.7 Opus",
    provider: "oneapi",
    providerModelId: "claude-opus-4-7",
    capabilities: {
      thinking: true,
      toolUse: true,
      contextWindow: 200000,
      thinkingBudget: 16000,
    },
    defaults: { temperature: 1.0, maxOutputTokens: 65536 },
    group: "anthropic",
    visible: true,
    specialty: "code",
    strengths: ["code-review", "structured-output", "long-context", "creative-writing"],
    modality: ["text", "image"],
    costHint: "premium",
    parallelLimit: 3,
  },
  {
    id: "claude-opus-4.6",
    displayName: "Claude 4.6 Opus",
    provider: "oneapi",
    providerModelId: "claude-opus-4-6",
    capabilities: {
      thinking: true,
      toolUse: true,
      contextWindow: 200000,
      thinkingBudget: 16000,
    },
    defaults: { temperature: 1.0, maxOutputTokens: 65536 },
    group: "anthropic",
    visible: true,
    specialty: "reasoning",
    strengths: ["code-review", "structured-output", "long-context"],
    modality: ["text", "image"],
    costHint: "premium",
    parallelLimit: 3,
  },
  // ── OpenAI family (via OneAPI) ───────────────────────────────────────
  // Newer GPT-5.5 entries go first so they render near the top of the picker
  // under the "OpenAI" group. Availability is set async by probeModels — if
  // OneAPI doesn't actually route `gpt-5.5` the entry will silently fall
  // back via resolveModelForCall.
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    provider: "oneapi",
    providerModelId: "gpt-5.5",
    capabilities: { thinking: false, toolUse: true, contextWindow: 200000 },
    defaults: { temperature: 0.1, maxOutputTokens: 8000 },
    group: "openai",
    visible: true,
    specialty: "reasoning",
    strengths: ["math", "structured-output", "code-review", "data-analysis"],
    modality: ["text", "image"],
    costHint: "premium",
    parallelLimit: 5,
  },
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    provider: "oneapi",
    providerModelId: "gpt-5.4",
    capabilities: { thinking: false, toolUse: true, contextWindow: 200000 },
    defaults: { temperature: 0.1, maxOutputTokens: 8000 },
    group: "openai",
    visible: true,
    specialty: "code",
    strengths: ["code-review", "structured-output"],
    modality: ["text", "image"],
    costHint: "mid",
    parallelLimit: 5,
  },
  {
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4 mini",
    provider: "oneapi",
    providerModelId: "gpt-5.4-mini",
    capabilities: { thinking: false, toolUse: true, contextWindow: 128000 },
    defaults: { temperature: 0.1, maxOutputTokens: 4000 },
    group: "openai",
    visible: true,
    specialty: "fast-cheap",
    strengths: ["low-latency", "structured-output"],
    modality: ["text", "image"],
    costHint: "cheap",
    parallelLimit: 10,
  },

  // ─── Multi-modal stubs (PR2)— available=false 直到实际接入 ───────────
  // 留 entry 是为了让 specialty="image-gen"/"image-understand" 的 workflow
  // routing 能在生成时找到候选模型,即使运行时还跑不通。设置 visible:false
  // 不在 picker 里露出,避免用户主动选到一个跑不动的。
  {
    id: "nano-banana",
    displayName: "Nano Banana (image-gen)",
    provider: "oneapi",
    providerModelId: "nano-banana",
    capabilities: { thinking: false, toolUse: false, contextWindow: 8000 },
    defaults: { temperature: 0.7, maxOutputTokens: 1000 },
    group: "openai",
    visible: false,
    available: false,
    specialty: "image-gen",
    strengths: ["creative-writing", "ui-design"],
    modality: ["text", "image"],
    costHint: "mid",
    parallelLimit: 2,
  },
  {
    id: "gemini-flash",
    displayName: "Gemini Flash (image-understand)",
    provider: "oneapi",
    providerModelId: "gemini-flash",
    capabilities: { thinking: false, toolUse: true, contextWindow: 1000000 },
    defaults: { temperature: 0.1, maxOutputTokens: 4000 },
    group: "openai",
    visible: false,
    available: false,
    specialty: "image-understand",
    strengths: ["low-latency", "data-analysis", "long-context"],
    modality: ["text", "image"],
    costHint: "cheap",
    parallelLimit: 8,
  },

  // ── Volcano ARK — Content Generation (独立 provider，非 chat API) ────
  {
    id: "seedance-2.0",
    displayName: "Seedance 2.0",
    provider: "ark-video",
    providerModelId: process.env.ARK_SEEDANCE_MODEL || "ep-20260505181511-8lsxw",
    capabilities: { thinking: false, toolUse: false, contextWindow: 0 },
    defaults: { temperature: 0, maxOutputTokens: 0 },
    group: "volcano",
    visible: true,
    specialty: "image-gen",
    strengths: ["video-generation", "multimodal", "creative"],
    modality: ["text", "image", "video", "audio"],
    costHint: "premium",
    parallelLimit: 2,
  },
  {
    id: "seedream-5.0-lite",
    displayName: "Seedream 5.0 Lite",
    provider: "ark-image",
    providerModelId: process.env.ARK_SEEDREAM_MODEL || "ep-20260505181559-s5r44",
    capabilities: { thinking: false, toolUse: false, contextWindow: 0 },
    defaults: { temperature: 0, maxOutputTokens: 0 },
    group: "volcano",
    visible: true,
    specialty: "image-gen",
    strengths: ["image-generation", "2K-output", "art-style"],
    modality: ["text", "image"],
    costHint: "mid",
    parallelLimit: 5,
  },
];

// User-preferred default (Opus 4.7). Resolved to FALLBACK_MODEL_ID when
// unavailable. The preference stays written as-is so it auto-recovers.
export const DEFAULT_MODEL_ID = "claude-opus-4.7";
// Hard fallback if the preferred id is not available AND same-group
// alternatives are also down. `doubao-2.0` is the only one that doesn't
// depend on OneAPI, so it's the guaranteed safe harbor.
export const FALLBACK_MODEL_ID = "doubao-2.0";

// ─── Lookup helpers ──────────────────────────────────────────────────────

const byId = new Map<string, ModelEntry>(MODELS.map((m) => [m.id, m]));

/** Get a model by id, or `undefined` if no such id. */
export function getModel(id: string | null | undefined): ModelEntry | undefined {
  if (!id) return undefined;
  return byId.get(id);
}

/**
 * Return the model that should actually be used for a request, honoring
 * availability. Does NOT mutate the caller's preference — only the resolved
 * entry may differ from the requested id. If the requested id is unknown
 * or unavailable, prefers same-group available model, then falls back to
 * FALLBACK_MODEL_ID.
 *
 * Returns `{ requested, resolved, usedFallback }` so the caller can surface
 * a "using X instead of Y" banner in UI.
 */
export function resolveModelForCall(requestedId: string | null | undefined): {
  requested: ModelEntry | undefined;
  resolved: ModelEntry;
  usedFallback: boolean;
} {
  // Lift any expired circuit breakers before reading `available`. Keeps
  // the "cooling → available again" transition zero-latency: as soon as
  // the first post-cooldown call comes in, the flip takes effect.
  relaxExpiredBreakers();
  const requested = getModel(requestedId ?? undefined);
  if (requested && requested.available !== false) {
    return { requested, resolved: requested, usedFallback: false };
  }
  // Same-group fallback
  if (requested) {
    const sibling = MODELS.find(
      (m) => m.id !== requested.id && m.group === requested.group && m.available !== false && m.visible
    );
    if (sibling) return { requested, resolved: sibling, usedFallback: true };
  }
  const lastResort = getModel(FALLBACK_MODEL_ID);
  if (!lastResort) {
    // Shouldn't happen — FALLBACK_MODEL_ID must exist in MODELS.
    throw new Error(`modelRegistry: FALLBACK_MODEL_ID ${FALLBACK_MODEL_ID} not found`);
  }
  return { requested, resolved: lastResort, usedFallback: true };
}

/** User-visible models only. Used by UI to render the picker. */
export function listVisibleModels(): ModelEntry[] {
  return MODELS.filter((m) => m.visible);
}

/**
 * Load a custom model from the database and convert it to a ModelEntry.
 * Returns `undefined` if no matching custom model exists for this user.
 *
 * Custom model provider mapping:
 *   "anthropic"        → oneapi adapter, group "anthropic"
 *   "openai-compatible" → oneapi adapter, group "openai"
 *   "custom"           → oneapi adapter, group "custom" (OpenAI-compat wire format)
 */
export async function resolveCustomModel(
  modelId: string,
  userId: string,
): Promise<ModelEntry | undefined> {
  try {
    const pg2 = await import("pg");
    const { PrismaPg: PA } = await import("@prisma/adapter-pg");
    const { PrismaClient: PC } = await import("../generated/prisma/client.js");
    const p = new pg2.default.Pool({ connectionString: process.env.DATABASE_URL });
    const prisma = new PC({ adapter: new PA(p) });
    const row = await prisma.customModel.findFirst({
      where: { userId, modelId, visible: true },
    });
    await p.end();
    if (!row) return undefined;
    const group: ModelGroup =
      row.provider === "anthropic" ? "anthropic" : "openai";
    return {
      id: row.modelId,
      displayName: row.displayName,
      provider: "oneapi",
      providerModelId: row.providerModelId,
      capabilities: {
        thinking: !!(row.capabilities as any)?.thinking,
        toolUse: (row.capabilities as any)?.toolUse !== false,
        contextWindow: (row.capabilities as any)?.contextWindow ?? 128000,
      },
      defaults: { temperature: 0.7, maxOutputTokens: 8192 },
      group,
      visible: true,
      available: true,
      specialty: (row.specialty as ModelSpecialty) ?? "general",
      strengths: [],
      modality: ["text"],
      costHint: "mid",
      customBaseUrl: row.baseUrl,
      customApiKey: row.apiKey,
    };
  } catch {
    return undefined;
  }
}

/**
 * Find a fallback model when the currently-active one is mid-flight
 * overloaded. Distinct from the start-of-turn resolveModelForCall — used
 * by the agent loop after the adapter retries have all exhausted with an
 * UpstreamOverloadError.
 *
 * Preference order (prefer jumping to a fundamentally DIFFERENT upstream
 * first — same-channel siblings usually share fate on proxy-level issues):
 *   1. Different provider AND different group (e.g. GPT-5.5/oneapi →
 *      doubao-2.0/ark, or claude-4.7/oneapi → doubao-2.0/ark)
 *   2. Different group, same provider (e.g. GPT-5.5 → Claude via OneAPI).
 *      Useful when the OpenAI channel of OneAPI is down but the Anthropic
 *      channel is fine — they're separate upstream APIs.
 *   3. Same group sibling (last resort, since same-group means same
 *      channel = same proxy = same likely bottleneck)
 *   4. Hard fallback FALLBACK_MODEL_ID if not already tried.
 *
 * Exclude any id the caller has already tried to avoid ping-pong.
 * Returns null when nothing safe remains; caller surfaces the error.
 */
export function pickOverloadFallback(
  current: ModelEntry,
  alreadyTried: Set<string> = new Set(),
): ModelEntry | null {
  relaxExpiredBreakers();
  const tried = new Set(alreadyTried);
  tried.add(current.id);
  const avail = (m: ModelEntry) =>
    !tried.has(m.id) && m.available !== false && m.visible;

  // 1. Different provider AND different group (escape the proxy entirely)
  let pick = MODELS.find((m) => avail(m) && m.provider !== current.provider && m.group !== current.group);
  if (pick) return pick;

  // 2. Different group, same provider (different channel on the same proxy)
  pick = MODELS.find((m) => avail(m) && m.group !== current.group);
  if (pick) return pick;

  // 3. Same group sibling
  pick = MODELS.find((m) => avail(m) && m.group === current.group);
  if (pick) return pick;

  // 4. Hard fallback — covered by #1-3 unless it's been tried already
  const hardFallback = getModel(FALLBACK_MODEL_ID);
  if (hardFallback && !tried.has(hardFallback.id) && hardFallback.available !== false) {
    return hardFallback;
  }
  return null;
}

// ─── Provider dispatch (populated by providers/index.ts) ─────────────────
//
// Kept in this file so resolveAdapter() stays a pure lookup and there's no
// circular import. providers/index.ts calls `registerProviderAdapter` once
// at module load.

const adapters = new Map<ModelProvider, ProviderAdapter>();

export function registerProviderAdapter(adapter: ProviderAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function resolveAdapter(model: ModelEntry): ProviderAdapter {
  const a = adapters.get(model.provider);
  if (!a) {
    throw new Error(
      `No adapter registered for provider "${model.provider}" (model ${model.id}). ` +
      `Did providers/index.ts get imported?`
    );
  }
  return a;
}

// ─── Availability probe ──────────────────────────────────────────────────
//
// Called on backend boot and every 10 minutes. Non-fatal — on any error we
// leave `available` unchanged from its previous value (or undefined).

export interface ProbeResult {
  probedAt: number;
  changes: Array<{ id: string; from: boolean | undefined; to: boolean }>;
}

export async function probeModels(): Promise<ProbeResult> {
  const changes: ProbeResult["changes"] = [];

  // 1. Fetch OneAPI /v1/models once, reuse for all oneapi entries
  const oneapiBase = (process.env.ONEAPI_BASE_URL || "").replace(/\/$/, "");
  const oneapiKey = process.env.ONEAPI_API_KEY || "";
  let oneapiAvailableIds = new Set<string>();
  if (oneapiBase && oneapiKey) {
    try {
      const res = await fetch(`${oneapiBase}/models`, {
        headers: { Authorization: `Bearer ${oneapiKey}` },
      });
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ id: string }> };
        for (const m of body.data || []) oneapiAvailableIds.add(m.id);
      }
    } catch {
      /* leave empty — all oneapi models will flip to unavailable */
    }
  }

  // 2. Flip `available` per entry
  for (const m of MODELS) {
    const prev = m.available;
    let next: boolean;
    if (m.provider === "ark") {
      next = Boolean(process.env.ARK_API_KEY && m.providerModelId);
    } else if (m.provider === "oneapi") {
      next = oneapiAvailableIds.has(m.providerModelId);
    } else if (m.provider === "ark-image") {
      next = Boolean((process.env.ARK_SEEDREAM_API_KEY || process.env.ARK_API_KEY) && m.providerModelId);
    } else if (m.provider === "ark-video") {
      next = Boolean((process.env.ARK_SEEDANCE_API_KEY || process.env.ARK_API_KEY) && m.providerModelId);
    } else {
      next = false;
    }
    m.available = next;
    if (prev !== next) changes.push({ id: m.id, from: prev, to: next });
  }

  return { probedAt: Date.now(), changes };
}

// ─── Circuit breaker ────────────────────────────────────────────────────
//
// Per-model rolling failure counter. When a model fails more than
// BREAKER_THRESHOLD times inside BREAKER_WINDOW_MS, mark it temporarily
// unavailable for BREAKER_COOLDOWN_MS. `resolveModelForCall` /
// `pickOverloadFallback` already skip unavailable models, so the breaker
// plugs into existing selection logic for free.
//
// Separate from probeModels() which checks the advertised catalog —
// the breaker checks real observed behavior, which is more accurate
// when OneAPI's /v1/models returns a model that's actually broken.

const BREAKER_WINDOW_MS = 60_000;        // 1 min rolling window
const BREAKER_THRESHOLD = 3;             // 3 failures in window → trip
const BREAKER_COOLDOWN_MS = 3 * 60_000;  // 3 min off

interface BreakerState {
  /** Timestamps of recent failures (epoch ms), only those within window. */
  failures: number[];
  /** Epoch ms the current cooldown ends; 0 = not tripped. */
  cooldownUntil: number;
  /** Last probe result; we restore `available` to this when the cooldown ends. */
  probeAvailable: boolean;
}
const breakers = new Map<string, BreakerState>();

function getBreaker(modelId: string, probeAvailable = true): BreakerState {
  let b = breakers.get(modelId);
  if (!b) {
    b = { failures: [], cooldownUntil: 0, probeAvailable };
    breakers.set(modelId, b);
  }
  return b;
}

/**
 * Call when a model request fails with upstream signals that suggest the
 * model itself is flaky (overload, 5xx, timeout). Returns true if the
 * breaker tripped this call (i.e. model just became unavailable).
 */
export function recordModelFailure(modelId: string, reason: string): boolean {
  const model = getModel(modelId);
  if (!model) return false;
  const now = Date.now();
  const b = getBreaker(modelId, model.available ?? true);
  // Prune failures outside the window
  b.failures = b.failures.filter((t) => now - t < BREAKER_WINDOW_MS);
  b.failures.push(now);
  if (b.failures.length >= BREAKER_THRESHOLD && b.cooldownUntil <= now) {
    b.probeAvailable = model.available ?? true;
    b.cooldownUntil = now + BREAKER_COOLDOWN_MS;
    model.available = false;
    console.warn(
      `[breaker] model ${modelId} tripped (${b.failures.length} failures in ` +
      `${BREAKER_WINDOW_MS / 1000}s, reason=${reason}). cooling for ` +
      `${BREAKER_COOLDOWN_MS / 1000}s`
    );
    return true;
  }
  return false;
}

/**
 * Call periodically (or lazily on every selection) to lift expired breakers.
 * Restores `available` to the last probe value so the model becomes
 * selectable again.
 */
export function relaxExpiredBreakers(): void {
  const now = Date.now();
  for (const [id, b] of breakers) {
    if (b.cooldownUntil > 0 && b.cooldownUntil <= now) {
      const model = getModel(id);
      if (model) {
        model.available = b.probeAvailable;
        console.info(`[breaker] model ${id} cooldown elapsed, restored available=${b.probeAvailable}`);
      }
      b.cooldownUntil = 0;
      b.failures = [];
    }
  }
}

/** Call when a model request succeeds — clear its failure window so a
 * later transient blip doesn't compound with old stale failures. */
export function recordModelSuccess(modelId: string): void {
  const b = breakers.get(modelId);
  if (b) b.failures = [];
}

// Kick off a background probe loop. Safe to call multiple times — subsequent
// calls are idempotent (replaces the timer).
let probeTimer: NodeJS.Timeout | null = null;
const PROBE_INTERVAL_MS = 10 * 60 * 1000;

export function startModelProbe(): void {
  if (probeTimer) return;
  // Fire immediately, then every 10 min.
  void probeModels().catch(() => undefined);
  probeTimer = setInterval(() => {
    void probeModels().catch(() => undefined);
  }, PROBE_INTERVAL_MS);
  // Don't hold the event loop open on SIGTERM just for the probe.
  if (typeof probeTimer.unref === "function") probeTimer.unref();
}

export function stopModelProbe(): void {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}
