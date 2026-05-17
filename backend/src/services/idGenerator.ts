/**
 * Application-side ID generator — unified format `{2-char prefix}{12 digits}`.
 *
 * Every entity type gets a unique 2-letter prefix + 12 random digits = 14 chars
 * total. Readable, URL-friendly, globally unique across all tables.
 *
 * 10^12 ≈ 1 trillion combos per prefix; at 1M live entities collision
 * probability per insert is ~5×10^-7, and the retry loop handles the rare hit.
 *
 * Migration note: legacy entities may still have cuid IDs or hardcoded strings
 * (e.g. "user_default", "agent_default"). The router layer accepts both formats.
 * Phase 2 migration will convert all legacy IDs to the new format.
 */

export const ID_PREFIXES = {
  user:             "us",
  agent:            "ag",
  workspace:        "ws",
  table:            "tb",
  idea:             "ia",
  design:           "ds",
  taste:            "ts",
  demo:             "dm",
  conversation:     "cv",
  folder:           "fd",
  field:            "fl",
  record:           "rc",
  view:             "vw",
  message:          "ms",
  subagentRun:      "sr",
  userSkill:        "sk",
  knowledgeEntry:   "ke",
  tokenUsage:       "tu",
  ideaAttachment:   "at",
  ideaBlock:        "ib",
  mention:          "mn",
  customModel:      "cm",
  integration:      "ig",
  integrationCredential: "ic",
  org:              "og",
  orgMember:        "om",
  workflowRun:      "wf",
  chatTurnRun:      "tr",
  chatTurnEvent:    "te",
  agencySession:    "as",
  agencyMilestone:  "am",
  agencyCheckpoint: "ac",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const DIGITS_LEN = 12;
const MAX_RETRY = 5;

/**
 * Generate a new unique id of the given kind.
 * @param kind one of the declared entity kinds
 * @param existsCheck async predicate that returns true if the candidate
 *   id already exists in the target store (returning true triggers retry)
 * @throws when MAX_RETRY consecutive candidates all collide — in practice
 *   this means the id space is exhausted or the check is bugged
 */
export async function generateId(
  kind: IdKind,
  existsCheck: (id: string) => Promise<boolean> = async () => false,
): Promise<string> {
  const prefix = ID_PREFIXES[kind];
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const digits = randomDigits(DIGITS_LEN);
    const id = `${prefix}${digits}`;
    if (!(await existsCheck(id))) return id;
  }
  throw new Error(
    `idGenerator: ${MAX_RETRY} consecutive collisions for ${kind}; check existsCheck`,
  );
}

/**
 * Synchronous version for cases where uniqueness doesn't matter (e.g.
 * per-request temp ids, in-memory caches). Don't use for persisted rows.
 */
export function generateIdSync(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}${randomDigits(DIGITS_LEN)}`;
}

/**
 * Regex for the new format, used by router to distinguish new ids from
 * legacy cuid / pre-cuid prefixed ids. Legacy patterns continue to be
 * accepted as valid params — this regex is only for "is this a new-style
 * id" checks in places that care.
 */
export function newIdPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}\\d{${DIGITS_LEN}}$`);
}

export function isNewFormatId(kind: IdKind, id: string): boolean {
  return newIdPattern(kind).test(id);
}

// ─── internal ────────────────────────────────────────────────────────────

function randomDigits(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = crypto.getRandomValues(new Uint32Array(1))[0]!;
    out.push(String(r % 10));
  }
  return out.join("");
}

// Node 19+ has globalThis.crypto, but keep a guard for older envs.
declare const crypto: {
  getRandomValues(arr: Uint32Array): Uint32Array;
};
