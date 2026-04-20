/**
 * Phase 4 Day 1+2+3 smoke test — heartbeat runtime + cron scheduler +
 * inbox ack + agent-facing cron tools.
 *
 * Run with:
 *   AGENT_HOME=/tmp/imagebase-phase4-smoke \
 *     npx tsx backend/src/scripts/phase4-runtime-smoke.ts
 *
 * Day 3 coverage (bottom of file):
 *   - ackInboxMessage flips unread → read, second call returns the already-
 *     read record, missing id returns null
 *   - inboxUnreadCount reflects ack state
 *   - schedule_task tool handler validates cron, writes cron.json, returns
 *     nextFireAt. list_scheduled_tasks returns the job with parseError:null.
 *     cancel_task removes it; subsequent cancel returns ok:false.
 *   - schedule_task with bad cron returns {ok:false, error} (no throw)
 *
 * Day 1 coverage:
 *   - ensureAgentFiles bootstraps state/ files (inbox.jsonl, cron.json,
 *     heartbeat.log) with sane defaults
 *   - startHeartbeat() returns a running state; tickNow() force-fires one
 *     tick; stopHeartbeat() waits for in-flight work
 *   - Each tick appends exactly one JSONL line per agent to
 *     state/heartbeat.log, with the outcome the handler returned
 *   - Error isolation: a handler that throws on agent A does NOT block
 *     the tick from landing an "error" entry for A, and still lands a
 *     successful entry for agent B in the same tick
 *   - Cron + inbox read/write helpers round-trip correctly
 *   - Double-start is a no-op (second call returns the same state)
 *
 * Day 2 coverage:
 *   - parseCron accepts 5-field expressions + @hourly/@daily aliases, and
 *     rejects malformed input
 *   - cronMatches respects each field + Vixie-cron "OR" day semantics
 *   - nextFireAfter walks forward (never returns the `from` minute itself)
 *   - evaluateCron fires due jobs exactly once per call, appends one inbox
 *     message per fire, and bumps lastFiredAt — calling it twice at the
 *     same `now` is a no-op on the second call
 *   - addCronJob validates the expression and rejects garbage
 *   - The heartbeat, when wired to evaluateCron, produces an
 *     outcome:"triggered" entry with details.cronFired listing the job ids
 *
 * No DB required — the test injects a synthetic `listAgents` supplier.
 */

import fs from "fs/promises";
import path from "path";
import {
  ensureAgentFiles,
  agentDir,
  readHeartbeatLog,
  readInbox,
  appendInboxMessage,
  ackInboxMessage,
  inboxUnreadCount,
  readCron,
  writeCron,
  type AgentMeta,
} from "../services/agentService.js";
import { cronTools } from "../../mcp-server/src/tools/cronTools.js";
import {
  startHeartbeat,
  stopHeartbeat,
  tickNow,
  getRuntimeState,
} from "../services/runtimeService.js";
import {
  parseCron,
  cronMatches,
  nextFireAfter,
  evaluateCron,
  addCronJob,
  removeCronJob,
  listCronJobs,
} from "../services/cronScheduler.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("assertion failed: " + msg);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // ── 0. Setup: two synthetic agents, no DB ──────────────────────────────
  const agents: Pick<AgentMeta, "id">[] = [
    { id: "agent_alpha" },
    { id: "agent_beta" },
  ];
  for (const a of agents) {
    await ensureAgentFiles(a.id);
  }

  // ── 1. state/ files bootstrapped by ensureAgentFiles ───────────────────
  for (const a of agents) {
    const stateDir = path.join(agentDir(a.id), "state");
    assert(await fileExists(path.join(stateDir, "inbox.jsonl")), `${a.id} inbox.jsonl missing`);
    assert(await fileExists(path.join(stateDir, "cron.json")), `${a.id} cron.json missing`);
    assert(
      await fileExists(path.join(stateDir, "heartbeat.log")),
      `${a.id} heartbeat.log missing`
    );
  }
  console.log("✓ state/ files bootstrapped for both agents");

  // ── 2. cron.json default shape ─────────────────────────────────────────
  const cronAlpha0 = await readCron("agent_alpha");
  assert(Array.isArray(cronAlpha0.jobs), "cron.json default should have jobs: []");
  assert(cronAlpha0.jobs.length === 0, "cron.json should start empty");

  // Write + read round-trip.
  await writeCron("agent_alpha", {
    jobs: [
      {
        id: "cron_demo",
        schedule: "0 17 * * 5",
        prompt: "weekly summary",
      },
    ],
  });
  const cronAlpha1 = await readCron("agent_alpha");
  assert(cronAlpha1.jobs.length === 1, "cron round-trip lost job");
  assert(cronAlpha1.jobs[0].prompt === "weekly summary", "cron prompt wrong");
  console.log("✓ cron.json read/write round-trip works");

  // ── 3. inbox round-trip ────────────────────────────────────────────────
  const msg = await appendInboxMessage("agent_beta", {
    source: "cron",
    subject: "test message",
    body: "hello",
  });
  assert(msg.unread === true, "new inbox message should be unread by default");
  const inbox = await readInbox("agent_beta", { onlyUnread: true });
  assert(inbox.length === 1, `expected 1 unread, got ${inbox.length}`);
  assert(inbox[0].subject === "test message", "inbox subject mismatch");
  console.log("✓ inbox round-trip works");

  // ── 4. Heartbeat start/tick/stop with injected agent list ──────────────
  // Alpha always succeeds. Beta fails on its 2nd tick only — this lets us
  // verify (a) error isolation (alpha still logs fine in the same tick),
  // and (b) that a one-off handler throw doesn't kill the loop.
  const betaCalls = { n: 0 };
  const handler = async (ctx: { agentId: string }) => {
    if (ctx.agentId === "agent_beta") {
      betaCalls.n += 1;
      if (betaCalls.n === 2) {
        throw new Error("synthetic tick failure");
      }
    }
    return { outcome: "idle" as const, details: { agent: ctx.agentId } };
  };

  const running = startHeartbeat({
    intervalMs: 60_000, // interval irrelevant; we drive via tickNow()
    onTick: handler,
    listAgents: async () => agents,
    // Quieter logs for the smoke output.
    logger: { log: () => {}, warn: () => {}, error: console.error },
  });
  assert(getRuntimeState() !== null, "runtime should be running");
  assert(
    (getRuntimeState()?.ticksFired ?? -1) === 0,
    "ticksFired should start at 0"
  );

  // Double-start should be a no-op.
  const running2 = startHeartbeat({ onTick: handler, listAgents: async () => agents });
  assert(running === running2, "double-start should return the same state");
  console.log("✓ startHeartbeat is idempotent");

  // Fire two ticks by hand.
  await tickNow();
  await tickNow();
  const ticksFired = getRuntimeState()?.ticksFired ?? -1;
  assert(ticksFired === 2, `expected 2 ticks, got ${ticksFired}`);

  // ── 5. heartbeat.log has one entry per agent per tick ──────────────────
  const alphaLog = await readHeartbeatLog("agent_alpha");
  const betaLog = await readHeartbeatLog("agent_beta");
  assert(alphaLog.length === 2, `alpha log should have 2 entries, got ${alphaLog.length}`);
  assert(betaLog.length === 2, `beta log should have 2 entries, got ${betaLog.length}`);
  assert(alphaLog.every((e) => e.outcome === "idle"), "alpha should be all idle");
  // Beta: on call #2 the synthetic failure fires, tick #1 was call #1 (success),
  // tick #2 was call #2 (failure).
  assert(betaLog[0].outcome === "idle", "beta tick #1 should be idle");
  assert(betaLog[1].outcome === "error", "beta tick #2 should be error");
  const errorEntry = betaLog[1];
  assert(
    typeof errorEntry.details?.message === "string" &&
      (errorEntry.details.message as string).includes("synthetic tick failure"),
    "error entry should preserve the thrown message"
  );
  console.log("✓ heartbeat.log per-agent fanout + error isolation works");

  // ── 6. tail: read recent entries only ──────────────────────────────────
  const alphaTail = await readHeartbeatLog("agent_alpha", { tail: 1 });
  assert(alphaTail.length === 1, "tail=1 should return 1 entry");
  assert(alphaTail[0].tickId === alphaLog[1].tickId, "tail should be the newest entry");

  // ── 7. Clean shutdown ──────────────────────────────────────────────────
  await stopHeartbeat();
  assert(getRuntimeState() === null, "runtime should be stopped");
  console.log("✓ stopHeartbeat resolves cleanly");

  // ═══ Day 2: Cron parser + scheduler ═════════════════════════════════════

  // ── 8. parseCron basics ────────────────────────────────────────────────
  const p1 = parseCron("*/15 * * * *");
  assert(p1 !== null, "*/15 * * * * should parse");
  assert(
    p1!.minute.join(",") === "0,15,30,45",
    `minute step wrong: ${p1!.minute.join(",")}`
  );
  assert(p1!.hour.length === 24, "hour * should be 0..23");

  const p2 = parseCron("0 9 * * 1-5");
  assert(p2 !== null, "weekday 9am should parse");
  assert(p2!.dayOfWeek.join(",") === "1,2,3,4,5", "1-5 should expand");

  const p3 = parseCron("@daily");
  assert(p3 !== null, "@daily alias should parse");
  assert(
    p3!.minute.join(",") === "0" && p3!.hour.join(",") === "0",
    "@daily should be 0 0 * * *"
  );

  const p4 = parseCron("0 9,17 * * *");
  assert(p4 !== null, "list syntax should parse");
  assert(p4!.hour.join(",") === "9,17", "hour list wrong");

  // Malformed inputs must return null — no throwing from the parser.
  for (const bad of ["", "abc", "60 * * * *", "* * 32 * *", "* * * 13 *", "* * * * 7", "0 0 * *"]) {
    assert(parseCron(bad) === null, `bad cron should be null: ${JSON.stringify(bad)}`);
  }
  console.log("✓ parseCron handles valid + rejects invalid");

  // ── 9. cronMatches + Vixie day semantics ───────────────────────────────
  // "0 9 * * 1" = Mondays at 09:00. 2026-04-20 is Monday.
  const mondayNine = new Date(2026, 3, 20, 9, 0, 0);
  const mondayTen = new Date(2026, 3, 20, 10, 0, 0);
  const tuesNine = new Date(2026, 3, 21, 9, 0, 0);
  const parsedMon9 = parseCron("0 9 * * 1")!;
  assert(cronMatches(parsedMon9, mondayNine), "Monday 09:00 should match 0 9 * * 1");
  assert(!cronMatches(parsedMon9, mondayTen), "Monday 10:00 should not match");
  assert(!cronMatches(parsedMon9, tuesNine), "Tuesday 09:00 should not match");

  // Vixie OR: "0 12 1 * 1" = 1st of month OR Monday, at 12:00.
  const parsedOr = parseCron("0 12 1 * 1")!;
  assert(parsedOr.bothDaysRestricted, "both days should be flagged restricted");
  const wed1st = new Date(2026, 3, 1, 12, 0, 0); // 2026-04-01 Wed
  const mondayTwelve = new Date(2026, 3, 20, 12, 0, 0); // 2026-04-20 Mon
  const wed8th = new Date(2026, 3, 8, 12, 0, 0); // neither 1st nor Monday
  assert(cronMatches(parsedOr, wed1st), "1st of month should match (OR)");
  assert(cronMatches(parsedOr, mondayTwelve), "Monday should match (OR)");
  assert(!cronMatches(parsedOr, wed8th), "neither should not match");
  console.log("✓ cronMatches respects Vixie day OR semantics");

  // ── 10. nextFireAfter always moves forward ─────────────────────────────
  const every5 = parseCron("*/5 * * * *")!;
  const from = new Date(2026, 3, 20, 10, 7, 0);
  const next = nextFireAfter(every5, from);
  assert(next !== null, "next fire should be computable");
  assert(
    next!.getTime() > from.getTime(),
    "nextFireAfter must move strictly forward"
  );
  assert(
    next!.getMinutes() === 10,
    `next */5 after 10:07 should be 10:10, got :${next!.getMinutes()}`
  );

  // From an aligned minute should still step forward (not return same minute).
  const aligned = new Date(2026, 3, 20, 10, 10, 0);
  const nextFromAligned = nextFireAfter(every5, aligned);
  assert(
    nextFromAligned!.getMinutes() === 15,
    `from aligned 10:10 next should be 10:15, got :${nextFromAligned!.getMinutes()}`
  );
  console.log("✓ nextFireAfter walks forward, never returns `from`");

  // ── 11. addCronJob validates + round-trips ─────────────────────────────
  let threw = false;
  try {
    await addCronJob("agent_alpha", {
      schedule: "not a cron",
      prompt: "should fail",
    });
  } catch (e) {
    threw = true;
  }
  assert(threw, "addCronJob should reject invalid schedule");

  // Alpha had one job from Day 1 setup ("cron_demo"). Clear it for hermetic
  // Day 2 testing.
  const alphaCron0 = await listCronJobs("agent_alpha");
  for (const j of alphaCron0) await removeCronJob("agent_alpha", j.id);

  const dailyJob = await addCronJob("agent_alpha", {
    schedule: "@daily",
    prompt: "每日总结",
  });
  assert(dailyJob.schedule === "@daily", "schedule preserved");
  assert(dailyJob.lastFiredAt === null, "new job has no lastFiredAt");
  const alphaCron1 = await listCronJobs("agent_alpha");
  assert(alphaCron1.length === 1, `expected 1 job, got ${alphaCron1.length}`);
  console.log("✓ addCronJob validates + persists");

  // ── 12. evaluateCron fires due jobs once, skips when not due ───────────
  // Pick a `now` that is AFTER the last @daily fire (midnight of some day).
  // With baseline = lastFiredAt ?? now-1h, and @daily fires at 00:00, the
  // easiest test: `now = 2026-04-20 00:30`, and the cron job was created
  // with no lastFiredAt — so evaluateCron picks next-fire-after
  // (now - 1h = 2026-04-19 23:30) = 2026-04-20 00:00, which is ≤ now → fire.
  const now1 = new Date(2026, 3, 20, 0, 30, 0);
  const r1 = await evaluateCron("agent_alpha", now1);
  assert(r1.fired.length === 1, `expected 1 fire, got ${r1.fired.length}`);
  assert(r1.fired[0].inboxMessage.source === "cron", "inbox source should be cron");
  assert(
    (r1.fired[0].inboxMessage.meta as any)?.cronJobId === dailyJob.id,
    "inbox meta should carry cronJobId"
  );

  // Calling again with the same `now` should be a no-op: lastFiredAt is now
  // 2026-04-20 00:30, nextFireAfter of that = 2026-04-21 00:00 > now.
  const r2 = await evaluateCron("agent_alpha", now1);
  assert(r2.fired.length === 0, `expected 0 fires on 2nd call, got ${r2.fired.length}`);
  const notDue = r2.skipped.filter((s) => s.reason === "not-due");
  assert(notDue.length === 1, "skipped reason should be not-due");

  // Advance `now` by 24h — should fire again.
  const now2 = new Date(2026, 3, 21, 0, 30, 0);
  const r3 = await evaluateCron("agent_alpha", now2);
  assert(r3.fired.length === 1, `next-day tick should fire, got ${r3.fired.length}`);
  console.log("✓ evaluateCron fires due jobs once + advances lastFiredAt");

  // ── 13. Invalid schedule handled gracefully in evaluate ────────────────
  // Manually poison cron.json to test evaluator robustness.
  const { writeCron: _w, readCron: _r } = await import("../services/agentService.js");
  await _w("agent_beta", {
    jobs: [
      {
        id: "bad_job",
        schedule: "definitely not cron",
        prompt: "noop",
        lastFiredAt: null,
      },
    ],
  });
  const r4 = await evaluateCron("agent_beta", now2);
  assert(r4.fired.length === 0, "invalid job should not fire");
  assert(
    r4.skipped.some((s) => s.reason === "invalid-expression"),
    "invalid job should be skipped with reason invalid-expression"
  );
  console.log("✓ evaluateCron gracefully handles malformed jobs");

  // ── 14. Heartbeat+cron end-to-end: wire evaluateCron as the handler ────
  // Reset beta's cron to something valid so it can fire.
  await _w("agent_beta", {
    jobs: [
      {
        id: "beta_hourly",
        schedule: "@hourly",
        prompt: "hourly ping",
        lastFiredAt: null,
      },
    ],
  });
  // Reset alpha so it can fire too (add a fresh job on a fresh agent dir).
  await removeCronJob("agent_alpha", dailyJob.id);
  const alphaHourly = await addCronJob("agent_alpha", {
    schedule: "@hourly",
    prompt: "alpha hourly",
  });

  let lastEntryDetails: Record<string, unknown> | undefined;
  startHeartbeat({
    intervalMs: 60_000,
    listAgents: async () => agents,
    logger: { log: () => {}, warn: () => {}, error: console.error },
    onTick: async (ctx) => {
      const cr = await evaluateCron(ctx.agentId, ctx.firedAt);
      const details: Record<string, unknown> = {};
      if (cr.fired.length > 0) {
        details.cronFired = cr.fired.map((f) => f.job.id);
      }
      const outcome = cr.fired.length > 0 ? "triggered" : "idle";
      lastEntryDetails = outcome === "triggered" ? details : undefined;
      return Object.keys(details).length > 0 ? { outcome, details } : { outcome };
    },
  });
  await tickNow();
  await stopHeartbeat();

  const alphaLogAfter = await readHeartbeatLog("agent_alpha", { tail: 1 });
  const betaLogAfter = await readHeartbeatLog("agent_beta", { tail: 1 });
  assert(alphaLogAfter[0].outcome === "triggered", "alpha should be triggered");
  assert(betaLogAfter[0].outcome === "triggered", "beta should be triggered");
  assert(
    Array.isArray((alphaLogAfter[0].details as any)?.cronFired) &&
      (alphaLogAfter[0].details as any).cronFired.includes(alphaHourly.id),
    "alpha details should list the hourly job id"
  );
  console.log("✓ heartbeat+evaluateCron wired end-to-end");

  // ═══ Day 3: Inbox ack + agent-facing cron tools ═════════════════════════

  // ── 15. ackInboxMessage round-trip ─────────────────────────────────────
  // agent_beta's inbox already contains at least one cron-fired message
  // from step 14. Append an explicit "manual" unread message so we own
  // the id for ack.
  const targetMsg = await appendInboxMessage("agent_beta", {
    source: "cron",
    subject: "ack target",
    body: "please mark me as read",
  });
  assert(targetMsg.unread === true, "seed message must start unread");

  const unreadBefore = await inboxUnreadCount("agent_beta");
  assert(unreadBefore >= 1, "unread count must include our seed message");

  const acked = await ackInboxMessage("agent_beta", targetMsg.id);
  assert(acked !== null, "ack should return the message");
  assert(acked!.unread === false, "acked message should have unread:false");

  const unreadAfter = await inboxUnreadCount("agent_beta");
  assert(
    unreadAfter === unreadBefore - 1,
    `unread count should drop by 1 (before=${unreadBefore} after=${unreadAfter})`
  );

  // Calling ack a second time on the same id is a no-op: message is already
  // read, returns the same record (not null).
  const ackedAgain = await ackInboxMessage("agent_beta", targetMsg.id);
  assert(ackedAgain !== null, "second ack should still find the message");
  assert(ackedAgain!.unread === false, "second ack remains read");

  // Unknown id returns null without mutating anything.
  const missing = await ackInboxMessage("agent_beta", "msg_does_not_exist");
  assert(missing === null, "ack on missing id should be null");
  console.log("✓ ackInboxMessage round-trip works");

  // ── 16. Agent-facing cron tools (schedule/list/cancel) ─────────────────
  const schedTool = cronTools.find((t) => t.name === "schedule_task");
  const listTool = cronTools.find((t) => t.name === "list_scheduled_tasks");
  const cancelTool = cronTools.find((t) => t.name === "cancel_task");
  assert(schedTool && listTool && cancelTool, "cron tools must all exist");

  // Clear agent_alpha's existing jobs so we have a clean slate.
  for (const j of await listCronJobs("agent_alpha")) {
    await removeCronJob("agent_alpha", j.id);
  }

  // Good call: schedule a weekly digest.
  const schedOkRaw = await schedTool!.handler(
    { schedule: "0 17 * * 5", prompt: "周五下午五点总结这周" },
    { agentId: "agent_alpha" } as any
  );
  const schedOk = JSON.parse(schedOkRaw);
  assert(schedOk.ok === true, `schedule_task should succeed, got ${schedOkRaw}`);
  assert(typeof schedOk.jobId === "string" && schedOk.jobId.length > 0, "jobId missing");
  assert(
    typeof schedOk.nextFireAt === "string" && !Number.isNaN(Date.parse(schedOk.nextFireAt)),
    "nextFireAt should be a valid ISO date"
  );

  // Bad call: invalid cron — tool must return {ok:false}, not throw.
  const schedBadRaw = await schedTool!.handler(
    { schedule: "not a cron", prompt: "will fail" },
    { agentId: "agent_alpha" } as any
  );
  const schedBad = JSON.parse(schedBadRaw);
  assert(schedBad.ok === false, "schedule_task should reject bad cron");
  assert(typeof schedBad.error === "string", "schedule_task error must be a string");

  // Missing required params: also a non-throwing error.
  const schedEmptyRaw = await schedTool!.handler(
    { schedule: "", prompt: "" },
    { agentId: "agent_alpha" } as any
  );
  assert(JSON.parse(schedEmptyRaw).ok === false, "empty schedule/prompt must error");
  console.log("✓ schedule_task validates + returns nextFireAt");

  // list_scheduled_tasks shows the one good job we scheduled.
  const listRaw = await listTool!.handler({}, { agentId: "agent_alpha" } as any);
  const listed = JSON.parse(listRaw);
  assert(listed.ok === true, "list_scheduled_tasks ok");
  assert(listed.count === 1, `expected 1 job listed, got ${listed.count}`);
  assert(listed.jobs[0].id === schedOk.jobId, "listed id should match scheduled id");
  assert(listed.jobs[0].parseError === null, "valid cron should have parseError:null");
  assert(
    typeof listed.jobs[0].nextFireAt === "string",
    "list should enrich with nextFireAt"
  );

  // Poke a malformed job in to exercise parseError branch.
  await writeCron("agent_alpha", {
    jobs: [
      ...(await readCron("agent_alpha")).jobs,
      { id: "cron_bad", schedule: "definitely not cron", prompt: "bad" },
    ],
  });
  const listRaw2 = await listTool!.handler({}, { agentId: "agent_alpha" } as any);
  const listed2 = JSON.parse(listRaw2);
  const badRow = listed2.jobs.find((j: any) => j.id === "cron_bad");
  assert(badRow && badRow.parseError !== null, "bad job should flag parseError");
  assert(badRow.nextFireAt === null, "bad job should have nextFireAt:null");
  console.log("✓ list_scheduled_tasks enriches rows + flags parse errors");

  // cancel_task happy path + idempotent-miss.
  const cancelOkRaw = await cancelTool!.handler(
    { jobId: schedOk.jobId },
    { agentId: "agent_alpha" } as any
  );
  const cancelOk = JSON.parse(cancelOkRaw);
  assert(cancelOk.ok === true, `cancel should succeed, got ${cancelOkRaw}`);

  const cancelMissRaw = await cancelTool!.handler(
    { jobId: schedOk.jobId },
    { agentId: "agent_alpha" } as any
  );
  const cancelMiss = JSON.parse(cancelMissRaw);
  assert(cancelMiss.ok === false, "second cancel on same id should be ok:false");
  assert(typeof cancelMiss.error === "string", "cancel miss should carry error string");

  // Empty jobId short-circuits.
  const cancelEmptyRaw = await cancelTool!.handler(
    { jobId: "" },
    { agentId: "agent_alpha" } as any
  );
  assert(JSON.parse(cancelEmptyRaw).ok === false, "empty jobId should error");
  console.log("✓ cancel_task removes job, idempotent on repeat");

  console.log("\nPhase 4 Day 1+2+3 smoke: PASS");
}

main().catch((err) => {
  console.error("Phase 4 smoke: FAIL");
  console.error(err);
  process.exit(1);
});
