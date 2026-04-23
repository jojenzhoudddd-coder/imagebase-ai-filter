/**
 * Application-side ID generator — returns IDs in the format `<prefix><12 digits>`.
 *
 * Replaces Prisma's `@default(cuid())` for new entities declared since the
 * Vibe Demo plan (see docs/vibe-demo-plan.md §3.5). Legacy entities with
 * cuid ids remain supported by the router layer — the format of *new* IDs
 * is the only thing this changes.
 *
 * Why digits and not base62:
 *   User-facing IDs (e.g. visible in URL `/workspace/.../table/tb123...`)
 *   are more readable as digits; base62 capacity isn't needed at 12
 *   positions. 10^12 ≈ 10^12 combos; at 1M live entities collision probability
 *   per insert is ~5×10^-7, and the retry loop handles the rare hit.
 *
 * Scoping:
 *   Callers pass an async `existsCheck(id)` so the generator can be reused
 *   across any Prisma model without this file importing the client. Keeps
 *   the module tiny and testable (mock existsCheck in unit tests).
 */

export const ID_PREFIXES = {
  table: "tb",
  taste: "ts",
  design: "dg",
  demo: "dm",
  idea: "ide",           // intentional 3-char — matches user's decision
  workspace: "ws",
  conversation: "cv",
  agent: "ag",
  record: "rc",
  field: "fd",
  view: "vw",
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
  existsCheck: (id: string) => Promise<boolean>,
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
export const NEW_ID_PATTERNS: Record<IdKind, RegExp> = {
  table:         /^tb\d{12}$/,
  taste:         /^ts\d{12}$/,
  design:        /^dg\d{12}$/,
  demo:          /^dm\d{12}$/,
  idea:          /^ide\d{12}$/,
  workspace:     /^ws\d{12}$/,
  conversation:  /^cv\d{12}$/,
  agent:         /^ag\d{12}$/,
  record:        /^rc\d{12}$/,
  field:         /^fd\d{12}$/,
  view:          /^vw\d{12}$/,
};

export function isNewFormatId(kind: IdKind, id: string): boolean {
  return NEW_ID_PATTERNS[kind].test(id);
}

// ─── internal ────────────────────────────────────────────────────────────

function randomDigits(n: number): string {
  // Build by hand to avoid Math.random rounding — use crypto for uniformity.
  // Each iteration grabs one 32-bit value and converts to modulo 10 digits.
  // Over 12 digits there's a marginal bias (2^32 % 10 ≠ 0) but it's
  // immaterial for collision resistance at this scale.
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
