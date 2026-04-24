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

export type ModelGroup = "volcano" | "anthropic" | "openai";
export type ModelProvider = "ark" | "oneapi";

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
}

// ─── Registry ────────────────────────────────────────────────────────────

export const MODELS: ModelEntry[] = [
  // ── Volcano ARK (legacy / default-fallback, zero-change behavior) ────
  {
    id: "doubao-2.0",
    displayName: "Doubao 2.0 pro",
    provider: "ark",
    // Read at registry load time. Falls back to the existing prod endpoint id
    // so a missing .env doesn't break the default path.
    providerModelId:
      process.env.SEED_MODEL ||
      process.env.ARK_MODEL ||
      "ep-20260412192731-vwdh7",
    capabilities: { thinking: false, toolUse: true, contextWindow: 128000 },
    defaults: { temperature: 0.1, maxOutputTokens: 32768 },
    group: "volcano",
    visible: true,
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
    // Claude extended thinking requires temperature=1.
    defaults: { temperature: 1.0, maxOutputTokens: 20000 },
    group: "anthropic",
    visible: true,
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
    defaults: { temperature: 1.0, maxOutputTokens: 20000 },
    group: "anthropic",
    visible: true,
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
    } else {
      next = false;
    }
    m.available = next;
    if (prev !== next) changes.push({ id: m.id, from: prev, to: next });
  }

  return { probedAt: Date.now(), changes };
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
