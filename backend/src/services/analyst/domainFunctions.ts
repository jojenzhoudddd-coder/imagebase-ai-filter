/**
 * Domain-function library — deterministic pure functions for the three
 * analyst sub-skills (finance / accounting / internet).
 *
 * Design stance (see docs/analyst-skill-plan.md §13):
 *   - Calculation layer = pure functions, 100% deterministic, unit-testable.
 *     These live here, not in the Agent or in a prompt.
 *   - Domain vocabulary / frameworks / judgment layer = prompt fragments
 *     attached to each skill (see backend/mcp-server/src/skills/*.ts).
 *   - Template tools (like cohort_analysis) wire pure functions + DuckDB
 *     operations to give the Agent a one-shot helper for common asks.
 *
 * These functions accept plain number arrays / objects — they don't touch
 * DuckDB directly. Tools that need data read it via the runtime and feed
 * arrays in here.
 */

// ─── Finance ──────────────────────────────────────────────────────────────

/**
 * Internal Rate of Return — solves NPV(rate)=0 via bisection, reasonably
 * accurate for typical capital-budgeting cashflow series.
 *
 * @param cashflows First element is the initial outflow (usually negative),
 *                  subsequent elements are period inflows.
 * @returns rate as decimal (e.g. 0.12 for 12%). NaN when no sign change or
 *          no convergence.
 */
export function irr(cashflows: number[], maxIter = 200, tol = 1e-7): number {
  if (cashflows.length < 2) return Number.NaN;
  const npv = (r: number) =>
    cashflows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + r, t), 0);

  // Scan for sign change
  let lo = -0.9999;
  let hi = 10;
  let fLo = npv(lo);
  let fHi = npv(hi);
  if (!isFinite(fLo) || !isFinite(fHi)) return Number.NaN;
  if (fLo * fHi > 0) {
    // Try wider: find any sign change by coarse scan
    let found = false;
    let prev = fLo;
    for (let r = -0.99; r <= 10; r += 0.05) {
      const v = npv(r);
      if (isFinite(v) && prev * v < 0) {
        lo = r - 0.05;
        hi = r;
        fLo = npv(lo);
        fHi = npv(hi);
        found = true;
        break;
      }
      prev = v;
    }
    if (!found) return Number.NaN;
  }

  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < tol) return mid;
    if (fLo * fMid < 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

export function npv(rate: number, cashflows: number[]): number {
  return cashflows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + rate, t), 0);
}

export function cagr(startValue: number, endValue: number, periods: number): number {
  if (startValue <= 0 || periods <= 0) return Number.NaN;
  return Math.pow(endValue / startValue, 1 / periods) - 1;
}

/** Weighted-average cost of capital. Inputs expect:
 *   equity, debt in absolute terms (market value preferred).
 *   costOfEquity, costOfDebt as decimals.
 *   taxRate as decimal for interest tax shield. */
export function wacc(
  equity: number,
  debt: number,
  costOfEquity: number,
  costOfDebt: number,
  taxRate: number,
): number {
  const totalCap = equity + debt;
  if (totalCap <= 0) return Number.NaN;
  const we = equity / totalCap;
  const wd = debt / totalCap;
  return we * costOfEquity + wd * costOfDebt * (1 - taxRate);
}

/** Sample standard deviation (Bessel-corrected). */
export function stddev(values: number[]): number {
  if (values.length < 2) return Number.NaN;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sqdiff = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0);
  return Math.sqrt(sqdiff / (values.length - 1));
}

/** Annualized volatility of a simple returns series given `periodsPerYear`
 * (252 for daily equities, 12 for monthly). */
export function volatility(returns: number[], periodsPerYear = 252): number {
  return stddev(returns) * Math.sqrt(periodsPerYear);
}

/** Sharpe ratio — (mean_return - risk_free) / stddev, annualized. */
export function sharpe(
  returns: number[],
  riskFreeRate = 0,
  periodsPerYear = 252,
): number {
  if (!returns.length) return Number.NaN;
  const meanRet = returns.reduce((a, b) => a + b, 0) / returns.length;
  const rfPerPeriod = riskFreeRate / periodsPerYear;
  const excess = meanRet - rfPerPeriod;
  const sd = stddev(returns);
  if (sd === 0 || Number.isNaN(sd)) return Number.NaN;
  return (excess / sd) * Math.sqrt(periodsPerYear);
}

/**
 * Beta — slope of a linear regression of asset returns against market returns.
 * Both arrays must be the same length. Sample covariance / sample variance.
 */
export function beta(assetReturns: number[], marketReturns: number[]): number {
  if (assetReturns.length !== marketReturns.length || assetReturns.length < 2) {
    return Number.NaN;
  }
  const n = assetReturns.length;
  const meanA = assetReturns.reduce((a, b) => a + b, 0) / n;
  const meanM = marketReturns.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varM = 0;
  for (let i = 0; i < n; i++) {
    cov += (assetReturns[i] - meanA) * (marketReturns[i] - meanM);
    varM += Math.pow(marketReturns[i] - meanM, 2);
  }
  if (varM === 0) return Number.NaN;
  return cov / varM;
}

/** Max drawdown — largest peak-to-trough decline expressed as a decimal.
 * Input: cumulative value series (NOT returns). */
export function maxDrawdown(values: number[]): number {
  if (values.length < 2) return 0;
  let peak = values[0];
  let maxDD = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }
  return maxDD;
}

// ─── Accounting ──────────────────────────────────────────────────────────

export interface DupontInputs {
  netIncome: number;
  revenue: number;
  totalAssets: number;
  equity: number;
}

export interface DupontResult {
  netProfitMargin: number;
  assetTurnover: number;
  equityMultiplier: number;
  roe: number;
  roa: number;
}

/** Three-factor DuPont decomposition: ROE = NPM × AT × EM */
export function dupontAnalysis(i: DupontInputs): DupontResult {
  const npm = i.revenue === 0 ? Number.NaN : i.netIncome / i.revenue;
  const at = i.totalAssets === 0 ? Number.NaN : i.revenue / i.totalAssets;
  const em = i.equity === 0 ? Number.NaN : i.totalAssets / i.equity;
  const roe = npm * at * em;
  const roa = i.totalAssets === 0 ? Number.NaN : i.netIncome / i.totalAssets;
  return {
    netProfitMargin: npm,
    assetTurnover: at,
    equityMultiplier: em,
    roe,
    roa,
  };
}

export function currentRatio(currentAssets: number, currentLiabilities: number): number {
  if (currentLiabilities === 0) return Number.NaN;
  return currentAssets / currentLiabilities;
}

export function quickRatio(
  currentAssets: number,
  inventory: number,
  currentLiabilities: number,
): number {
  if (currentLiabilities === 0) return Number.NaN;
  return (currentAssets - inventory) / currentLiabilities;
}

export function debtToEquity(totalDebt: number, equity: number): number {
  if (equity === 0) return Number.NaN;
  return totalDebt / equity;
}

export function grossMargin(revenue: number, cogs: number): number {
  if (revenue === 0) return Number.NaN;
  return (revenue - cogs) / revenue;
}

export function operatingMargin(revenue: number, operatingIncome: number): number {
  if (revenue === 0) return Number.NaN;
  return operatingIncome / revenue;
}

export function netMargin(revenue: number, netIncome: number): number {
  if (revenue === 0) return Number.NaN;
  return netIncome / revenue;
}

// ─── Internet / product analytics ─────────────────────────────────────────

/**
 * Compute DAU / MAU by simple union-count over (user_id, date) pairs.
 * Input rows must carry `date` (string YYYY-MM-DD or timestamp) and `userId`.
 */
export function dauMau(rows: Array<{ userId: string; date: string }>): {
  dau: Record<string, number>;
  mau: Record<string, number>;
  dauMauRatio: Record<string, number>;
} {
  const byDay = new Map<string, Set<string>>();
  const byMonth = new Map<string, Set<string>>();
  for (const r of rows) {
    const d = r.date.slice(0, 10);
    const m = d.slice(0, 7);
    if (!byDay.has(d)) byDay.set(d, new Set());
    if (!byMonth.has(m)) byMonth.set(m, new Set());
    byDay.get(d)!.add(r.userId);
    byMonth.get(m)!.add(r.userId);
  }
  const dau: Record<string, number> = {};
  for (const [k, v] of byDay.entries()) dau[k] = v.size;
  const mau: Record<string, number> = {};
  for (const [k, v] of byMonth.entries()) mau[k] = v.size;
  const dauMauRatio: Record<string, number> = {};
  for (const [d, n] of Object.entries(dau)) {
    const m = d.slice(0, 7);
    const mv = mau[m] ?? 0;
    dauMauRatio[d] = mv > 0 ? n / mv : 0;
  }
  return { dau, mau, dauMauRatio };
}

/**
 * Funnel conversion — given ordered stage list + per-user events, compute
 * absolute counts and step-over-prev conversion rates.
 *
 * Input: events[].userId, events[].stage (must match one of stages[]).
 */
export function funnelConversion(
  events: Array<{ userId: string; stage: string }>,
  stages: string[],
): {
  stage: string;
  users: number;
  conversion: number;     // vs previous stage, 0..1
  overall: number;        // vs first stage, 0..1
}[] {
  const usersPerStage: Set<string>[] = stages.map(() => new Set());
  const stageIdx = new Map(stages.map((s, i) => [s, i]));
  // A user must hit the earlier stages to count for a later one.
  const reached = new Map<string, number>(); // userId → max stage idx reached
  for (const ev of events) {
    const idx = stageIdx.get(ev.stage);
    if (idx === undefined) continue;
    const cur = reached.get(ev.userId) ?? -1;
    if (idx > cur) reached.set(ev.userId, idx);
  }
  for (const [u, maxIdx] of reached.entries()) {
    for (let i = 0; i <= maxIdx; i++) usersPerStage[i].add(u);
  }
  const first = usersPerStage[0]?.size ?? 0;
  return stages.map((s, i) => {
    const n = usersPerStage[i].size;
    const prev = i === 0 ? n : usersPerStage[i - 1].size;
    return {
      stage: s,
      users: n,
      conversion: i === 0 ? 1 : prev === 0 ? 0 : n / prev,
      overall: first === 0 ? 0 : n / first,
    };
  });
}

/**
 * Retention cohort analysis — given events with firstSeen + eventDate,
 * compute period-over-period retention.
 *
 * Input: events[].userId, events[].date (ISO).
 * Returns: rows of { cohort, period_0, period_1, ... } where cohort is the
 * user's first-active period label, period_N is the retention rate at
 * granularity N.
 */
export function cohortRetention(
  events: Array<{ userId: string; date: string }>,
  options: { granularity: "day" | "week" | "month"; periods: number },
): Array<Record<string, string | number>> {
  const bucket = bucketFn(options.granularity);
  const firstSeen = new Map<string, string>();
  const userEvents = new Map<string, Set<string>>();
  for (const ev of events) {
    const b = bucket(ev.date);
    const curFirst = firstSeen.get(ev.userId);
    if (!curFirst || b < curFirst) firstSeen.set(ev.userId, b);
    if (!userEvents.has(ev.userId)) userEvents.set(ev.userId, new Set());
    userEvents.get(ev.userId)!.add(b);
  }
  // Group users by cohort
  const byCohort = new Map<string, string[]>();
  for (const [u, c] of firstSeen.entries()) {
    if (!byCohort.has(c)) byCohort.set(c, []);
    byCohort.get(c)!.push(u);
  }
  const rows: Array<Record<string, string | number>> = [];
  const sortedCohorts = Array.from(byCohort.keys()).sort();
  for (const cohort of sortedCohorts) {
    const users = byCohort.get(cohort)!;
    const base = users.length;
    const row: Record<string, string | number> = { cohort, size: base };
    for (let p = 0; p <= options.periods; p++) {
      const targetBucket = addBucket(cohort, options.granularity, p);
      let active = 0;
      for (const u of users) {
        if (userEvents.get(u)?.has(targetBucket)) active++;
      }
      row[`period_${p}`] = base === 0 ? 0 : active / base;
    }
    rows.push(row);
  }
  return rows;
}

/** ARPU / ARPPU — average revenue per user / per paying user. */
export function arpu(rows: Array<{ userId: string; revenue: number }>): {
  users: number;
  payingUsers: number;
  totalRevenue: number;
  arpu: number;
  arppu: number;
} {
  const perUser = new Map<string, number>();
  for (const r of rows) perUser.set(r.userId, (perUser.get(r.userId) ?? 0) + r.revenue);
  const users = perUser.size;
  let totalRevenue = 0;
  let payingUsers = 0;
  for (const rev of perUser.values()) {
    totalRevenue += rev;
    if (rev > 0) payingUsers++;
  }
  return {
    users,
    payingUsers,
    totalRevenue,
    arpu: users === 0 ? 0 : totalRevenue / users,
    arppu: payingUsers === 0 ? 0 : totalRevenue / payingUsers,
  };
}

function bucketFn(g: "day" | "week" | "month"): (iso: string) => string {
  if (g === "day") return (s) => s.slice(0, 10);
  if (g === "month") return (s) => s.slice(0, 7);
  // week: ISO week string yyyy-Wnn
  return (s) => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "";
    const y = d.getUTCFullYear();
    const onejan = new Date(Date.UTC(y, 0, 1));
    const dayOfYear = Math.floor((d.getTime() - onejan.getTime()) / 86_400_000);
    const week = Math.ceil((dayOfYear + onejan.getUTCDay() + 1) / 7);
    return `${y}-W${String(week).padStart(2, "0")}`;
  };
}

function addBucket(bucket: string, g: "day" | "week" | "month", periods: number): string {
  if (g === "day") {
    const d = new Date(bucket + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + periods);
    return d.toISOString().slice(0, 10);
  }
  if (g === "month") {
    const [y, m] = bucket.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + periods, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  // week: advance by N * 7 days then re-bucket
  const match = bucket.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return bucket;
  const y = Number(match[1]);
  const w = Number(match[2]);
  const onejan = new Date(Date.UTC(y, 0, 1));
  const firstMondayOffset = (8 - onejan.getUTCDay()) % 7;
  const firstMonday = new Date(Date.UTC(y, 0, 1 + firstMondayOffset));
  firstMonday.setUTCDate(firstMonday.getUTCDate() + (w - 1 + periods) * 7);
  const newY = firstMonday.getUTCFullYear();
  const newOneJan = new Date(Date.UTC(newY, 0, 1));
  const doy = Math.floor((firstMonday.getTime() - newOneJan.getTime()) / 86_400_000);
  const newWeek = Math.ceil((doy + newOneJan.getUTCDay() + 1) / 7);
  return `${newY}-W${String(newWeek).padStart(2, "0")}`;
}
