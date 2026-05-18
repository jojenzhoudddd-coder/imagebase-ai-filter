/**
 * cronScheduler — evaluate an agent's cron.json on every heartbeat tick and
 * fan out due jobs into the inbox.
 *
 * Phase 4 Day 2 scope:
 *   - Parse a 5-field cron expression: `minute hour day-of-month month day-of-week`
 *     Supports: `*`, literals, lists (`1,3,5`), ranges (`2-6`), steps (`* / 5`).
 *     Also supports the common alias `@hourly` / `@daily` / `@weekly` /
 *     `@monthly` / `@yearly`.
 *   - `nextFireAfter(expr, from)` — returns the next minute `>= from + 1min`
 *     that matches the expression. (Forward step from `from`, not including
 *     `from` itself.)
 *   - `evaluateCron(agentId, now)` — read cron.json, for each job compute
 *     whether a fire moment is due (`next <= now`). If so, append one inbox
 *     message and bump `lastFiredAt = now`. At most one fire per job per
 *     evaluation — we don't replay missed fires after downtime, the most
 *     recent slot is the one we care about.
 *
 * Design notes:
 *   - Pure functions for the parser + matcher so the smoke test can verify
 *     "minute X matches expr Y" without touching the filesystem.
 *   - `evaluateCron` is idempotent within a minute: calling it twice with
 *     the same `now` for a job that already fired this tick is a no-op
 *     (the `lastFiredAt` guard kicks in).
 *   - No external dependency on `cron-parser` — the expressions we care
 *     about are simple, and adding a 150kb dep to the backend for one
 *     feature is not worth it.
 */

import {
  readCron,
  writeCron,
  appendInboxMessage,
  getAgent,
  getHabitOverride,
  setHabitOverride,
  type CronJob,
  type InboxMessage,
} from "./agentService.js";
import { listUserWorkspaces } from "./authService.js";

// ─── Cron expression parsing ────────────────────────────────────────────

/** Parsed cron: each field is a sorted ascending list of allowed values. */
export interface ParsedCron {
  minute: number[];     // 0..59
  hour: number[];       // 0..23
  dayOfMonth: number[]; // 1..31
  month: number[];      // 1..12
  dayOfWeek: number[];  // 0..6, Sunday = 0
  /** True iff both dayOfMonth and dayOfWeek were restricted (not `*`). In
   *  that case Vixie-cron's "OR" semantics apply: a date matches when
   *  either restriction matches. */
  bothDaysRestricted: boolean;
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // dayOfMonth
  [1, 12],  // month
  [0, 6],   // dayOfWeek (Sunday = 0)
];

const ALIASES: Record<string, string> = {
  "@yearly":  "0 0 1 1 *",
  "@annually":"0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly":  "0 0 * * 0",
  "@daily":   "0 0 * * *",
  "@midnight":"0 0 * * *",
  "@hourly":  "0 * * * *",
};

function expandField(raw: string, [lo, hi]: [number, number]): number[] | null {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const out = new Set<number>();
  for (const part of parts) {
    // Step: base/step, where base can be `*`, a single value, or a range.
    let base = part;
    let step = 1;
    const stepIdx = part.indexOf("/");
    if (stepIdx >= 0) {
      base = part.slice(0, stepIdx) || "*";
      const s = Number(part.slice(stepIdx + 1));
      if (!Number.isInteger(s) || s <= 0) return null;
      step = s;
    }
    let from: number;
    let to: number;
    if (base === "*") {
      from = lo;
      to = hi;
    } else if (base.includes("-")) {
      const [a, b] = base.split("-", 2).map((x) => Number(x.trim()));
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      from = a;
      to = b;
    } else {
      const n = Number(base);
      if (!Number.isInteger(n)) return null;
      from = n;
      to = n;
    }
    if (from < lo || to > hi || from > to) return null;
    for (let v = from; v <= to; v++) {
      if ((v - from) % step === 0) out.add(v);
    }
  }
  if (out.size === 0) return null;
  return [...out].sort((a, b) => a - b);
}

/** Parse a cron expression. Returns null on malformed input. */
export function parseCron(expr: string): ParsedCron | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  const resolved = ALIASES[trimmed.toLowerCase()] ?? trimmed;
  const parts = resolved.split(/\s+/);
  if (parts.length !== 5) return null;

  const fields: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const expanded = expandField(parts[i], FIELD_RANGES[i]);
    if (!expanded) return null;
    fields.push(expanded);
  }

  const bothDaysRestricted = parts[2] !== "*" && parts[4] !== "*";
  return {
    minute: fields[0],
    hour: fields[1],
    dayOfMonth: fields[2],
    month: fields[3],
    dayOfWeek: fields[4],
    bothDaysRestricted,
  };
}

/** Does this specific minute match the parsed cron expression? */
export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();

  if (!parsed.minute.includes(minute)) return false;
  if (!parsed.hour.includes(hour)) return false;
  if (!parsed.month.includes(month)) return false;

  // Vixie-cron day semantics:
  //   If both dayOfMonth and dayOfWeek are restricted → OR
  //   If only one is restricted → that one must match
  //   If neither is restricted → always true
  const domMatch = parsed.dayOfMonth.includes(dom);
  const dowMatch = parsed.dayOfWeek.includes(dow);
  if (parsed.bothDaysRestricted) {
    if (!(domMatch || dowMatch)) return false;
  } else {
    if (!domMatch) return false;
    if (!dowMatch) return false;
  }
  return true;
}

/**
 * Next fire moment strictly *after* `from`. Walks minute-by-minute up to
 * `limitMinutes` steps (default = 2 years of minutes) and returns null if
 * nothing matches within that window (only happens for pathological
 * expressions like `0 0 31 2 *`).
 */
export function nextFireAfter(
  parsed: ParsedCron,
  from: Date,
  opts?: { limitMinutes?: number }
): Date | null {
  const limit = opts?.limitMinutes ?? 2 * 365 * 24 * 60;
  // Step to the next full minute after `from`. We never fire ON `from` itself —
  // the caller owns the "have I already fired at this minute" check via
  // `lastFiredAt`.
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  for (let i = 0; i < limit; i++) {
    if (cronMatches(parsed, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

// ─── Per-agent evaluation lock ─────────────────────────────────────────
//
// Prevents TOCTOU race: two concurrent evaluateCron calls for the same agent
// could both read the same cron.json (with lastFiredAt = null), each append
// an InboxMessage, then both write back — resulting in a duplicated fire.
// A per-agent promise-based semaphore serializes evaluation.

const evaluateLocks = new Map<string, Promise<EvaluateCronResult>>();

function effectiveCronJob(
  job: CronJob,
  override: Awaited<ReturnType<typeof getHabitOverride>> | null,
  workspaceId?: string,
): CronJob {
  return {
    ...job,
    workspaceId: workspaceId ?? job.workspaceId,
    schedule: override?.schedule ?? job.schedule,
    enabled: override?.enabled ?? job.enabled,
    lastFiredAt: override?.lastFiredAt !== undefined ? override.lastFiredAt : job.lastFiredAt,
  };
}

async function resolveJobWorkspaceIds(agentId: string, job: CronJob): Promise<Array<string | undefined>> {
  if (job.workspaceId) return [job.workspaceId];
  if (job.type !== "system") return [undefined];
  const agent = await getAgent(agentId);
  if (!agent?.userId) return [];
  const workspaces = await listUserWorkspaces(agent.userId);
  return workspaces.map((ws) => ws.id).filter(Boolean);
}

// ─── Evaluation (reads cron.json, fires due jobs) ───────────────────────

export interface EvaluateCronResult {
  fired: Array<{
    job: CronJob;
    inboxMessage: InboxMessage;
  }>;
  skipped: Array<{
    job: CronJob;
    reason: "not-due" | "invalid-expression" | "never-fires" | "disabled";
  }>;
}

/**
 * Walk the agent's cron.json and fire any jobs that are due at `now`.
 *
 * A job is "due" when `nextFireAfter(expr, baseline) <= now`, where
 * `baseline = lastFiredAt ?? now - 1h` (so a freshly-created job doesn't
 * back-fire for every matching minute in history — we only look one hour
 * back, which is plenty for our minute-granular grid).
 *
 * Each firing appends one `InboxMessage` and sets `lastFiredAt = now`.
 * The function never fires more than once per job per call — we don't
 * replay missed fires after long downtimes.
 */
export async function evaluateCron(
  agentId: string,
  now: Date = new Date()
): Promise<EvaluateCronResult> {
  // Serialize per-agent: wait for any in-flight evaluation to finish before
  // starting ours. This prevents the TOCTOU race where two concurrent calls
  // both read stale lastFiredAt and each fire the same job.
  const prev = evaluateLocks.get(agentId) ?? Promise.resolve({} as EvaluateCronResult);
  const current = prev.catch(() => {}).then(() => evaluateCronImpl(agentId, now));
  evaluateLocks.set(agentId, current);
  try {
    return await current;
  } finally {
    // Clean up if we're still the latest — avoids unbounded Map growth
    if (evaluateLocks.get(agentId) === current) evaluateLocks.delete(agentId);
  }
}

async function evaluateCronImpl(
  agentId: string,
  now: Date
): Promise<EvaluateCronResult> {
  const cron = await readCron(agentId);
  const result: EvaluateCronResult = { fired: [], skipped: [] };
  let dirty = false;

  for (const job of cron.jobs) {
    const workspaceIds = await resolveJobWorkspaceIds(agentId, job);
    if (workspaceIds.length === 0) {
      result.skipped.push({ job, reason: "disabled" });
      continue;
    }
    for (const workspaceId of workspaceIds) {
      const override = workspaceId ? await getHabitOverride(agentId, workspaceId, job.id) : null;
      const effectiveJob = effectiveCronJob(job, override, workspaceId);
      // Skip disabled habits
      if ((effectiveJob as any).enabled === false) {
        result.skipped.push({ job: effectiveJob, reason: "disabled" });
        continue;
      }
      const parsed = parseCron(effectiveJob.schedule);
      if (!parsed) {
        result.skipped.push({ job: effectiveJob, reason: "invalid-expression" });
        continue;
      }
      const lastFiredAt = effectiveJob.lastFiredAt ? new Date(effectiveJob.lastFiredAt) : null;
      // Baseline = lastFiredAt, or an hour ago for freshly-created jobs so we
      // don't back-fire through history.
      const baseline = lastFiredAt ?? new Date(now.getTime() - 60 * 60 * 1000);
      const next = nextFireAfter(parsed, baseline);
      if (!next) {
        result.skipped.push({ job: effectiveJob, reason: "never-fires" });
        continue;
      }
      if (next.getTime() > now.getTime()) {
        result.skipped.push({ job: effectiveJob, reason: "not-due" });
        continue;
      }
      // Fire. Append inbox, bump lastFiredAt.
      const inboxMessage = await appendInboxMessage(agentId, {
        source: "cron",
        subject: `Cron: ${effectiveJob.prompt}`,
        body: effectiveJob.prompt,
        meta: {
          cronJobId: effectiveJob.id,
          schedule: effectiveJob.schedule,
          workspaceId: effectiveJob.workspaceId,
          skills: effectiveJob.skills,
        },
      });
      const firedAt = now.toISOString();
      effectiveJob.lastFiredAt = firedAt;
      if (workspaceId) {
        await setHabitOverride(agentId, workspaceId, job.id, { lastFiredAt: firedAt });
      } else {
        job.lastFiredAt = firedAt;
        dirty = true;
      }
      result.fired.push({ job: effectiveJob, inboxMessage });
    }
  }

  if (dirty) await writeCron(agentId, cron);
  return result;
}

// ─── Cron CRUD helpers (the Agent or REST endpoints will call these) ────

export async function addCronJob(
  agentId: string,
  input: Omit<CronJob, "id" | "lastFiredAt"> & { id?: string }
): Promise<CronJob> {
  const parsed = parseCron(input.schedule);
  if (!parsed) throw new Error(`invalid cron schedule: ${input.schedule}`);
  const cron = await readCron(agentId);
  const job: CronJob = {
    id: input.id ?? `cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    schedule: input.schedule,
    prompt: input.prompt,
    workspaceId: input.workspaceId,
    skills: input.skills,
    lastFiredAt: null,
    meta: input.meta,
    // V4.6: 持久化 UI 标题 / 描述,避免 custom habit 在 HabitsTab 把整段
    // prompt 灌进卡片标题(导致 badge 顶到第二行)。schedule_task MCP 工具
    // 现在会要求 Agent 同时给出 displayName + description。
    displayName: input.displayName,
    description: input.description,
    type: input.type,
    enabled: input.enabled,
  };
  cron.jobs.push(job);
  await writeCron(agentId, cron);
  return job;
}

export async function removeCronJob(agentId: string, jobId: string): Promise<boolean> {
  const cron = await readCron(agentId);
  const idx = cron.jobs.findIndex((j) => j.id === jobId);
  if (idx < 0) return false;
  cron.jobs.splice(idx, 1);
  await writeCron(agentId, cron);
  return true;
}

export async function listCronJobs(
  agentId: string,
  opts?: { workspaceId?: string | null },
): Promise<CronJob[]> {
  const cron = await readCron(agentId);
  const workspaceId = typeof opts?.workspaceId === "string" && opts.workspaceId.trim()
    ? opts.workspaceId.trim()
    : "";
  if (workspaceId) {
    const jobs: CronJob[] = [];
    for (const job of cron.jobs) {
      if (job.workspaceId && job.workspaceId !== workspaceId) continue;
      const override = await getHabitOverride(agentId, workspaceId, job.id);
      jobs.push(effectiveCronJob(job, override, workspaceId));
    }
    return jobs;
  }
  return cron.jobs.slice();
}
