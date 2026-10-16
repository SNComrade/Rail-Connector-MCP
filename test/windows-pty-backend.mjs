import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureProcessLedger } from "./fixtures/fixture-process-ledger.mjs";
import { probeWindowsBroker, windowsBrokerRequest } from "../src/windows-broker-client.js";

if (process.platform !== "win32") {
  console.log("windows-pty-backend skipped on non-Windows");
  process.exit(0);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const canonicalRepoRoot = fs.realpathSync(repoRoot);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rail-windows-pty-backend-"));
const stateDir = path.join(root, "state");
fs.mkdirSync(stateDir);
const eventsFile = path.join(stateDir, "pty-backend-events.jsonl");
const fixture = path.join(repoRoot, "test", "fixtures", "fake-claude-tui.mjs");
const preload = path.join(repoRoot, "test", "fixtures", "windows-pty-backend-preload.cjs");
const receipt = { version: 1, test: "windows-pty-backend", cases: {}, cleanup: [] };
let ledger;
let brokerPid = null;
let environment;
let primaryError = null;
const cleanupErrors = [];
const syntheticCases = [];

function errorRecord(error) {
  const redact = (value) => String(value).replaceAll(root, "<test-root>").replaceAll(repoRoot, "<repo>");
  return { name: error?.name || "Error", code: error?.code || null,
    message: redact(error?.message || error), stack: redact(error?.stack || "") };
}

function pair(metadata) {
  return { expectedGenerationId: metadata.generationId, expectedStartedAtMs: metadata.startedAtMs };
}

function identity(metadata) {
  return { generationId: metadata.generationId, startedAtMs: metadata.startedAtMs,
    pid: metadata.pid, resolvedSessionId: metadata.resolvedSessionId,
    canonicalCwdMatches: metadata.canonicalCwd.toLowerCase() === canonicalRepoRoot.toLowerCase(),
    exited: metadata.exited, exitCode: metadata.exitCode, recoveryOnly: metadata.recoveryOnly };
}

function events() {
  if (!fs.existsSync(eventsFile)) return [];
  return fs.readFileSync(eventsFile, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function request(operation, payload = {}, startIfMissing = false) {
  return windowsBrokerRequest(operation, payload, { env: environment, startIfMissing });
}

async function captureReady(sessionName, metadata, banner) {
  const deadline = performance.now() + 5000;
  do {
    const captured = await request("capture", { sessionName, ...pair(metadata), lines: 40 });
    if (captured.capture.includes(banner)) return;
    if (performance.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (true);
  assert.fail("exact test fixture did not reach its ready banner");
}

function fixturePayload(sessionName, leaseId, sessionId, extraEnvironment = {}) {
  const args = [fixture, ...ledger.fixtureArgs, "--session-id", sessionId];
  return {
    sessionName, command: process.execPath, args,
    metadataCommand: process.execPath, metadataArgs: args,
    cwd: repoRoot, canonicalCwd: canonicalRepoRoot,
    freshSessionId: sessionId, resolvedSessionId: sessionId,
    env: { ...environment, ...extraEnvironment }, leaseId, leaseTtlMs: 120000,
  };
}

async function startFixture(sessionName, leaseId, sessionId, banner) {
  const started = await request("start", fixturePayload(sessionName, leaseId, sessionId, {
    RAIL_FAKE_CLAUDE_BANNER: banner,
  }));
  assert.equal(started.status, "started");
  assert.ok(Number.isSafeInteger(started.metadata.pid) && started.metadata.pid > 0,
    "started fixture metadata must contain its positive process PID");
  await captureReady(sessionName, started.metadata, banner);
  return started.metadata;
}

function startInert(mode) {
  const entry = { mode, name: `pty_inert_${mode.replaceAll("-", "_")}_${process.pid}`,
    leaseId: "pty-inert-original-lease", sessionId: "33333333-3333-4333-8333-333333333333",
    metadata: null, cleaned: false };
  syntheticCases.push(entry);
  entry.payload = fixturePayload(entry.name, entry.leaseId, entry.sessionId, {
    RAIL_CONNECTOR_TEST_PTY_BACKEND_MODE: mode,
  });
  // Observe rejection immediately; finally also drains every pending start.
  entry.outcome = request("start", entry.payload).then((result) => ({ result }), (error) => ({ error }));
  return entry;
}

function inertEvents(entry, kind) {
  return events().filter((event) => event.mode === entry.mode && event.kind === kind);
}

async function currentInert(entry) {
  return (await request("status")).managedSessions.find((session) => session.name === entry.name);
}

async function cleanupInert(entry) {
  if (entry.cleaned) return;
  await entry.outcome;
  const current = await currentInert(entry);
  if (!current) {
    entry.cleaned = true;
    receipt.cleanup.push({ phase: "inert-exact-cleanup", mode: entry.mode, ok: true, sessionAbsent: true });
    return;
  }
  // This unique test name has exactly one inert construction in this dedicated
  // broker; no replacement call is allowed to construct another generation.
  assert.equal(inertEvents(entry, "inert-spawn").length, 1);
  assert.equal(current.resolvedSessionId, entry.sessionId);
  assert.equal(current.canonicalCwd, canonicalRepoRoot);
  if (entry.metadata) {
    assert.deepEqual(pair(current), pair(entry.metadata));
    assert.equal(current.pid, entry.metadata.pid);
  } else entry.metadata = current;
  const exact = pair(entry.metadata);
  const released = await request("releaseLease", { sessionName: entry.name, leaseId: entry.leaseId, ...exact });
  assert.equal(released.status, "released");
  const cleanupLease = "pty-inert-exact-cleanup-lease";
  const acquired = await request("acquireCleanupLease", { sessionName: entry.name, leaseId: cleanupLease, ...exact });
  assert.equal(acquired.status, "acquired");
  let stopped = await request("cleanupStop", { sessionName: entry.name, leaseId: cleanupLease, ...exact });
  if (stopped.status === "stop_timeout") {
    // A failed assertion before the startup cancellation may leave the mock's
    // first kill pending. Drain its second public kill, retaining the failure.
    const error = new Error("Inert cleanup's first exact stop did not confirm exit");
    cleanupErrors.push(error);
    receipt.cleanup.push({ phase: "inert-exact-cleanup-first-stop", mode: entry.mode, ok: false, status: stopped.status });
    const reacquired = await request("acquireCleanupLease", { sessionName: entry.name, leaseId: cleanupLease, ...exact });
    assert.equal(reacquired.status, "acquired");
    stopped = await request("cleanupStop", { sessionName: entry.name, leaseId: cleanupLease, ...exact });
  }
  assert.ok(["stopped", "not_running"].includes(stopped.status));
  assert.equal(await currentInert(entry), undefined);
  entry.cleaned = true;
  receipt.cleanup.push({ phase: "inert-exact-cleanup", mode: entry.mode, ok: true,
    binding: exact, status: stopped.status, sessionAbsent: true });
}

async function inertStartupCoverage() {
  const delayed = startInert("delayed-pid");
  const delayedOutcome = await delayed.outcome;
  if (delayedOutcome.error) throw delayedOutcome.error;
  delayed.metadata = delayedOutcome.result.metadata;
  assert.equal(delayedOutcome.result.status, "started");
  assert.equal(delayed.metadata.pid, 101);
  assert.equal(delayed.metadata.exited, false);
  assert.equal(inertEvents(delayed, "inert-spawn")[0]?.initialPid, 0);
  assert.equal(inertEvents(delayed, "inert-data").length, 1);
  receipt.cases.delayedPid = { synthetic: true, ...identity(delayed.metadata) };
  await cleanupInert(delayed);

  const early = startInert("exit-before-pid");
  const earlyOutcome = await early.outcome;
  if (earlyOutcome.error) throw earlyOutcome.error;
  early.metadata = earlyOutcome.result.metadata;
  assert.equal(earlyOutcome.result.status, "started");
  assert.equal(early.metadata.pid, null);
  assert.equal(early.metadata.exited, true);
  assert.equal(early.metadata.exitCode, 23);
  const retained = await request("conditionalMetadata", { sessionName: early.name, ...pair(early.metadata) });
  assert.deepEqual(pair(retained.metadata), pair(early.metadata));
  assert.equal(retained.metadata.pid, null);
  assert.equal(inertEvents(early, "inert-kill").length, 0);
  receipt.cases.exitBeforePid = { synthetic: true, ...identity(retained.metadata), exitCode: retained.metadata.exitCode };
  await cleanupInert(early);

  const startupStarted = performance.now();
  const timeout = startInert("no-data-timeout");
  const observationDeadline = performance.now() + 5000;
  do {
    timeout.metadata = await currentInert(timeout);
    if (timeout.metadata) break;
    if (performance.now() >= observationDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (true);
  assert.ok(timeout.metadata, "original inert generation must be tracked during startup");
  assert.equal(timeout.metadata.pid, null);
  assert.equal(timeout.metadata.exited, false);
  assert.equal(timeout.metadata.recoveryOnly, false);
  const timeoutOutcome = await timeout.outcome;
  assert.equal(timeoutOutcome.error?.code, "EPTYSTARTUP");
  assert.ok(performance.now() - startupStarted >= 15000, "startup timeout must honor the documented production15s contract");
  const recovery = await currentInert(timeout);
  assert.deepEqual(pair(recovery), pair(timeout.metadata));
  assert.equal(recovery.pid, null);
  assert.equal(recovery.exited, false);
  assert.equal(recovery.recoveryOnly, true);
  assert.equal(inertEvents(timeout, "inert-kill").length, 1);
  assert.equal(inertEvents(timeout, "inert-spawn").length, 1);
  assert.equal(inertEvents(timeout, "inert-data").length, 0);
  const exact = pair(timeout.metadata);
  assert.equal((await request("renewLease", { sessionName: timeout.name, leaseId: timeout.leaseId, ...exact })).status, "lost");
  await assert.rejects(request("acquireLease", { sessionName: timeout.name, leaseId: "pty-inert-recovery-lease" }),
    (error) => error.code === "EINVAL");
  await assert.rejects(request("acquireLease", { sessionName: timeout.name, leaseId: "pty-inert-recovery-lease",
    ...exact, expectedStartedAtMs: exact.expectedStartedAtMs + 1 }), (error) => error.code === "ESTALE");
  await assert.rejects(request("sendText", { sessionName: timeout.name, leaseId: timeout.leaseId,
    ...exact, text: "inert recovery must refuse input", submit: true }), (error) => error.code === "ERECOVERY");
  await assert.rejects(request("replace", { ...timeout.payload, graceful: false, force: true }),
    (error) => error.code === "EINVAL");
  await assert.rejects(request("shutdown"), /Refusing to shut down.*sessions are running/);
  assert.equal(typeof (await request("capture", { sessionName: timeout.name, ...exact, lines: 40 })).capture, "string",
    "recovery must retain its renderer until exact stop confirms exit");
  const acquired = await request("acquireCleanupLease", { sessionName: timeout.name, leaseId: "pty-inert-recovery-lease", ...exact });
  assert.equal(acquired.status, "acquired", "timeout must release the original active lease");
  timeout.leaseId = "pty-inert-recovery-lease";
  const released = await request("releaseCleanupLease", { sessionName: timeout.name, leaseId: timeout.leaseId, ...exact });
  assert.equal(released.status, "released");
  assert.equal(inertEvents(timeout, "inert-kill").length, 1, "rejected operations must not request additional kills");
  assert.equal(inertEvents(timeout, "inert-spawn").length, 1, "rejected replacement must not create a new PTY");
  receipt.cases.startupRecovery = { synthetic: true, original: identity(timeout.metadata), recovery: identity(recovery),
    startupErrorCode: timeoutOutcome.error.code, originalLeaseLost: true, rendererRetained: true };
  await cleanupInert(timeout);
  assert.equal(inertEvents(timeout, "inert-kill").length, 2);

  const failed = startInert("spawn-error");
  const failedOutcome = await failed.outcome;
  assert.equal(failedOutcome.error?.code, "EPTESTPTYSPAWN");
  assert.equal(await currentInert(failed), undefined);
  assert.equal(inertEvents(failed, "inert-spawn").length, 1, "spawn failure must not fall back to a second backend");
  receipt.cases.synchronousSpawnFailure = { synthetic: true, code: failedOutcome.error.code, spawnAttempts: 1, managedSessionAbsent: true };
  await cleanupInert(failed);
}

try {
  ledger = await createFixtureProcessLedger({ directory: path.join(root, "fixture-processes"), fixturePath: fixture });
  environment = {
    ...process.env, ...ledger.environment, NODE_ENV: "test",
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${JSON.stringify(preload)}`].filter(Boolean).join(" "),
    RAIL_CONNECTOR_STATE_DIR: stateDir, RAIL_CONNECTOR_CLAUDE_PATH: process.execPath,
    CLAUDE_CONFIG_DIR: path.join(root, "config"),
    RAIL_CONNECTOR_TEST_PTY_BACKEND_RECEIPT: eventsFile,
  };
  const initialStatus = await request("status", {}, true);
  brokerPid = initialStatus.pid;
  assert.ok(Number.isSafeInteger(brokerPid) && brokerPid > 0);
  const armed = events().filter((event) => event.kind === "preload-armed");
  assert.equal(armed.length, 1, "exact broker preload must be armed before starting any fixture");
  assert.equal(armed[0].version, 1);
  assert.equal(armed[0].brokerPid, brokerPid);
  receipt.cases.preloadArmed = true;
  const sessionA = `pty_backend_a_${process.pid}`;
  const sessionB = `pty_backend_b_${process.pid}`;
  const leaseA = "pty-backend-a-lease";
  const leaseB = "pty-backend-b-lease";
  const first = await startFixture(sessionA, leaseA, "67676767-6767-4676-8676-676767676767", "PTY backend fixture A");
  const independent = await startFixture(sessionB, leaseB, "78787878-7878-4787-8787-787878787878", "PTY backend fixture B");
  receipt.cases.started = { a: identity(first), b: identity(independent) };
  let stopped;
  let stopError;
  try {
    stopped = await request("stop", { sessionName: sessionA, leaseId: leaseA, ...pair(first),
      graceful: false, force: true, omitCapture: true });
  } catch (error) { stopError = error; }
  receipt.cases.forceStop = { status: stopped?.status || null, error: stopError ? errorRecord(stopError) : null };
  receipt.events = events();
  // The baseline's fork is intercepted BEFORE it can start a console helper
  // or obtain any numeric PID target. Its attempted launch is the RED proof.
  assert.equal(receipt.events.filter((event) => event.kind === "forbidden-console-list-fork").length, 0,
    "force stop attempted the legacy console-list helper; it was blocked before launch");
  if (stopError) throw stopError;
  assert.equal(stopped.status, "stopped");
  const surviving = (await request("status")).managedSessions.find((session) => session.name === sessionB);
  assert.ok(surviving, "independent exact generation must remain tracked");
  assert.equal(surviving.generationId, independent.generationId);
  assert.equal(surviving.startedAtMs, independent.startedAtMs);
  assert.equal(surviving.pid, independent.pid);
  assert.equal(surviving.resolvedSessionId, independent.resolvedSessionId);
  assert.equal(surviving.canonicalCwd, independent.canonicalCwd);
  assert.equal(surviving.exited, false);
  receipt.cases.independentSurvives = identity(surviving);
  await captureReady(sessionB, independent, "PTY backend fixture B");
  const graceful = await request("stop", { sessionName: sessionB, leaseId: leaseB, ...pair(independent),
    graceful: true, force: false, omitCapture: true });
  assert.equal(graceful.status, "stopped");
  assert.equal(graceful.graceful, true);
  receipt.cases.gracefulStop = { status: graceful.status, graceful: graceful.graceful, exitCode: graceful.exitCode };
  await inertStartupCoverage();
  assert.equal(events().filter((event) => event.kind === "forbidden-console-list-fork").length, 0);
} catch (error) {
  primaryError = error;
  receipt.primaryError = errorRecord(error);
  console.error("windows-pty-backend primary failure:", error);
} finally {
  for (const entry of syntheticCases) {
    try { await cleanupInert(entry); }
    catch (error) {
      cleanupErrors.push(error);
      receipt.cleanup.push({ phase: "inert-exact-cleanup", mode: entry.mode, ok: false, error: errorRecord(error) });
    }
  }
  // Requests own and close their individual sockets. No retained MCP client
  // can launch a new fixture while final admission is sealed and reaped.
  if (ledger) {
    try {
      const terminated = await ledger.reap({ expectRecords: false, final: true });
      receipt.cleanup.push({ phase: "final-ledger-reap", ok: true, terminated });
    } catch (error) {
      cleanupErrors.push(error);
      receipt.cleanup.push({ phase: "final-ledger-reap", ok: false, error: errorRecord(error) });
    }
  }
  if (environment && brokerPid) {
    try {
      let status;
      const settlingDeadline = performance.now() + 5000;
      do {
        status = await probeWindowsBroker(environment);
        if (!status || status.managedSessions.every((session) => session.exited)) break;
        if (performance.now() >= settlingDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (true);
      if (status) {
        assert.equal(status.pid, brokerPid, "dedicated broker identity must not change");
        assert.ok(status.managedSessions.every((session) => session.exited), "dedicated broker still has a running fixture");
        const shutdown = await request("shutdown");
        assert.equal(shutdown.pid, brokerPid);
      }
      let exited = false;
      const exitDeadline = performance.now() + 5000;
      do {
        try { process.kill(brokerPid, 0); }
        catch (error) { if (error.code === "ESRCH") { exited = true; break; } throw error; }
        if (performance.now() >= exitDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (true);
      assert.ok(exited, "dedicated test broker exit was not observed");
      assert.equal(await probeWindowsBroker(environment), null);
      receipt.cleanup.push({ phase: "dedicated-broker-exit", ok: true, brokerPid, pidAbsent: true, endpointAbsent: true });
    } catch (error) {
      cleanupErrors.push(error);
      receipt.cleanup.push({ phase: "dedicated-broker-exit", ok: false, error: errorRecord(error) });
    }
  }
  if (ledger) {
    try {
      const terminated = await ledger.reap({ expectRecords: false, graceMs: 0 });
      receipt.cleanup.push({ phase: "post-broker-ledger-reap", ok: true, terminated });
    } catch (error) {
      cleanupErrors.push(error);
      receipt.cleanup.push({ phase: "post-broker-ledger-reap", ok: false, error: errorRecord(error) });
    }
  }
  try { receipt.events = events(); }
  catch (error) { cleanupErrors.push(error); receipt.eventReadError = errorRecord(error); }
  receipt.completedAt = new Date().toISOString();
  receipt.ok = !primaryError && cleanupErrors.length === 0;
  try {
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    cleanupErrors.push(error);
    console.error("windows-pty-backend receipt persistence failure:", error);
  }
  for (const error of cleanupErrors) console.error("windows-pty-backend cleanup failure:", error);
  console.error(`windows-pty-backend receipt: ${path.basename(root)}/result.json`);
}
if (primaryError && cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], "PTY backend test and scoped cleanup failed", { cause: primaryError });
if (primaryError) throw primaryError;
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "PTY backend scoped cleanup failed");
console.log("windows-pty-backend ok");
