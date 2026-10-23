import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  classifyFixtureProcess, createFixtureProcessLedger, inspectFixtureProcess, publishFixtureProcessRecord, readFixtureProcessRecords,
} from "./fixtures/fixture-process-ledger.mjs";
import * as fixtureHelper from "./fixtures/fixture-process-ledger.mjs";

if (process.argv[2] === "--readiness-regression") {
  await fixtureReadinessRegression();
} else if (process.argv[2] === "--inspect-failure-regression") {
  inspectFailureRegression();
} else if (process.argv[2] === "--admission-isolation") {
  await isolatedAdmissionRegression(process.argv[3]);
} else {

await fixtureReadinessRegression();
inspectFailureRegression();

const runId = randomUUID();
const expected = { runId, executablePath: "C:\\Node\\node.exe", fixturePath: "C:\\tests\\fixture.mjs" };
const record = {
  version: 1, recordId: randomUUID(), pid: 123, runId, state: "ready",
  creationFileTime: "134000000000000001", executablePath: expected.executablePath, fixturePath: expected.fixturePath,
};
const live = {
  creationFileTime: record.creationFileTime, executablePath: expected.executablePath,
  argv: [expected.executablePath, expected.fixturePath, `--rail-fixture-run=${runId}`],
};
assert.equal(classifyFixtureProcess(record, live, expected), "owned");
assert.equal(classifyFixtureProcess(record, null, expected), "gone");
assert.equal(classifyFixtureProcess(record, { ...live, creationFileTime: "134000000000000002" }, expected), "reused",
  "creation identities that round to the same JavaScript number must remain distinct");
const queryFailure = {
  creationFileTime: "134000000000000002", error: "process identity is unreadable", errorPhase: "query-command-line",
};
assert.equal(classifyFixtureProcess(record, queryFailure, expected), "reused",
  "a different retained-handle birth proves PID reuse even when the later command-line query fails");
assert.equal(classifyFixtureProcess(record, { ...queryFailure, creationFileTime: record.creationFileTime }, expected), "unproven",
  "a matching birth cannot authorize cleanup when the command-line query fails");
for (const invalid of [
  { ...record, state: "pending" },
  { ...record, runId: randomUUID() },
  { ...record, pid: 0 },
  { ...record, recordId: "invalid" },
  { ...record, creationFileTime: null },
]) assert.equal(classifyFixtureProcess(invalid, queryFailure, expected), "unproven",
  "an invalid or foreign snapshot must not establish PID reuse from an unreadable process");
for (const creationFileTime of [null, undefined, NaN, Number(record.creationFileTime), "not-a-time", "0"]) {
  assert.equal(classifyFixtureProcess(record, { ...queryFailure, creationFileTime }, expected), "unproven",
    "an unreadable process without a valid birth must remain unproven");
}
for (const creationFileTime of [null, undefined, NaN, Number(record.creationFileTime), "not-a-time", "0"]) {
  assert.equal(classifyFixtureProcess(record, { ...live, creationFileTime }, expected), "unproven");
}
for (const changed of [
  { ...live, error: "access denied" },
  { ...live, executablePath: "C:\\Other\\node.exe" },
  { ...live, argv: [expected.executablePath, `${expected.fixturePath}.other`, live.argv[2]] },
  { ...live, argv: [expected.executablePath, expected.fixturePath, `--rail-fixture-run=${randomUUID()}`] },
  { ...live, argv: [...live.argv, live.argv[2]] },
]) assert.equal(classifyFixtureProcess(record, changed, expected), "unproven");
assert.equal(classifyFixtureProcess({ ...record, state: "pending" }, live, expected), "unproven");
assert.equal(classifyFixtureProcess({ ...record, runId: randomUUID() }, live, expected), "unproven");

// A real writer thread pauses after a partial staging write. The concurrent
// reader must wait for publication, never parse that partial JSON as final.
const publicationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rail-fixture-publication-test-"));
const publicationWorkers = new Set();
const helperPath = fileURLToPath(new URL("./fixtures/fixture-process-ledger.mjs", import.meta.url));
const writerSource = `
  const { parentPort, workerData } = require("node:worker_threads");
  const fs = require("node:fs");
  const { pathToFileURL } = require("node:url");
  (async () => {
    const { publishFixtureProcessRecord } = await import(pathToFileURL(workerData.helper));
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = (file, data, options) => {
      if (!String(file).endsWith(".tmp")) return originalWrite(file, data, options);
      const fd = fs.openSync(file, options.flag, options.mode);
      try {
        const bytes = Buffer.from(data);
        const half = Math.floor(bytes.length / 2);
        fs.writeSync(fd, bytes, 0, half, 0);
        parentPort.postMessage({ type: "staged", file });
        if (Atomics.wait(new Int32Array(workerData.barrier), 0, 0, 30000) === "timed-out") throw new Error("writer barrier timed out");
        fs.writeSync(fd, bytes, half, bytes.length - half, half);
      } finally { fs.closeSync(fd); }
    };
    publishFixtureProcessRecord(workerData.directory, workerData.record);
    parentPort.postMessage({ type: "committed" });
  })().catch(error => { parentPort.postMessage({ type: "failed", message: error.message }); process.exitCode = 1; });
`;
function workerMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { worker.off("message", message); worker.off("error", failed); worker.off("exit", exited); };
    const failed = (error) => { cleanup(); reject(error); };
    const exited = () => failed(new Error(`publication writer exited before ${type}`));
    const message = (value) => {
      if (value.type === "failed") failed(new Error(value.message));
      else if (value.type === type) { cleanup(); resolve(value); }
    };
    worker.on("message", message); worker.once("error", failed); worker.once("exit", exited);
  });
}
async function pausePublication(directory, value) {
  const barrier = new SharedArrayBuffer(4);
  const worker = new Worker(writerSource, { eval: true, workerData: { helper: helperPath, directory, record: value, barrier } });
  publicationWorkers.add(worker);
  const staged = await workerMessage(worker, "staged");
  return { worker, barrier, staged: staged.file };
}
const publicationDirectory = (name) => {
  const directory = path.join(publicationRoot, name);
  fs.mkdirSync(directory);
  return directory;
};
const pendingRecord = () => ({ ...record, pid: process.pid, recordId: randomUUID(), state: "pending", creationFileTime: null });
const finalFile = (directory, value) => path.join(directory, `${value.pid}-${value.recordId}.json`);
const stageFile = (directory, value) => `${finalFile(directory, value)}.${value.runId}.tmp`;
let publicationError = null;
try {
  // Fault only the synchronous publication boundary; restore every global
  // before the real worker/native cases. The monotonic clock is deterministic.
  const publicationFault = (fault, check, platform = "win32") => {
    const originalRename = fs.renameSync;
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    const clockDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
    const originalWait = Atomics.wait;
    let attempts = 0;
    let elapsed = 0;
    try {
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
      Object.defineProperty(performance, "now", { configurable: true, value: () => elapsed });
      Atomics.wait = (_array, _index, _value, milliseconds) => { elapsed += milliseconds; return "timed-out"; };
      fs.renameSync = (...args) => fault({ args, attempts: ++attempts, rename: originalRename });
      check(() => ({ attempts, elapsed }));
    } finally {
      fs.renameSync = originalRename;
      Atomics.wait = originalWait;
      Object.defineProperty(process, "platform", platformDescriptor);
      if (clockDescriptor) Object.defineProperty(performance, "now", clockDescriptor);
      else delete performance.now;
    }
  };
  const readyPublication = (name) => {
    const directory = publicationDirectory(name);
    const pending = pendingRecord();
    publishFixtureProcessRecord(directory, pending);
    const ready = { ...pending, state: "ready", creationFileTime: record.creationFileTime };
    return { directory, pending, ready };
  };
  const assertRetained = ({ directory, pending, ready }, final = pending) => {
    assert.deepEqual(JSON.parse(fs.readFileSync(finalFile(directory, pending), "utf8")), final);
    assert.deepEqual(JSON.parse(fs.readFileSync(stageFile(directory, ready), "utf8")), ready,
      "failed publication must preserve complete closed ready bytes");
  };
  const transient = readyPublication("transient-ready-eperm");
  let injectedFailures = 0;
  publicationFault(({ args, attempts, rename }) => {
    assertRetained(transient);
    if (attempts <= 2) {
      injectedFailures++;
      throw Object.assign(new Error("injected transient rename failure"), { code: "EPERM" });
    }
    return rename(...args);
  }, (state) => {
    publishFixtureProcessRecord(transient.directory, transient.ready);
    assert.equal(injectedFailures, 2);
    assert.ok(state().attempts >= 3, "publication must recover after both injected Windows EPERM failures");
    assert.deepEqual(JSON.parse(fs.readFileSync(finalFile(transient.directory, transient.ready), "utf8")), transient.ready);
    assert.equal(fs.existsSync(stageFile(transient.directory, transient.ready)), false);
  });
  const persistent = readyPublication("persistent-ready-eperm");
  const permissionError = Object.assign(new Error("injected persistent permission failure"), { code: "EPERM" });
  publicationFault(() => { throw permissionError; }, (state) => {
    assert.throws(() => publishFixtureProcessRecord(persistent.directory, persistent.ready), (error) => error === permissionError,
      "exhaustion must propagate the original permission error");
    assert.ok(state().attempts > 1 && state().attempts <= 20, "persistent EPERM must stop after bounded attempts");
    assert.ok(state().elapsed > 0 && state().elapsed <= 250, "publication retries must stay within the promised 250ms monotonic bound");
    assertRetained(persistent);
  });
  for (const code of ["EACCES", "EIO", "ENOENT"]) {
    const fixture = readyPublication(`non-retryable-${code}`);
    const failure = Object.assign(new Error("injected non-retryable publication error"), { code });
    publicationFault(() => { throw failure; }, (state) => {
      assert.throws(() => publishFixtureProcessRecord(fixture.directory, fixture.ready), (error) => error === failure);
      assert.deepEqual(state(), { attempts: 1, elapsed: 0 });
      assertRetained(fixture);
    });
  }
  const unix = readyPublication("non-windows-eperm");
  publicationFault(() => { throw permissionError; }, (state) => {
    assert.throws(() => publishFixtureProcessRecord(unix.directory, unix.ready), (error) => error === permissionError);
    assert.deepEqual(state(), { attempts: 1, elapsed: 0 });
    assertRetained(unix);
  }, "linux");
  const initialDirectory = publicationDirectory("initial-pending-eperm");
  const initial = pendingRecord();
  publicationFault(() => { throw permissionError; }, (state) => {
    assert.throws(() => publishFixtureProcessRecord(initialDirectory, initial), (error) => error === permissionError);
    assert.deepEqual(state(), { attempts: 1, elapsed: 0 });
    assert.equal(fs.existsSync(finalFile(initialDirectory, initial)), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(stageFile(initialDirectory, initial), "utf8")), initial);
  });
  for (const change of [
    { runId: randomUUID() }, { recordId: randomUUID() }, { pid: process.pid + 1 },
    { state: "ready" }, { fixturePath: `${record.fixturePath}.other` }, { creationFileTime: record.creationFileTime },
  ]) {
    const fixture = readyPublication(`changed-target-${randomUUID()}`);
    const changed = { ...fixture.pending, ...change };
    fs.writeFileSync(finalFile(fixture.directory, fixture.pending), JSON.stringify(changed));
    publicationFault(() => assert.fail("an invalid pending target must never be renamed over"), (state) => {
      assert.throws(() => publishFixtureProcessRecord(fixture.directory, fixture.ready), /pending record/);
      assert.deepEqual(state(), { attempts: 0, elapsed: 0 });
      assertRetained(fixture, changed);
    });
  }
  const changedDuringRetry = readyPublication("changed-during-retry");
  const foreign = { ...changedDuringRetry.pending, runId: randomUUID() };
  publicationFault(({ attempts }) => {
    assert.equal(attempts, 1, "a changed target must stop before a second rename");
    fs.writeFileSync(finalFile(changedDuringRetry.directory, changedDuringRetry.pending), JSON.stringify(foreign));
    throw permissionError;
  }, (state) => {
    assert.throws(() => publishFixtureProcessRecord(changedDuringRetry.directory, changedDuringRetry.ready), /pending record/);
    assert.equal(state().attempts, 1);
    assertRetained(changedDuringRetry, foreign);
  });
  for (const contents of ["", "{"]) {
    const fixture = readyPublication(`malformed-target-${randomUUID()}`);
    fs.writeFileSync(finalFile(fixture.directory, fixture.pending), contents);
    assert.throws(() => publishFixtureProcessRecord(fixture.directory, fixture.ready), /pending record/);
    assert.equal(fs.readFileSync(finalFile(fixture.directory, fixture.pending), "utf8"), contents);
    assert.deepEqual(JSON.parse(fs.readFileSync(stageFile(fixture.directory, fixture.ready), "utf8")), fixture.ready);
  }
  const nonregular = readyPublication("nonregular-target");
  fs.unlinkSync(finalFile(nonregular.directory, nonregular.pending));
  fs.mkdirSync(finalFile(nonregular.directory, nonregular.pending));
  assert.throws(() => publishFixtureProcessRecord(nonregular.directory, nonregular.ready), /pending record/);
  assert.equal(fs.statSync(finalFile(nonregular.directory, nonregular.pending)).isDirectory(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(stageFile(nonregular.directory, nonregular.ready), "utf8")), nonregular.ready);
  const linked = readyPublication("linked-target");
  const originalStat = fs.lstatSync;
  try {
    fs.lstatSync = (...args) => {
      const stat = originalStat(...args);
      if (args[0] === finalFile(linked.directory, linked.pending)) stat.isSymbolicLink = () => true;
      return stat;
    };
    assert.throws(() => publishFixtureProcessRecord(linked.directory, linked.ready), /pending record/);
  } finally { fs.lstatSync = originalStat; }
  assertRetained(linked);
  for (const phase of ["pending", "ready"]) {
    const directory = publicationDirectory(`concurrent-${phase}`);
    const pending = pendingRecord();
    if (phase === "ready") publishFixtureProcessRecord(directory, pending);
    const value = phase === "ready" ? { ...pending, state: "ready", creationFileTime: record.creationFileTime } : pending;
    const paused = await pausePublication(directory, value);
    assert.throws(() => JSON.parse(fs.readFileSync(paused.staged, "utf8")), SyntaxError, "writer barrier must expose genuinely partial staging JSON");
    if (phase === "pending") assert.equal(fs.existsSync(finalFile(directory, value)), false);
    else assert.deepEqual(JSON.parse(fs.readFileSync(finalFile(directory, value), "utf8")), pending);
    let settled = false;
    const reading = readFixtureProcessRecords(directory, runId);
    reading.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(setImmediate);
    assert.equal(settled, false, "an active unpublished record must not be reported as empty or complete");
    const committed = workerMessage(paused.worker, "committed");
    Atomics.store(new Int32Array(paused.barrier), 0, 1); Atomics.notify(new Int32Array(paused.barrier), 0);
    await committed;
    assert.deepEqual(await reading, [value]);
  }
  for (const phase of ["pending", "ready"]) {
    const directory = publicationDirectory(`interrupted-${phase}`);
    const pending = pendingRecord();
    if (phase === "ready") publishFixtureProcessRecord(directory, pending);
    const paused = await pausePublication(directory, phase === "ready" ? { ...pending, state: "ready" } : pending);
    await paused.worker.terminate();
    await assert.rejects(readFixtureProcessRecords(directory, runId, { publicationTimeoutMs: 0 }), /identity was unproven/);
    assert.equal(fs.existsSync(paused.staged), true, "uncertain interrupted publication must retain its evidence");
    if (phase === "ready") assert.deepEqual(JSON.parse(fs.readFileSync(finalFile(directory, pending), "utf8")), pending);
  }
  const malformed = publicationDirectory("malformed-final");
  const pending = pendingRecord();
  fs.writeFileSync(finalFile(malformed, pending), "", { flag: "wx" });
  fs.writeFileSync(stageFile(malformed, pending), "{", { flag: "wx" });
  await assert.rejects(readFixtureProcessRecords(malformed, runId), /final record is malformed/);
  assert.equal(fs.readFileSync(finalFile(malformed, pending), "utf8"), "");
  for (const name of ["foreign.tmp", `${process.pid}-${randomUUID()}.json.${randomUUID()}.tmp`]) {
    const directory = publicationDirectory(randomUUID());
    fs.writeFileSync(path.join(directory, name), "{", { flag: "wx" });
    await assert.rejects(readFixtureProcessRecords(directory, runId), /Unexpected file/);
  }
  const vanished = publicationDirectory("vanished-stage");
  const disappearing = pendingRecord();
  fs.writeFileSync(stageFile(vanished, disappearing), "{", { flag: "wx" });
  const reading = readFixtureProcessRecords(vanished, runId, { publicationTimeoutMs: 50 });
  fs.unlinkSync(stageFile(vanished, disappearing));
  await assert.rejects(reading, /identity was unproven/, "observed staging must not disappear into false empty success");
  const absent = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", windowsHide: true });
  assert.equal(absent.status, 0);
  const gonePid = Number(absent.stdout);
  assert.throws(() => process.kill(gonePid, 0), (error) => error.code === "ESRCH");
  const interruptedGone = publicationDirectory("absent-publisher");
  const gone = { ...pendingRecord(), pid: gonePid };
  fs.writeFileSync(stageFile(interruptedGone, gone), "{", { flag: "wx" });
  const observed = await readFixtureProcessRecords(interruptedGone, runId, { publicationTimeoutMs: 0 });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].pid, gonePid);
  assert.equal(observed[0].state, "pending");
  assert.equal(classifyFixtureProcess(observed[0], live, expected), "unproven", "staging never supplies termination identity");
  assert.equal(fs.existsSync(stageFile(interruptedGone, gone)), true);
} catch (error) {
  publicationError = error;
  error.message += `\nPublication regression evidence preserved at ${publicationRoot}`;
  throw error;
} finally {
  for (const worker of publicationWorkers) await worker.terminate();
  if (!publicationError) fs.rmSync(publicationRoot, { recursive: true, force: true });
}

// A Worker must not create a second handle budget in this same Node process.
const workerLedgerPath = path.join(os.tmpdir(), `rail-fixture-worker-rejected-${randomUUID()}`);
await new Promise((resolve, reject) => {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { pathToFileURL } = require('node:url');
    (async () => {
      const { createFixtureProcessLedger } = await import(pathToFileURL(workerData.helper));
      try { await createFixtureProcessLedger({ directory: workerData.directory, fixturePath: workerData.helper }); parentPort.postMessage(false); }
      catch (error) { parentPort.postMessage(error.message === 'Fixture ledgers require the main-thread controller'); }
    })().catch(() => parentPort.postMessage(false));
  `, { eval: true, workerData: { helper: helperPath, directory: workerLedgerPath } });
  let guarded = false;
  const timeout = setTimeout(() => { worker.terminate(); reject(new Error("Worker ledger guard did not finish")); }, 5000);
  worker.once("message", (value) => { guarded = value === true; });
  worker.once("error", reject);
  worker.once("exit", (code) => { clearTimeout(timeout); try { assert.equal(code, 0); assert.equal(guarded, true); resolve(); } catch (error) { reject(error); } });
});
assert.equal(fs.existsSync(workerLedgerPath), false, "off-main-thread rejection must precede directory/native/listener work");

if (process.platform === "win32") {
  // Exercise first native bootstrap without a fake, ConPTY or concurrent launch.
  // This is bounded measurement, not a retry: every inspection must succeed.
  const inspectElapsedMs = [];
  const inspectStarted = performance.now();
  let firstIdentity;
  try {
    for (let sample = 0; sample < 3; sample++) {
      const started = performance.now();
      let identity;
      try { identity = inspectFixtureProcess(process.pid); }
      finally { inspectElapsedMs.push(Math.round(performance.now() - started)); }
      const imageMatches = fs.realpathSync(identity.executablePath).toLowerCase() === fs.realpathSync(process.execPath).toLowerCase();
      assert.equal(imageMatches, true, "self-inspection must observe the test's canonical executable image");
      firstIdentity ??= identity;
      assert.equal(identity.creationFileTime === firstIdentity.creationFileTime, true,
        "sequential self-inspections must retain the exact creation identity");
      assert.equal(identity.executablePath === firstIdentity.executablePath, true,
        "sequential self-inspections must retain the exact executable image");
    }
  } finally {
    console.error(`fixture-inspect setup ${JSON.stringify({
      samples: inspectElapsedMs.length, elapsedMs: inspectElapsedMs,
      totalElapsedMs: Math.round(performance.now() - inspectStarted),
    })}`);
  }
  // Execute the actual Serve logic with a deterministic native API double.
  // Only SetLastError is native in this copy: synthetic handles cannot target
  // any real process. Normal real-handle sentinel coverage still runs below.
  const nativeRegressionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rail-fixture-native-test-"));
  const nativeScript = fileURLToPath(new URL("./fixtures/fixture-process-native.ps1", import.meta.url));
  const sourceScript = fs.readFileSync(nativeScript, "utf8").replaceAll("\r\n", "\n");
  const nativeDouble = String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class PmeFixtureProcess {
  // NATIVE_FIXTURE_API_DOUBLE: no real process open or termination calls.
  [DllImport("kernel32.dll", EntryPoint="SetLastError", SetLastError=true)]
  private static extern void SetError(uint error);
  private static readonly string Mode = Environment.GetEnvironmentVariable("RAIL_NATIVE_TEST_MODE");
  private static bool normalExited;
  private static bool observationExited;
  private static bool originalExited;
  private static bool originalWaitError;
  private static void Log(string value) {
    File.AppendAllText(Environment.GetEnvironmentVariable("RAIL_NATIVE_TEST_CALLS"), value + Environment.NewLine);
  }
  public static IntPtr GetCurrentProcess() { return new IntPtr(-1); }
  public static uint GetProcessId(IntPtr handle) {
    Log("pid " + handle);
    if (handle == new IntPtr(9000)) return 900;
    if (handle == new IntPtr(2101)) return 101;
    if (handle == new IntPtr(2102)) return Mode == "original-pid-mismatch" ? 999u : 102u;
    if (handle == new IntPtr(1022)) return Mode == "capture-fixture-mismatch" ? 999u : 102u;
    return 0;
  }
  public static bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
      out IntPtr target, uint access, bool inherit, uint options) {
    Log("duplicate " + sourceProcess + " " + source + " " + targetProcess + " " + access + " " + inherit + " " + options);
    if (access != 0x101000 || inherit || options != 0) throw new InvalidOperationException("unsafe duplication options");
    target = IntPtr.Zero;
    if (Mode == "duplicate-failure") { SetError(5); return false; }
    if (sourceProcess == new IntPtr(9000) && targetProcess == new IntPtr(-1) && (source == new IntPtr(101) || source == new IntPtr(102))) {
      target = new IntPtr(2000 + source.ToInt32()); return true;
    }
    if (sourceProcess == new IntPtr(-1) && source == new IntPtr(1022) && targetProcess == new IntPtr(9000)) {
      target = new IntPtr(0x3333); return true;
    }
    throw new InvalidOperationException("unexpected duplication source");
  }
  public static IntPtr OpenProcess(uint access, bool inherit, int pid) {
    Log("open " + access + " " + pid);
    if (access == 0x101040 && pid == 900) return new IntPtr(9000);
    if (access == 0x101001) {
      if (Mode == "two-records" && pid == 101) return new IntPtr(1011);
      SetError(Mode == "non-five" ? 6u : Mode == "fresh-missing" ? 87u : 5u);
      return IntPtr.Zero;
    }
    if (access != 0x101000) throw new InvalidOperationException("unexpected access mask");
    if (Mode == "denied-fallback" || Mode == "original-exit-after-denials" || Mode == "original-final-wait-error") {
      originalExited = Mode == "original-exit-after-denials";
      originalWaitError = Mode == "original-final-wait-error";
      SetError(5); return IntPtr.Zero;
    }
    return new IntPtr(1022);
  }
  public static bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user) {
    Log("birth " + handle);
    creation = 134000000000000001; exit = 0; kernel = 0; user = 0;
    if (handle == new IntPtr(9000)) { creation = 134000000000000099; if (Mode == "controller-mismatch") creation++; return true; }
    if (handle == new IntPtr(2101) || handle == new IntPtr(2102)) {
      if (Mode == "original-birth-mismatch") creation++;
      return true;
    }
    if (Mode == "different" && handle == new IntPtr(1022)) creation++;
    if (Mode == "invalid-birth" && handle == new IntPtr(1022)) creation = 0;
    if ((Mode == "missing-birth" || Mode == "exit-during-birth") && handle == new IntPtr(1022)) {
      observationExited = Mode == "exit-during-birth";
      SetError(5); return false;
    }
    return true;
  }
  public static bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder name, ref int length) {
    Log("image " + handle); name.Append("C:\\Node\\node.exe"); return true;
  }
  public static uint WaitForSingleObject(IntPtr handle, uint milliseconds) {
    Log("wait " + handle + " " + milliseconds);
    if (handle == new IntPtr(9000)) return 258u;
    if (handle == new IntPtr(2101) || handle == new IntPtr(2102)) return originalWaitError ? 0xffffffff : Mode == "original-signaled" || originalExited ? 0u : 258u;
    if (handle == new IntPtr(1011)) return normalExited ? 0u : 258u;
    if (handle != new IntPtr(1022)) throw new InvalidOperationException("unexpected retained handle");
    if (Mode == "liveness-error") return 0xffffffff;
    return Mode == "signaled" || observationExited ? 0u : 258u;
  }
  public static bool TerminateProcess(IntPtr handle, uint code) {
    Log("terminate " + handle);
    if (handle != new IntPtr(1011)) throw new InvalidOperationException("observation handle reached termination API");
    normalExited = true; return true;
  }
  public static bool CloseHandle(IntPtr handle) { Log("close " + handle); return true; }
  public static string[] Arguments(string commandLine) {
    return new string[] { "C:\\Node\\node.exe", "C:\\tests\\fixture.mjs",
      "--rail-fixture-run=" + Environment.GetEnvironmentVariable("RAIL_NATIVE_TEST_RUN") };
  }
}
`;
  const nativeBlock = /\$nativeSource = @'[\s\S]*?\n'@/g;
  assert.equal([...sourceScript.matchAll(nativeBlock)].length, 1);
  let doubledScript = sourceScript.replace(nativeBlock, () => `$nativeSource = @'\n${nativeDouble}\n'@`);
  // Synthetic PIDs/handles must never reach the real emitted Inspect APIs.
  // Replace the complete unique binder definition, not just its call site.
  const inspectBindingBlock = /^# INSPECT_NATIVE_BINDINGS_BEGIN\n[\s\S]*?^# INSPECT_NATIVE_BINDINGS_END$/gm;
  assert.equal([...doubledScript.matchAll(inspectBindingBlock)].length, 1,
    "the complete real Inspect binder must be uniquely identified before any synthetic launch");
  doubledScript = doubledScript.replace(inspectBindingBlock, () => `
# NATIVE_FIXTURE_BINDING_DOUBLE
function Initialize-InspectNativeBindings {
  Add-Type -TypeDefinition $nativeSource | Out-Null
}`.trim());
  const serveEntry = "try {\n  if ($Operation -eq 'Inspect') {";
  assert.equal(doubledScript.split(serveEntry).length, 2);
  doubledScript = doubledScript.replace(serveEntry, `
function Get-CimInstance {
  param($ClassName, $Filter)
  [IO.File]::AppendAllText($env:RAIL_NATIVE_TEST_CALLS, ('cim' + [Environment]::NewLine))
  return @{ CommandLine = 'synthetic native protocol' }
}
${serveEntry}`);
  assert.ok(doubledScript.includes("NATIVE_FIXTURE_API_DOUBLE"));
  assert.ok(doubledScript.includes("NATIVE_FIXTURE_BINDING_DOUBLE"));
  assert.doesNotMatch(doubledScript, /INSPECT_NATIVE_BINDINGS_(?:BEGIN|END)|Reflection\.Emit|DefineDynamicAssembly|DefinePInvokeMethod|DefineMethod|PmeFixtureInspectNative/,
    "a protocol double must contain no real emitted native binding path");
  assert.deepEqual([...doubledScript.matchAll(/\[DllImport\([^)]*\)\]/g)].map((match) => match[0]),
    ['[DllImport("kernel32.dll", EntryPoint="SetLastError", SetLastError=true)]'],
    "SetLastError must be the only native import left in a synthetic protocol copy");
  assert.doesNotMatch(doubledScript, /extern\s+(?:IntPtr\s+(?:OpenProcess|GetCurrentProcess)|bool\s+(?:TerminateProcess|DuplicateHandle)|uint\s+GetProcessId)/,
    "a protocol double must never retain real process-open or termination P/Invokes");
  const doubledFile = path.join(nativeRegressionRoot, "native-protocol-double.ps1");
  fs.writeFileSync(doubledFile, doubledScript, { flag: "wx" });
  const powershell = path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const nativeEnvironment = { ...process.env };
  for (const key of Object.keys(nativeEnvironment)) if (key.toUpperCase() === "PSMODULEPATH") delete nativeEnvironment[key];
  nativeEnvironment.PSModulePath = path.join(path.dirname(powershell), "Modules");
  const controller = { controllerPid: 900, controllerCreationFileTime: "134000000000000099" };
  const runNative = (mode, { terminate = false, twoRecords = false, gone = false, proofFailure = false } = {}) => {
    const observed = { ...record, ...controller, pid: 102, recordId: randomUUID(), holderHandle: "0000000000000066" };
    const normal = { ...record, ...controller, pid: 101, recordId: randomUUID(), holderHandle: "0000000000000065" };
    if (mode === "invalid-holder") observed.holderHandle = "ffffffffffffffff";
    const records = twoRecords ? [normal, observed] : [observed];
    const decisions = [];
    if (twoRecords) decisions.push({ recordId: normal.recordId, action: "terminate" });
    if (!gone) decisions.push({ recordId: observed.recordId, action: terminate ? "terminate" : "leave" });
    const callsFile = path.join(nativeRegressionRoot, `${mode}${terminate ? "-terminate" : ""}.calls`);
    fs.writeFileSync(callsFile, "", { flag: "wx" });
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", doubledFile, "-Operation", "Serve"], {
      env: { ...nativeEnvironment, RAIL_NATIVE_TEST_MODE: mode, RAIL_NATIVE_TEST_CALLS: callsFile, RAIL_NATIVE_TEST_RUN: runId },
      input: [JSON.stringify({ version: 1, ...controller, records }), ...decisions.map((value) => JSON.stringify(value)), ""].join("\n"),
      encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    fs.writeFileSync(path.join(nativeRegressionRoot, `${mode}${terminate ? "-terminate" : ""}.result`),
      JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
    const messages = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const calls = fs.readFileSync(callsFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const open = calls.filter((call) => call.startsWith("open "));
    assert.deepEqual(open, [
      ...(twoRecords ? [`open ${0x101040} 900`, `open ${0x101001} 101`] : []),
      ...(mode === "invalid-holder" ? [] : [`open ${0x101040} 900`]),
      ...(proofFailure || mode === "original-signaled" ? [] : [`open ${0x101001} 102`, ...(["non-five", "fresh-missing"].includes(mode) ? [] : [`open ${0x101000} 102`])]),
    ], "exactly one limited fallback is allowed, only after access5");
    assert.equal(calls.filter((call) => call.startsWith("duplicate ")).length,
      ["invalid-holder", "controller-mismatch"].includes(mode) ? 0 : twoRecords ? 2 : 1);
    assert.equal(calls.filter((call) => call === "close 9000").length,
      open.filter((call) => call === `open ${0x101040} 900`).length, "each newly opened local controller handle closes exactly once");
    assert.equal(calls.filter((call) => call === "close 2101").length, twoRecords ? 1 : 0);
    assert.equal(calls.filter((call) => call === "close 2102").length,
      ["invalid-holder", "controller-mismatch", "duplicate-failure"].includes(mode) ? 0 : 1,
      "each successful local original duplicate closes exactly once, including mismatches and signaled originals");
    assert.equal(calls.some((call) => call === "close 101" || call === "close 102"), false, "remote source handles must never close");
    if (["original-birth-mismatch", "original-pid-mismatch"].includes(mode)) {
      assert.equal(calls.some((call) => call.startsWith("wait 2102 ")), false, "birth/PID validation must precede Wait");
    }
    assert.equal(calls.filter((call) => call === "close 1022").length,
      proofFailure || mode === "original-signaled" || ["non-five", "fresh-missing", "denied-fallback", "original-exit-after-denials", "original-final-wait-error"].includes(mode) ? 0 : 1, "each acquired observation handle must close exactly once");
    assert.equal(calls.filter((call) => call.startsWith("terminate ")).length, twoRecords ? 1 : 0,
      "no observation handle may reach the termination API, even for a forged controller action");
    assert.equal(calls.filter((call) => call === "cim").length, twoRecords ? 1 : 0,
      "fallback must never use a PID-only CIM lookup");
    assert.equal(calls.filter((call) => call.startsWith("image ")).length, twoRecords ? 1 : 0,
      "fallback birth evidence must not depend on optional image observation");
    if (twoRecords) assert.equal(calls.filter((call) => call === "close 1011").length, 1);
    if (terminate) {
      assert.equal(result.status, 1);
      assert.ok(messages.some((message) => message.type === "fatal" &&
        message.message === "termination requires a termination-capable retained process handle"));
    } else {
      assert.equal(result.status, 0);
      assert.equal(messages.at(-1).type, "done");
    }
    if (gone) {
      assert.ok(messages.some((message) => message.type === "result" && message.recordId === observed.recordId && message.state === "gone"));
      if (["original-signaled", "original-exit-after-denials"].includes(mode)) assert.ok(messages.some((message) => message.proof === "retained-original"));
      assert.equal(messages.some((message) => message.type === "inspect" && message.recordId === observed.recordId), false);
    } else {
      const inspection = messages.find((message) => message.type === "inspect" && message.recordId === observed.recordId);
      assert.ok(inspection?.live.error, "observation cannot erase the original authority error");
      if (!proofFailure) assert.equal(inspection.live.errorCode, mode === "non-five" ? 6 : mode === "fresh-missing" ? 87 : 5);
      assert.equal(inspection.live.errorPhase, proofFailure ? "retained-original" : "open-process");
      assert.equal(classifyFixtureProcess(observed, inspection.live, expected), mode === "different" ? "reused" : "unproven");
      if (mode === "denied-fallback") assert.equal(inspection.live.observationErrorCode, 5);
    }
  };
  let nativeRegressionError = null;
  try {
    for (const mode of ["capture", "controller-mismatch", "capture-fixture-mismatch", "invalid-birth"]) {
      const callsFile = path.join(nativeRegressionRoot, `${mode}-inspect.calls`);
      fs.writeFileSync(callsFile, "", { flag: "wx" });
      const captured = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", doubledFile, "-Operation", "Inspect", "-ProcessId", "102", "-ControllerProcessId", "900",
        "-ControllerCreationFileTime", controller.controllerCreationFileTime], {
        env: { ...nativeEnvironment, RAIL_NATIVE_TEST_MODE: mode, RAIL_NATIVE_TEST_CALLS: callsFile },
        encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
      });
      assert.ifError(captured.error);
      const calls = fs.readFileSync(callsFile, "utf8").trim().split(/\r?\n/);
      assert.equal(calls.filter((call) => call.startsWith("duplicate ")).length, mode === "capture" ? 1 : 0);
      assert.equal(calls.some((call) => call.startsWith("terminate ") || call === "close 13107"), false);
      assert.equal(calls.filter((call) => call === "close 1022").length, 1);
      assert.equal(calls.filter((call) => call === "close 9000").length,
        calls.filter((call) => call === `open ${0x101040} 900`).length, "capture closes each acquired local controller handle exactly once");
      if (mode === "capture") {
        assert.equal(captured.status, 0);
        const identity = JSON.parse(captured.stdout.trim());
        assert.equal(identity.holderHandle, "0000000000003333");
        assert.equal(identity.controllerPid, 900);
        assert.equal(identity.controllerCreationFileTime, controller.controllerCreationFileTime);
        assert.deepEqual(calls.filter((call) => call.startsWith("open ")), [`open ${0x101000} 102`, `open ${0x101040} 900`]);
      } else assert.equal(captured.status, 1);
    }
    for (const mode of ["different", "matching", "missing-birth", "invalid-birth", "denied-fallback", "liveness-error", "non-five", "fresh-missing", "original-final-wait-error"]) {
      runNative(mode);
    }
    runNative("signaled", { gone: true });
    runNative("exit-during-birth", { gone: true });
    runNative("matching", { terminate: true });
    runNative("two-records", { terminate: true, twoRecords: true });
    runNative("original-signaled", { gone: true });
    runNative("original-exit-after-denials", { gone: true });
    for (const mode of ["invalid-holder", "controller-mismatch", "original-pid-mismatch", "original-birth-mismatch", "duplicate-failure"]) {
      runNative(mode, { proofFailure: true });
    }
    runNative("original-birth-mismatch", { proofFailure: true, terminate: true });
  } catch (error) {
    nativeRegressionError = error;
    error.message += `\nNative protocol diagnostics preserved at ${nativeRegressionRoot}`;
    console.error(`Native protocol diagnostics preserved at ${nativeRegressionRoot}`);
    throw error;
  } finally {
    if (!nativeRegressionError) fs.rmSync(nativeRegressionRoot, { recursive: true, force: true });
  }
  // A deliberately exhausted permanent budget must never poison the broker
  // test that imports this module into its own controller process.
  const admissionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rail-fixture-admission-test-"));
  const admissionResult = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--admission-isolation", admissionRoot], {
    encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024,
  });
  const admissionLines = admissionResult.stdout.trim().split(/\r?\n/);
  const admissionOk = admissionLines.pop() === "admission-isolation ok";
  const tracePattern = /^fixture-admission setup \{"phase":"[a-z-]+","captures":\d+,"kills":\d+,"exits":\d+,"closes":\d+,"elapsedMs":\d+\}$/;
  if (admissionResult.error || admissionResult.status !== 0 || !admissionOk || admissionLines.some((line) => !tracePattern.test(line))) {
    fs.writeFileSync(path.join(admissionRoot, "controller-result.json"), JSON.stringify({
      status: admissionResult.status, signal: admissionResult.signal, stdout: admissionResult.stdout,
      stderr: admissionResult.stderr, errorCode: admissionResult.error?.code ?? null,
    }));
    throw new Error(`Isolated admission controller failed; evidence preserved at ${admissionRoot}`);
  }
  for (const line of admissionLines) console.log(line);
  fs.rmSync(admissionRoot, { recursive: true, force: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rail-fixture-ledger-test-"));
  const fixture = fileURLToPath(new URL("./fixtures/fake-claude-tui.mjs", import.meta.url));
  const ownedLedger = await createFixtureProcessLedger({ directory: path.join(root, "owned"), fixturePath: fixture });
  const foreignLedger = await createFixtureProcessLedger({ directory: path.join(root, "foreign"), fixturePath: fixture });
  const ledgers = new Set([ownedLedger, foreignLedger]);
  const children = [];
  const spawnErrors = new WeakMap();
  const childStderr = new WeakMap();
  let primaryError = null;
  const launch = (ledger, environment = {}) => {
    const child = spawn(process.execPath, [fixture, ...ledger.fixtureArgs], {
      env: { ...process.env, ...ledger.environment, RAIL_CONNECTOR_FAKE_CLAUDE_IGNORE_EXIT: "1", ...environment },
      windowsHide: true, stdio: ["pipe", "ignore", "pipe"],
    });
    child.on("error", (error) => { spawnErrors.set(child, error); });
    childStderr.set(child, "");
    child.stderr.on("data", (chunk) => {
      childStderr.set(child, (childStderr.get(child) + chunk.toString("utf8")).slice(-4096));
    });
    children.push(child);
    return child;
  };
  const childProcessBuiltin = createRequire(import.meta.url)("node:child_process");
  const withSpawnHook = async (hook, action) => {
    const original = childProcessBuiltin.spawn;
    childProcessBuiltin.spawn = (command, args, options) => hook(command, args, options, original);
    syncBuiltinESMExports();
    try { return await action(); }
    finally { childProcessBuiltin.spawn = original; syncBuiltinESMExports(); }
  };
  const awaitReady = async (ledger, child) => {
    const deadline = Date.now() + 20000;
    let pendingRecords = 0;
    const failure = (reason) => new Error(`${reason}: ${JSON.stringify({
      exitCode: child.exitCode, signalCode: child.signalCode, pendingRecords,
      stderrTail: childStderr.get(child),
    })}`);
    while (Date.now() < deadline) {
      if (spawnErrors.has(child)) throw spawnErrors.get(child);
      pendingRecords = 0;
      for (const value of await readFixtureProcessRecords(ledger.directory, ledger.runId)) {
        if (value.state === "ready") return value;
        if (value.state === "pending") pendingRecords++;
      }
      if (child.exitCode !== null || child.signalCode !== null) throw failure("Synthetic fixture exited before recording its process identity");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw failure("Synthetic fixture did not record its process identity");
  };
  try {
    const owned = launch(ownedLedger);
    const ownedRecord = await awaitReady(ownedLedger, owned);
    const foreign = launch(foreignLedger);
    const foreignRecord = await awaitReady(foreignLedger, foreign);
    assert.equal(JSON.stringify(ownedRecord).includes(ownedLedger.environment.RAIL_FAKE_CLAUDE_HANDLE_KEY), false,
      "the ephemeral key must never enter a disk record");
    const originalFile = path.join(ownedLedger.directory, `${ownedRecord.pid}-${ownedRecord.recordId}.json`);
    const originalBytes = fs.readFileSync(originalFile);
    let invalidNativeCalls = 0;
    await withSpawnHook(() => {
      invalidNativeCalls++;
      throw new Error("Forged identity must not launch a native helper");
    }, async () => {
      for (const changed of [
        { version: 2 }, { state: "pending" }, { runId: randomUUID() }, { recordId: randomUUID() }, { pid: ownedRecord.pid + 1 },
        { creationFileTime: (BigInt(ownedRecord.creationFileTime) + 1n).toString() },
        { fixturePath: ownedRecord.fixturePath + ".other" }, { executablePath: ownedRecord.executablePath + ".other" },
        { controllerPid: ownedRecord.controllerPid + 1 }, { controllerCreationFileTime: (BigInt(ownedRecord.controllerCreationFileTime) + 1n).toString() },
        { holderHandle: ownedRecord.holderHandle === "0000000000000001" ? "0000000000000002" : "0000000000000001" },
        { holderHandle: "ffffffffffffffff" }, { holderHandle: "-1" },
        { holderHandle: "00000000000000000" }, { holderHandle: null }, { holderMac: "0".repeat(64) }, { holderMac: null }, { unexpected: true },
      ]) {
        try {
          fs.writeFileSync(originalFile, JSON.stringify({ ...ownedRecord, ...changed }));
          await assert.rejects(ownedLedger.reap({ graceMs: 0 }), "every bound-field forgery must fail before any native operation");
        } finally { fs.writeFileSync(originalFile, originalBytes); }
      }
      const replayLedger = await createFixtureProcessLedger({ directory: path.join(root, "replay"), fixturePath: fixture });
      ledgers.add(replayLedger);
      const replayFile = path.join(replayLedger.directory, `${foreignRecord.pid}-${foreignRecord.recordId}.json`);
      try {
        fs.writeFileSync(replayFile, JSON.stringify({ ...foreignRecord, runId: replayLedger.runId }), { flag: "wx" });
        await assert.rejects(replayLedger.reap({ graceMs: 0 }), /identity was unproven/);
      } finally { fs.unlinkSync(replayFile); }
    });
    assert.equal(invalidNativeCalls, 0, "forged records and cross-ledger replay must not invoke native duplication at all");

    const naturalLedger = await createFixtureProcessLedger({ directory: path.join(root, "natural"), fixturePath: fixture });
    ledgers.add(naturalLedger);
    const natural = launch(naturalLedger, { RAIL_FAKE_CLAUDE_EXIT_ON_START: "1", RAIL_CONNECTOR_FAKE_CLAUDE_IGNORE_EXIT: "0" });
    const naturalRecord = await awaitReady(naturalLedger, natural);
    if (natural.exitCode === null && natural.signalCode === null) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Natural fixture did not exit")), 5000);
        natural.once("exit", () => { clearTimeout(timeout); resolve(); });
      });
    }
    assert.equal(natural.exitCode, 23);
    assert.throws(() => process.kill(natural.pid, 0), (error) => error.code === "ESRCH");
    let naturalNativeCalls = 0;
    let naturalWire = "";
    await withSpawnHook((command, args, options, original) => {
      naturalNativeCalls++;
      const helper = original(command, args, options);
      helper.stdout.on("data", (bytes) => { naturalWire += bytes.toString("utf8"); });
      return helper;
    }, () => naturalLedger.reap({ graceMs: 0, final: true }));
    assert.equal(naturalNativeCalls, 1, "an exited authenticated original must reach native held-handle proof");
    const naturalMessages = naturalWire.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(naturalMessages.some((message) => message.recordId === naturalRecord.recordId && message.state === "gone" && message.proof === "retained-original"), true,
      "natural exit must exercise DuplicateHandle, original PID/birth validation and Wait, not return an empty PID prefilter result");
    const naturalFile = path.join(naturalLedger.directory, `${naturalRecord.pid}-${naturalRecord.recordId}.json`);
    let exitedForgeryNativeCalls = 0;
    await withSpawnHook(() => {
      exitedForgeryNativeCalls++;
      throw new Error("Unauthenticated exited identity must not launch a native helper");
    }, async () => {
      try {
        fs.writeFileSync(naturalFile, JSON.stringify({ ...naturalRecord, holderMac: "0".repeat(64) }));
        await assert.rejects(naturalLedger.reap({ graceMs: 0, final: true }), /identity was unproven/,
          "an absent PID must never bypass invalid ready-record authentication");
      } finally { fs.writeFileSync(naturalFile, JSON.stringify(naturalRecord)); }
    });
    assert.equal(exitedForgeryNativeCalls, 0);
    assert.doesNotThrow(() => process.kill(owned.pid, 0), "owned sentinel must still be live before reaping");
    assert.doesNotThrow(() => process.kill(foreign.pid, 0), "foreign sentinel must be live before classification");
    const forged = { ...foreignRecord, recordId: randomUUID(), runId: ownedLedger.runId };
    const forgedFile = path.join(ownedLedger.directory, `${forged.pid}-${forged.recordId}.json`);
    fs.writeFileSync(forgedFile, JSON.stringify(forged), { flag: "wx" });
    await assert.rejects(ownedLedger.reap({ graceMs: 0 }), /identity was unproven/,
      "a same-image, same-fixture process with a different run argument must be left alone");
    assert.doesNotThrow(() => process.kill(foreign.pid, 0), "foreign same-image sentinel must survive");
    fs.unlinkSync(forgedFile);
    await ownedLedger.reap({ graceMs: 0 });
    assert.throws(() => process.kill(ownedRecord.pid, 0), (error) => error.code === "ESRCH");
    assert.doesNotThrow(() => process.kill(foreign.pid, 0));
    await foreignLedger.reap({ graceMs: 0 });
    assert.throws(() => process.kill(foreignRecord.pid, 0), (error) => error.code === "ESRCH");
    assert.ok(owned.pid && foreign.pid);


  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError = null;
    for (const child of children) {
      if (!child.pid) continue;
      if (child.exitCode === null && child.signalCode === null) {
        // These ChildProcess objects retain handles to our own sentinel spawns.
        try {
          await new Promise((resolve, reject) => {
            const exited = () => { clearTimeout(timeout); resolve(); };
            const timeout = setTimeout(() => {
              child.removeListener("exit", exited);
              reject(new Error("Task-owned sentinel did not exit; test evidence was preserved"));
            }, 5000);
            child.once("exit", exited);
            child.kill();
          });
        } catch (error) { cleanupError ??= error; }
      }
    }
    for (const ledger of ledgers) {
      try { await ledger.reap({ expectRecords: false, graceMs: 0, final: true }); }
      catch (error) { cleanupError ??= error; }
    }
    if (!cleanupError && !primaryError) {
      try {
        assert.equal(fs.realpathSync(path.dirname(root)).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
        assert.match(path.basename(root), /^rail-fixture-ledger-test-/);
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch (error) { cleanupError = error; }
    }
    if (primaryError) {
      const detail = `Synthetic ledger diagnostics preserved at ${root}`;
      console.error(detail);
      primaryError.message += `\n${detail}`;
    }
    if (cleanupError) {
      if (primaryError) {
        const detail = `Fixture cleanup also failed: ${cleanupError.message}`;
        console.error(detail);
        primaryError.message += `\n${detail}`;
      }
      else throw cleanupError;
    }
  }
}
console.log("fixture-process-ledger ok");

}

async function fixtureReadinessRegression() {
  const { FIXTURE_ADMISSION_TIMEOUT_MS, FIXTURE_UI_READY_TIMEOUT_MS, FIXTURE_READY_TIMEOUT_MS,
    DIRECT_FIXTURE_LEASE_TTL_MS, waitForFixtureReady } = fixtureHelper;
  assert.equal(FIXTURE_ADMISSION_TIMEOUT_MS, 15000, "fixture admission must keep its original deadline");
  assert.equal(FIXTURE_UI_READY_TIMEOUT_MS, 5000);
  assert.equal(FIXTURE_READY_TIMEOUT_MS, FIXTURE_ADMISSION_TIMEOUT_MS + FIXTURE_UI_READY_TIMEOUT_MS);
  assert.ok(DIRECT_FIXTURE_LEASE_TTL_MS >= FIXTURE_READY_TIMEOUT_MS + 10000,
    "a direct fixture lease must cover readiness and its existing operation allowance");
  assert.ok(DIRECT_FIXTURE_LEASE_TTL_MS >= 5000 && DIRECT_FIXTURE_LEASE_TTL_MS <= 300000);
  const expectedBanner = "ORIGINAL_CAPTURE_READY";
  function simulation({ bannerAt = Infinity, text = expectedBanner, exitAt = Infinity,
    captureError = null, captureAdvance = 0, firstCaptureAt = null } = {}) {
    let elapsed = 0;
    const timeouts = [];
    const sleeps = [];
    const promise = waitForFixtureReady({
      banner: expectedBanner, description: "synthetic readiness regression",
      now: () => elapsed,
      capture: async (timeoutMs) => {
        assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= FIXTURE_READY_TIMEOUT_MS,
          "each exact-generation capture receives a positive remaining request budget");
        assert.equal(timeoutMs, Math.ceil(FIXTURE_READY_TIMEOUT_MS - elapsed));
        timeouts.push(timeoutMs);
        if (timeouts.length === 1 && firstCaptureAt !== null) elapsed = firstCaptureAt;
        else elapsed += captureAdvance;
        if (captureError) throw captureError;
        if (elapsed >= exitAt) return "[managed session exited, code 75]\n" + expectedBanner;
        return elapsed >= bannerAt ? text : "";
      },
      sleep: async (milliseconds) => {
        assert.ok(milliseconds > 0 && milliseconds <= 25);
        assert.ok(milliseconds <= FIXTURE_READY_TIMEOUT_MS - elapsed, "sleep must not overrun the remaining wait budget");
        sleeps.push(milliseconds); elapsed += milliseconds;
      },
    });
    return { promise, timeouts, sleeps, elapsed: () => elapsed };
  }
  for (const bannerAt of [6000, 19900]) {
    const run = simulation({ bannerAt });
    await run.promise;
    assert.equal(run.elapsed(), bannerAt, "admission exceeding the old 5s UI-only budget must still be eligible");
    assert.ok(run.timeouts.length > 1);
  }
  for (const options of [{}, { bannerAt: 0, text: "REPLACEMENT_CAPTURE_READY" }]) {
    const run = simulation(options);
    await assert.rejects(run.promise, (error) => error.code === "EFIXTUREREADY" && /admission 15000ms \+ UI 5000ms/.test(error.message));
    assert.equal(run.elapsed(), FIXTURE_READY_TIMEOUT_MS, "missing or foreign banners cannot pass beyond the composite bound");
  }
  for (const captureAdvance of [FIXTURE_READY_TIMEOUT_MS, FIXTURE_READY_TIMEOUT_MS + 1]) {
    const run = simulation({ bannerAt: 0, captureAdvance });
    await assert.rejects(run.promise, (error) => error.code === "EFIXTUREREADY");
    assert.equal(run.timeouts.length, 1, "a late capture response must not accept even a matching banner or retry");
    assert.equal(run.sleeps.length, 0);
  }
  const exited = simulation({ exitAt: 15100 });
  await assert.rejects(exited.promise, (error) => error.code === "EFIXTUREEXIT" && /code 75/.test(error.message));
  assert.equal(exited.elapsed(), 15100, "an exited generation must fail promptly even when its capture retains the ready banner");
  const stale = Object.assign(new Error("injected exact-generation mismatch"), { code: "ESTALE" });
  const generationFailure = simulation({ captureError: stale });
  await assert.rejects(generationFailure.promise, (error) => error === stale);
  assert.equal(generationFailure.timeouts.length, 1, "generation mismatch must propagate unchanged without retry");
  assert.equal(generationFailure.sleeps.length, 0);
  const brokerTimeout = Object.assign(new Error("injected broker capture timeout"), { code: "ETIMEDOUT" });
  for (const captureAdvance of [FIXTURE_READY_TIMEOUT_MS - 0.5, FIXTURE_READY_TIMEOUT_MS]) {
    const atDeadline = simulation({ captureError: brokerTimeout, captureAdvance });
    await assert.rejects(atDeadline.promise, (error) => error.code === "EFIXTUREREADY" && error.cause === brokerTimeout);
    assert.equal(atDeadline.timeouts.length, 1, "an expired broker timeout must retain its cause without retry");
  }
  const earlyTimeout = simulation({ captureError: brokerTimeout, captureAdvance: 100 });
  await assert.rejects(earlyTimeout.promise, (error) => error === brokerTimeout);
  assert.equal(earlyTimeout.timeouts.length, 1, "an early transport timeout must propagate unchanged without retry");
  const lateExit = simulation({ exitAt: 0, captureAdvance: FIXTURE_READY_TIMEOUT_MS + 1 });
  await assert.rejects(lateExit.promise, (error) => error.code === "EFIXTUREEXIT" && /code 75/.test(error.message));
  assert.equal(lateExit.timeouts.length, 1, "a late final exit must retain its exit code and cannot pass using the banner");
  const fractional = simulation({ firstCaptureAt: FIXTURE_READY_TIMEOUT_MS - 0.5 });
  await assert.rejects(fractional.promise, (error) => error.code === "EFIXTUREREADY");
  assert.deepEqual(fractional.sleeps, [0.5], "the final sleep must clamp to the remaining fractional budget");
  assert.equal(fractional.timeouts.length, 1, "no capture request may start at an expired deadline");
  console.log("fixture-readiness regression ok");
}

function inspectFailureRegression() {
  if (process.platform === "win32") {
    const builtins = createRequire(import.meta.url)("node:child_process");
    const originalInspect = builtins.execFileSync;
    const originalConsoleError = console.error;
    const diagnosticMessages = [];
    const timeout = Object.assign(new Error("injected Inspect timeout"), {
      code: "ETIMEDOUT", pid: 456, status: null, signal: "SIGTERM", stdout: "",
      stderr: "[fixture-inspect] phase=script-entry\r\n[fixture-inspect] phase=before-native-bind\r\n",
    });
    let calls = 0;
    builtins.execFileSync = (command, args, options) => {
      calls++;
      assert.match(command, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
      assert.deepEqual(args, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        fileURLToPath(new URL("./fixtures/fixture-process-native.ps1", import.meta.url)),
        "-Operation", "Inspect", "-ProcessId", "123"]);
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"], "read-only Inspect must not create an unused stdin pipe");
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 15000, "the first Inspect deadline must remain unchanged");
      assert.equal(options.maxBuffer, 1024 * 1024);
      assert.equal(options.encoding, "utf8");
      throw timeout; // No synthetic PID may reach a native helper.
    };
    console.error = (message) => diagnosticMessages.push(String(message));
    syncBuiltinESMExports();
    try {
      let caught;
      try { inspectFixtureProcess(123); } catch (error) { caught = error; }
      assert.equal(caught, timeout, "diagnostics must rethrow the original failure");
      assert.equal(calls, 1, "a failed initial Inspect must never retry");
      assert.equal(caught.fixtureInspectFailure?.nativePhase, "before-native-bind");
      assert.equal(caught.fixtureInspectFailure?.stdout.bytes, 0);
      assert.equal(caught.fixtureInspectFailure?.helperPid, 456);
      assert.equal(caught.fixtureInspectFailure?.timeoutMs, 15000);
      assert.equal(diagnosticMessages.length, 1);
      assert.ok(diagnosticMessages[0].startsWith("fixture-inspect failure "));
      assert.deepEqual(JSON.parse(diagnosticMessages[0].slice("fixture-inspect failure ".length)), caught.fixtureInspectFailure);
      // Failure to attach optional metadata must also retain the primary error.
      Object.freeze(timeout);
      assert.throws(() => inspectFixtureProcess(123), (error) => error === timeout);
      assert.equal(calls, 2, "each independent call still makes only one attempt");
      assert.equal(diagnosticMessages.length, 2, "injected failures stay inside this test's captured diagnostics");
    } finally {
      console.error = originalConsoleError;
      builtins.execFileSync = originalInspect;
      syncBuiltinESMExports();
    }
  }
  const phase = "[fixture-inspect] phase=read-identity\r\n";
  const stderr = "never-emit-test-data".repeat(300) + "\n" + phase + "[fixture-inspect] phase=exit-error";
  const failure = { code: "ETIMEDOUT", pid: 456, status: null, signal: "SIGTERM", stdout: "", stderr };
  Object.defineProperty(failure, "env", { get() { assert.fail("diagnostics must not inspect environment values"); } });
  const record = fixtureHelper.fixtureInspectFailureRecord(failure, 123, 15002.125);
  assert.equal(record.nativePhase, "read-identity", "only the last complete allowed phase is evidence");
  assert.equal(record.elapsedMs, 15002.125, "observed elapsed time must not be clamped to the deadline");
  assert.equal(record.timeoutMs, 15000);
  assert.equal(record.stdout.bytes, 0);
  assert.equal(record.stdout.sha256, createHash("sha256").update("").digest("hex"));
  assert.equal(record.stderr.bytes, Buffer.byteLength(stderr));
  assert.equal(record.stderr.sha256, createHash("sha256").update(stderr).digest("hex"));
  assert.equal(record.stderr.hashComplete, true);
  assert.equal(JSON.stringify(record).includes("never-emit-test-data"), false, "raw diagnostic output must not escape");
  const absent = fixtureHelper.fixtureInspectFailureRecord({ code: "ENOENT" }, 123, 0);
  assert.equal(absent.stdout, null, "unavailable output is not empty-output proof");
  assert.equal(absent.stderr, null);
  assert.equal(absent.nativePhase, "unobserved");
  const oversized = Buffer.alloc(1024 * 1024 + 1, 97);
  const limited = fixtureHelper.fixtureInspectFailureRecord({ stdout: oversized, stderr: "[fixture-inspect] phase=unknown\n" }, 123, 1);
  assert.equal(limited.stdout.bytes, oversized.length);
  assert.equal(limited.stdout.hashedBytes, 1024 * 1024);
  assert.equal(limited.stdout.hashComplete, false, "a bounded prefix hash must never claim full-stream coverage");
  assert.equal(limited.nativePhase, "unobserved");
  for (const code of ["ENOBUFS", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
    const capped = fixtureHelper.fixtureInspectFailureRecord({ code, stdout: oversized.subarray(0, 1024 * 1024), stderr: "" }, 123, 1);
    assert.equal(capped.stdout.hashComplete, false, "a maxBuffer error cannot prove the child stream was complete");
    assert.equal(capped.stderr.hashComplete, false, "the overflowing stream is not known from the generic error alone");
  }
  console.log("fixture-inspect diagnostic regression ok");
}

async function isolatedAdmissionRegression(root) {
  const fixture = fileURLToPath(new URL("./fixtures/fake-claude-tui.mjs", import.meta.url));
  const controllerBirth = "134000000000000001";
  const ledgers = new Set();
  const expectedFailures = new Set();
  const builtins = createRequire(import.meta.url)("node:child_process");
  const originalInspect = builtins.execFileSync;
  builtins.execFileSync = (command, args) => {
    assert.equal(args.includes("Inspect") && !args.includes("-ControllerProcessId"), true);
    return JSON.stringify({ creationFileTime: controllerBirth, executablePath: fs.realpathSync(process.execPath) });
  };
  syncBuiltinESMExports();
  const withSpawnHook = async (hook, action) => {
    const original = builtins.spawn;
    builtins.spawn = hook;
    syncBuiltinESMExports();
    try { return await action(); }
    finally { builtins.spawn = original; syncBuiltinESMExports(); }
  };
  try {
    // Exercise the actual admission endpoint with an inert ChildProcess double.
    // These fake native captures allocate NO OS handles and never reach Serve;
    // real capture/exit/foreign-process cases run in the importing controller.
    const makePermitClient = (ledger, { replay = null, badMac = false, delayedAck = false } = {}) => {
      const environment = ledger.environment;
      const key = Buffer.from(environment.RAIL_FAKE_CLAUDE_HANDLE_KEY, "hex");
      const request = replay ?? { version: 1, runId: ledger.runId, recordId: randomUUID(), pid: process.pid };
      const tuple = ["fixture-handle-admission", 1, Number(environment.RAIL_FAKE_CLAUDE_CONTROLLER_PID), environment.RAIL_FAKE_CLAUDE_CONTROLLER_BIRTH,
        path.win32.normalize(ledger.directory).toLowerCase(), request.runId, request.recordId, request.pid];
      const sign = (value) => createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
      if (!replay) request.authorization = badMac ? "0".repeat(64) : sign(tuple);
      const socket = net.createConnection(environment.RAIL_FAKE_CLAUDE_HANDLE_PIPE);
      socket.setEncoding("utf8");
      let input = "";
      let accepted = false;
      let settled = false;
      let observedResult = null;
      let resolveResult; let rejectResult;
      const promise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      const timeout = setTimeout(() => { if (!settled) { settled = true; socket.destroy(); rejectResult(new Error("Synthetic admission request timed out")); } }, 5000);
      const finish = (granted) => {
        if (settled || observedResult !== null) return;
        observedResult = granted;
        // Sequential permit tests must drain the client connection before
        // opening another. A fully parsed completion/denial acknowledges every
        // protocol write; destroy only this client's completed connection to
        // avoid Windows named-pipe half-close latency, then await actual close.
        socket.destroy();
      };
      socket.on("error", () => { clearTimeout(timeout); if (!settled) { settled = true; rejectResult(new Error("Synthetic admission request failed")); } });
      socket.once("close", () => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        if (delayedAck) report("delayed-client-closed");
        if (observedResult === null) rejectResult(new Error("Synthetic admission transport closed without a result"));
        else resolveResult({ granted: observedResult, request });
      });
      socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
      socket.on("data", (bytes) => {
        try {
        input += bytes.toString("utf8");
        if (Buffer.byteLength(input) > 4096) { socket.destroy(); return; }
        if (!input.includes("\n")) return;
        const separator = input.indexOf("\n");
        const response = JSON.parse(input.slice(0, separator));
        input = input.slice(separator + 1);
        if (!accepted) {
          if (response.version === 1 && response.granted === false && Object.keys(response).sort().join() === "granted,version") return finish(false);
          if (response.version !== 1 || response.granted !== true || Object.keys(response).sort().join() !== "granted,record,version") throw new Error("Invalid admission response");
          accepted = true;
          const acknowledge = () => {
            if (delayedAck) report("delayed-ack-sent");
            socket.write(JSON.stringify({ version: 1, completed: true, runId: request.runId, recordId: request.recordId, pid: request.pid,
              authorization: sign(["fixture-handle-completed", ...tuple, response.record.holderMac]) }) + "\n");
          };
          if (delayedAck) {
            report("delayed-grant");
            assert.equal(mockCloses, 1, "capture must be closed before the delayed ACK window");
            report("delayed-capture-closed");
            delayedWindow = true;
            socket.unref(); timeout.unref();
            delayedDrain = ledger.reap({ expectRecords: false, graceMs: 0, final: true }).then(() => report("delayed-drain-done"));
            setTimeout(acknowledge, 150).unref();
          } else acknowledge();
        } else if (response.version === 1 && response.completed === true && Object.keys(response).sort().join() === "completed,version") {
          if (delayedAck) report("delayed-ack-confirmed");
          finish(true);
        }
        else throw new Error("Invalid admission completion");
        } catch {
          clearTimeout(timeout); settled = true; socket.destroy(); rejectResult(new Error("Synthetic admission response was malformed"));
        }
      });
      return { socket, promise, request };
    };
    let mockCaptures = 0;
    let mockKills = 0;
    let mockExits = 0;
    let mockCloses = 0;
    let delayedWindow = false;
    let delayedDrain;
    let prematureExit = false;
    const setupStarted = performance.now();
    const report = (phase) => console.log("fixture-admission setup " + JSON.stringify({ phase, captures: mockCaptures,
      kills: mockKills, exits: mockExits, closes: mockCloses, elapsedMs: Math.round(performance.now() - setupStarted) }));
    const beforeExit = () => { if (delayedWindow) { prematureExit = true; process.exitCode = 1; } };
    process.on("beforeExit", beforeExit);
    let holdCapture = false;
    let incompleteCapture = null;
    let captureStarted;
    let started = new Promise((resolve) => { captureStarted = resolve; });
    const priorKey = process.env.RAIL_FAKE_CLAUDE_HANDLE_KEY;
    process.env.RAIL_FAKE_CLAUDE_HANDLE_KEY = "ab".repeat(32);
    let primaryError = null;
    try {
      await withSpawnHook((command, args, options) => {
        assert.equal(args.includes("Inspect") && args.includes("-ControllerProcessId"), true, "the counter double must never receive a Serve/termination request");
        assert.equal(Object.keys(options.env).some((name) => name.toUpperCase() === "RAIL_FAKE_CLAUDE_HANDLE_KEY"), false,
          "a native capture must never inherit the ephemeral authentication key");
        mockCaptures++;
        const incomplete = incompleteCapture;
        const helper = new EventEmitter();
        helper.stdout = new PassThrough(); helper.stderr = new PassThrough(); helper.unref = () => {};
        let closed = false;
        const close = (code) => {
          if (closed) return;
          closed = true; mockExits++; mockCloses++; helper.emit("exit", code); helper.stdout.end(); helper.stderr.end(); helper.emit("close", code);
        };
        helper.kill = () => {
          mockKills++;
          if (incomplete === "no-exit") return true;
          if (incomplete === "no-close") {
            setImmediate(() => { mockExits++; helper.emit("exit", 1); });
          } else setImmediate(() => close(1));
          return true;
        };
        if (holdCapture) captureStarted();
        else setImmediate(() => {
          helper.stdout.write(JSON.stringify({ creationFileTime: controllerBirth,
            executablePath: fs.realpathSync(process.execPath), controllerPid: process.pid,
            controllerCreationFileTime: controllerBirth, holderHandle: "0000000000000abc" }));
          close(0);
        });
        return helper;
      }, async () => {
        const delayedLedger = await createFixtureProcessLedger({ directory: path.join(root, "delayed-ack"), fixturePath: fixture });
        ledgers.add(delayedLedger);
        report("delayed-ack-start");
        assert.equal((await makePermitClient(delayedLedger, { delayedAck: true }).promise).granted, true);
        await delayedDrain;
        delayedWindow = false;
        assert.equal(prematureExit, false, "final reap must retain a bounded resource through publication ACK");
        assert.equal(mockCloses, 1);
        report("delayed-ack-done");
        const canceledLedger = await createFixtureProcessLedger({ directory: path.join(root, "canceled-admission"), fixturePath: fixture });
        ledgers.add(canceledLedger);
        holdCapture = true;
        const interrupted = makePermitClient(canceledLedger);
        await started;
        interrupted.socket.destroy();
        await assert.rejects(interrupted.promise, /transport closed without a result/);
        await canceledLedger.reap({ expectRecords: false, graceMs: 0, final: true });
        assert.equal(mockKills, 1, "disconnect must cancel and drain only its exact owned helper");
        assert.equal(mockExits, 2, "final reap resolves only after the canceled helper exit");
        assert.equal(mockCloses, 2, "final reap resolves only after the canceled helper stdio closes");
        assert.equal((await makePermitClient(canceledLedger).promise).granted, false, "sealed admission rejects late permits while capacity remains");
        assert.equal(mockCaptures, 2, "sealed rejection never launches an extra capture");
        report("disconnect-done");
        for (const incomplete of ["no-exit", "no-close"]) {
          report(incomplete === "no-exit" ? "no-exit-start" : "no-close-start");
          const failedLedger = await createFixtureProcessLedger({ directory: path.join(root, incomplete), fixturePath: fixture });
          ledgers.add(failedLedger); expectedFailures.add(failedLedger);
          incompleteCapture = incomplete;
          started = new Promise((resolve) => { captureStarted = resolve; });
          const interrupted = makePermitClient(failedLedger);
          const pending = { version: 1, state: "pending", runId: failedLedger.runId, recordId: interrupted.request.recordId,
            pid: process.pid, fixturePath: fixture, creationFileTime: null };
          publishFixtureProcessRecord(failedLedger.directory, pending);
          const pendingFile = path.join(failedLedger.directory, `${pending.pid}-${pending.recordId}.json`);
          const evidence = fs.readFileSync(pendingFile);
          await started;
          interrupted.socket.destroy();
          await assert.rejects(interrupted.promise, /transport closed without a result/);
          await assert.rejects(failedLedger.reap({ expectRecords: false, graceMs: 0, final: true }),
            incomplete === "no-exit" ? /helperExitUnproven=true; stdioDrainUnproven=true/ : /helperExitUnproven=false; stdioDrainUnproven=true/);
          assert.deepEqual(fs.readFileSync(pendingFile), evidence, "unproved helper lifecycle must preserve pending fixture evidence");
          report(incomplete === "no-exit" ? "no-exit-done" : "no-close-done");
        }
        assert.equal(mockKills, 3);
        assert.equal(mockExits, 3, "no-exit cannot manufacture an exit event");
        assert.equal(mockCloses, 2, "no-close cannot manufacture stdio drain");
        incompleteCapture = null;
        holdCapture = false;
        const budgetA = await createFixtureProcessLedger({ directory: path.join(root, "budget-a"), fixturePath: fixture });
        const budgetB = await createFixtureProcessLedger({ directory: path.join(root, "budget-b"), fixturePath: fixture });
        ledgers.add(budgetA); ledgers.add(budgetB);
        const bad = await makePermitClient(budgetA, { badMac: true }).promise;
        assert.equal(bad.granted, false);
        assert.equal(mockCaptures, 4, "bad admission authentication cannot launch a native helper");
        let successful = 0;
        let firstRequest;
        for (let index = 0; index < 256; index++) {
          if (index % 64 === 0) report("budget-progress");
          const response = await makePermitClient(index % 2 ? budgetA : budgetB).promise;
          if (response.granted) {
            successful++;
            if (!firstRequest) {
              firstRequest = response.request;
              assert.equal((await makePermitClient(index % 2 ? budgetA : budgetB, { replay: firstRequest }).promise).granted, false,
                "replay must be rejected while controller capacity remains");
              assert.equal(mockCaptures, 5, "replay rejection never launches an extra capture");
            }
          }
        }
        assert.equal(successful, 252,
          `delayed and all uncertain canceled permits consume the controller-wide256 budget; captures=${mockCaptures}, exits=${mockExits}, closes=${mockCloses}`);
        assert.equal(mockCaptures, 256);
        assert.equal((await makePermitClient(budgetB, { replay: firstRequest }).promise).granted, false);
        const afterLimit = await createFixtureProcessLedger({ directory: path.join(root, "after-limit"), fixturePath: fixture });
        ledgers.add(afterLimit);
        assert.equal((await makePermitClient(afterLimit).promise).granted, false, "a new ledger cannot reset the controller budget");
        await budgetA.reap({ expectRecords: false, graceMs: 0, final: true });
        assert.equal((await makePermitClient(budgetA).promise).granted, false, "sealed admission rejects late permits");
        assert.equal(mockCaptures, 256, "cap, replay, new-ledger and sealed rejection never launch extra captures");
        report("budget-done");
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (priorKey === undefined) delete process.env.RAIL_FAKE_CLAUDE_HANDLE_KEY;
      else process.env.RAIL_FAKE_CLAUDE_HANDLE_KEY = priorKey;
      process.removeListener("beforeExit", beforeExit);
      const cleanupFailures = [];
      for (const ledger of ledgers) {
        try {
          const cleanup = ledger.reap({ expectRecords: false, graceMs: 0, final: true });
          if (expectedFailures.has(ledger)) await assert.rejects(cleanup, /helperExitUnproven=/);
          else await cleanup;
        } catch (error) { cleanupFailures.push(error); }
      }
      if (cleanupFailures.length) {
        if (primaryError) primaryError.message += `\nAdmission cleanup also failed: ${cleanupFailures.map((error) => error.message).join("; ")}`;
        else throw new AggregateError(cleanupFailures, "Isolated admission cleanup failed");
      }
      report("cleanup-done");
    }
  } finally {
    builtins.execFileSync = originalInspect;
    syncBuiltinESMExports();
  }
  console.log("admission-isolation ok");
}
