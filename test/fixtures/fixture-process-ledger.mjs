import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

const nativeScript = fileURLToPath(new URL("./fixture-process-native.ps1", import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRACE_MS = 5000;
const comparablePath = (value) => path.win32.normalize(value).toLowerCase();
const validPid = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
const runArgument = (runId) => `--rail-fixture-run=${runId}`;
const HANDLE_LIMIT = 256;
const KEY_ENV = "RAIL_FAKE_CLAUDE_HANDLE_KEY";
let controllerAdmission = null;

function validHandle(value) {
  return typeof value === "string" && /^[0-7][0-9a-f]{15}$/.test(value) && value !== "0000000000000000";
}

function mac(key, tuple) {
  return createHmac("sha256", key).update(JSON.stringify(tuple)).digest("hex");
}

function sameMac(value, expected) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) && timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(expected, "hex"));
}

function admissionTuple(context, record) {
  return ["fixture-handle-admission", 1, context.controllerPid, context.controllerCreationFileTime,
    comparablePath(context.directory), record.runId, record.recordId, record.pid];
}

function handleTuple(context, record) {
  return ["fixture-original-handle", 1, record.version, record.state, record.runId, record.recordId,
    record.pid, record.creationFileTime, comparablePath(record.fixturePath), comparablePath(record.executablePath),
    record.controllerPid, record.controllerCreationFileTime, record.holderHandle,
    comparablePath(context.directory), comparablePath(path.join(context.directory, `${record.pid}-${record.recordId}.json`))];
}

function authenticatedRecord(record, expected) {
  const fields = ["version", "state", "runId", "recordId", "pid", "creationFileTime", "fixturePath", "executablePath",
    "controllerPid", "controllerCreationFileTime", "holderHandle", "holderMac"];
  if (!record || Object.keys(record).sort().join() !== fields.sort().join() || record.version !== 1 || record.state !== "ready" ||
      record.runId !== expected.runId || !UUID.test(record.recordId ?? "") || !validPid(record.pid) ||
      !validFileTime(record.creationFileTime) || !validHandle(record.holderHandle) ||
      record.controllerPid !== expected.controllerPid || record.controllerCreationFileTime !== expected.controllerCreationFileTime ||
      typeof record.fixturePath !== "string" || comparablePath(record.fixturePath) !== comparablePath(expected.fixturePath) ||
      typeof record.executablePath !== "string" || comparablePath(record.executablePath) !== comparablePath(expected.executablePath)) return false;
  return sameMac(record.holderMac, mac(expected.key, handleTuple(expected, record)));
}

function getControllerAdmission() {
  if (controllerAdmission) return controllerAdmission;
  const identity = inspectFixtureProcess(process.pid);
  const state = {
    controllerPid: process.pid, controllerCreationFileTime: identity.creationFileTime,
    pipe: `\\\\.\\pipe\\rail-fixture-handles-${randomUUID()}`, contexts: new Map(), issued: new Set(), sockets: new Set(), activeCaptures: 0,
  };
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.unref();
    state.sockets.add(socket);
    let capture = null;
    let completion = null;
    const timeout = setTimeout(() => socket.destroy(), 15000 + 2 * GRACE_MS);
    timeout.unref();
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timeout); state.sockets.delete(socket);
      capture?.cancel();
      completion?.reject(new Error("Fixture registration disconnected"));
    });
    let input = "";
    let context = null;
    let request = null;
    let issuedRecord = null;
    let requested = false;
    socket.on("data", (bytes) => {
      input += bytes.toString("utf8");
      if (Buffer.byteLength(input) > 4096) return socket.destroy();
      if (!input.includes("\n")) return;
      try {
        const separator = input.indexOf("\n");
        const frame = JSON.parse(input.slice(0, separator));
        input = input.slice(separator + 1);
        if (input.trim()) throw new Error("Unexpected fixture registration frame");
        if (requested) {
          if (!issuedRecord || !completion || Object.keys(frame).sort().join() !== "authorization,completed,pid,recordId,runId,version" ||
              frame.version !== 1 || frame.completed !== true || frame.pid !== request.pid || frame.recordId !== request.recordId || frame.runId !== request.runId ||
              !sameMac(frame.authorization, mac(context.key, ["fixture-handle-completed", ...admissionTuple(context, request), issuedRecord.holderMac]))) {
            throw new Error("Invalid fixture registration completion");
          }
          completion.resolve();
          return;
        }
        requested = true;
        request = frame;
        context = state.contexts.get(request.runId);
        const fields = ["version", "runId", "recordId", "pid", "authorization"];
        const slot = `${request.runId}:${request.recordId}`;
        if (Object.keys(request).sort().join() !== fields.sort().join() || request.version !== 1 || !context || context.sealed ||
            !UUID.test(request.recordId ?? "") || !validPid(request.pid) || state.issued.has(slot) || state.issued.size >= HANDLE_LIMIT || state.activeCaptures >= 4 ||
            !sameMac(request.authorization, mac(context.key, admissionTuple(context, request)))) {
          socket.end(JSON.stringify({ version: 1, granted: false }) + "\n");
          return;
        }
        state.issued.add(slot); // Never reclaim: the remote handle lasts until controller exit.
        state.activeCaptures++;
        // Admitted publication owns a bounded event-loop lease through the
        // completion ACK, including after its transient capture child closes.
        // Idle/unauthenticated sockets and the listener remain unreferenced.
        socket.ref();
        timeout.ref();
        capture = captureFixtureProcess(request.pid, context);
        // The controller owns the only transient native capture, including its
        // cancellation/exit proof when a startup-race fixture disconnects.
        const registration = (async () => {
          try {
            const identity = await capture.promise;
            if (socket.destroyed) throw new Error("Fixture registration disconnected");
            const record = { version: 1, state: "ready", runId: request.runId, recordId: request.recordId, pid: request.pid,
              fixturePath: context.fixturePath, ...identity };
            if (comparablePath(record.executablePath) !== comparablePath(context.executablePath)) throw new Error("Fixture capture image changed");
            record.holderMac = mac(context.key, handleTuple(context, record));
            issuedRecord = Object.freeze(record);
            const completed = new Promise((resolve, reject) => { completion = { resolve, reject }; });
            socket.write(JSON.stringify({ version: 1, granted: true, record: issuedRecord }) + "\n");
            await completed;
            socket.end(JSON.stringify({ version: 1, completed: true }) + "\n");
          } catch (error) {
            if (error.captureUnclosed || (error.captureFailure && !error.captureCancelled)) {
              context.failures.push({ phase: error.nativePhase ?? "capture", exitUnproven: error.captureExitUnproven === true,
                drainUnproven: error.captureDrainUnproven === true });
            }
            socket.destroy();
          } finally {
            // End/destroy closes this exact socket and releases its deadline.
            // Keep the bounded lease through the completion reply/close too.
            state.activeCaptures--;
          }
        })();
        context.pending.add(registration);
        registration.finally(() => context.pending.delete(registration));
      } catch { socket.destroy(); /* Untrusted IPC data never reaches native capture. */ }
    });
  });
  server.maxConnections = 32;
  server.on("error", () => { state.failed = true; });
  state.ready = new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error("Fixture admission listener unavailable")));
    server.listen(state.pipe, resolve);
  });
  server.unref();
  process.once("beforeExit", () => {
    server.close();
    for (const socket of state.sockets) socket.destroy();
  });
  controllerAdmission = state;
  return state;
}

function requestAdmission(context, record, pipe) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe);
    socket.setEncoding("utf8");
    const timeout = setTimeout(() => fail(), 15000);
    timeout.unref();
    let input = "";
    let settled = false;
    let published = false;
    function fail() {
      if (settled) return;
      settled = true; clearTimeout(timeout); socket.destroy();
      reject(new Error("Fixture handle admission failed; pending evidence was preserved"));
    }
    socket.on("error", fail);
    socket.once("close", () => { if (!settled) fail(); });
    socket.once("connect", () => socket.write(JSON.stringify({ version: 1, runId: record.runId, recordId: record.recordId,
      pid: record.pid, authorization: mac(context.key, admissionTuple(context, record)) }) + "\n"));
    socket.on("data", (bytes) => {
      input += bytes.toString("utf8");
      if (Buffer.byteLength(input) > 4096) return fail();
      if (!input.includes("\n")) return;
      try {
        const separator = input.indexOf("\n");
        const response = JSON.parse(input.slice(0, separator));
        input = input.slice(separator + 1);
        if (input.trim()) return fail();
        if (!published) {
          if (Object.keys(response).sort().join() !== "granted,record,version" || response.version !== 1 || response.granted !== true ||
              response.record?.pid !== record.pid || response.record?.recordId !== record.recordId || !authenticatedRecord(response.record, context)) return fail();
          publishFixtureProcessRecord(context.directory, response.record);
          published = true;
          socket.write(JSON.stringify({ version: 1, completed: true, runId: record.runId, recordId: record.recordId, pid: record.pid,
            authorization: mac(context.key, ["fixture-handle-completed", ...admissionTuple(context, record), response.record.holderMac]) }) + "\n");
        } else {
          if (Object.keys(response).sort().join() !== "completed,version" || response.version !== 1 || response.completed !== true) return fail();
          settled = true; clearTimeout(timeout); socket.end(); resolve();
        }
      } catch { fail(); }
    });
  });
}

function validFileTime(value) {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 0x7fffffffffffffffn;
}

function nativePowerShell() {
  if (process.platform !== "win32") throw new Error("Fixture process cleanup requires Windows");
  const windowsDirectory = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const executable = path.join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!fs.existsSync(executable)) throw new Error("System Windows PowerShell is unavailable");
  return executable;
}

function nativeEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.toUpperCase() === "PSMODULEPATH" || key.toUpperCase() === KEY_ENV) delete environment[key];
  environment.PSModulePath = path.join(path.dirname(nativePowerShell()), "Modules");
  return environment;
}

export function inspectFixtureProcess(pid) {
  if (!validPid(pid)) throw new Error("Fixture process PID is invalid");
  // Only this reviewed test-helper process: no persistent execution-policy
  // change, and Windows Group Policy still takes precedence (including CI).
  const output = execFileSync(nativePowerShell(), [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", nativeScript, "-Operation", "Inspect", "-ProcessId", String(pid),
  ], { env: nativeEnvironment(), windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  const identity = JSON.parse(output.trim());
  if (!validFileTime(identity.creationFileTime) || typeof identity.executablePath !== "string" || !identity.executablePath) {
    throw new Error("Fixture process creation identity is unreadable");
  }
  return identity;
}

function captureFixtureProcess(pid, controller) {
  let child;
  let finished = false;
  let exited = false;
  let failure = null;
  let stdout = "";
  let stderrTail = "";
  let outputBytes = 0;
  let lastPhase = "capture";
  let deadline; let exitDeadline; let drainDeadline;
  let resolveResult; let rejectResult;
  const promise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  function finish(closed) {
    if (finished) return;
    finished = true;
    for (const timer of [deadline, exitDeadline, drainDeadline]) clearTimeout(timer);
    if (!closed || !exited) {
      failure ??= new Error("Fixture capture helper exit was unproven");
      failure.captureUnclosed = true;
      failure.captureExitUnproven = !exited;
      failure.captureDrainUnproven = !closed;
      child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
    }
    if (!failure) {
      try {
        const identity = JSON.parse(stdout.trim());
        const fields = ["creationFileTime", "executablePath", "controllerPid", "controllerCreationFileTime", "holderHandle"];
        if (Object.keys(identity).sort().join() !== fields.sort().join() || !validFileTime(identity.creationFileTime) ||
            typeof identity.executablePath !== "string" || !validHandle(identity.holderHandle) ||
            identity.controllerPid !== controller.controllerPid || identity.controllerCreationFileTime !== controller.controllerCreationFileTime) {
          throw new Error("Invalid capture output");
        }
        resolveResult(identity);
        return;
      } catch { failure = new Error("Fixture native capture output was unproven"); }
    }
    failure.captureFailure = true;
    failure.nativePhase = lastPhase;
    rejectResult(failure);
  }
  function cancel(reason = "disconnected") {
    if (finished || failure) return;
    failure = new Error(reason === "timeout" ? "Fixture native capture exceeded its unchanged 15000ms limit"
      : reason === "output" ? "Fixture native capture output exceeded its limit" : "Fixture capture controller disconnected");
    failure.captureCancelled = reason === "disconnected";
    try { child.kill(); } catch { /* Only this directly owned helper is targeted. */ }
    exitDeadline = setTimeout(() => finish(false), GRACE_MS);
  }
  try {
    child = spawn(nativePowerShell(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", nativeScript,
      "-Operation", "Inspect", "-ProcessId", String(pid), "-ControllerProcessId", String(controller.controllerPid),
      "-ControllerCreationFileTime", controller.controllerCreationFileTime], {
      env: nativeEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch { failure = new Error("Fixture capture helper could not launch"); finish(false); return { promise, cancel }; }
  child.on("error", () => { failure ??= new Error("Fixture capture helper could not launch"); });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (bytes) => {
    outputBytes += Buffer.byteLength(bytes);
    if (outputBytes > 1024 * 1024) return cancel("output");
    stdout += bytes.toString("utf8");
  });
  child.stderr.on("data", (bytes) => {
    outputBytes += Buffer.byteLength(bytes);
    if (outputBytes > 1024 * 1024) return cancel("output");
    stderrTail = (stderrTail + bytes.toString("utf8")).slice(-1024);
    for (const match of stderrTail.matchAll(/\[fixture-inspect\] phase=(script-entry|before-add-type|after-add-type|before-native-bind|after-native-bind|open-process|read-identity|write-identity|exit-success|exit-error)/g)) lastPhase = match[1];
  });
  child.once("exit", (code) => {
    exited = true;
    if (code !== 0) failure ??= new Error("Fixture native capture failed");
    clearTimeout(exitDeadline);
    drainDeadline = setTimeout(() => finish(false), 2000);
  });
  child.once("close", () => finish(true));
  deadline = setTimeout(() => cancel("timeout"), 15000);
  return { promise, cancel };
}

// The fake child records itself before accepting any test work. A pending
// record remains if inspection fails, so cleanup cannot overlook that child.
export async function recordFixtureProcess() {
  const directory = process.env.RAIL_FAKE_CLAUDE_PROCESS_DIR;
  if (!directory) return;
  const runId = process.env.RAIL_FAKE_CLAUDE_RUN_ID;
  if (!UUID.test(runId ?? "") || process.argv.filter((value) => value === runArgument(runId)).length !== 1) {
    throw new Error("Fixture process recording requires its exact run argument");
  }
  const recordId = randomUUID();
  const record = {
    version: 1, recordId, pid: process.pid, runId, state: "pending",
    fixturePath: fs.realpathSync(process.argv[1]), creationFileTime: null,
  };
  publishFixtureProcessRecord(directory, record);
  const key = process.env[KEY_ENV];
  const controllerPid = Number(process.env.RAIL_FAKE_CLAUDE_CONTROLLER_PID);
  const controllerCreationFileTime = process.env.RAIL_FAKE_CLAUDE_CONTROLLER_BIRTH;
  const pipe = process.env.RAIL_FAKE_CLAUDE_HANDLE_PIPE;
  if (!/^[0-9a-f]{64}$/.test(key ?? "") || !validPid(controllerPid) || !validFileTime(controllerCreationFileTime) ||
      !/^\\\\\.\\pipe\\rail-fixture-handles-[0-9a-f-]{36}$/.test(pipe ?? "")) throw new Error("Fixture handle context is unproven; pending evidence was preserved");
  const context = { key: Buffer.from(key, "hex"), directory: fs.realpathSync(directory), controllerPid, controllerCreationFileTime,
    runId, fixturePath: record.fixturePath, executablePath: fs.realpathSync(process.execPath) };
  await requestAdmission(context, record, pipe);
}

export function publishFixtureProcessRecord(directory, record) {
  if (!validPid(record?.pid) || !UUID.test(record?.recordId ?? "") || !UUID.test(record?.runId ?? "") ||
      !["pending", "ready"].includes(record?.state)) throw new Error("Invalid fixture process publication");
  const recordFile = path.join(directory, `${record.pid}-${record.recordId}.json`);
  // Both phases become visible only after the complete bytes have been closed.
  // The run-bound staging name also retains the PID if its publisher is stopped.
  const temporary = `${recordFile}.${record.runId}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
  const deadline = performance.now() + 250;
  let renameError = null;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    if (record.state === "ready") {
      // Only replace this publisher's pending identity. Never remove it first,
      // and revalidate before every retry if another writer changed the target.
      const invalidTarget = () => new Error("Fixture ready publication requires its unchanged pending record; evidence was preserved");
      const stat = fs.lstatSync(recordFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw invalidTarget();
      let pending;
      try { pending = JSON.parse(fs.readFileSync(recordFile, "utf8")); }
      catch (error) {
        if (error instanceof SyntaxError) throw new Error(invalidTarget().message, { cause: error });
        throw error;
      }
      if (pending?.version !== 1 || pending.pid !== record.pid || pending.recordId !== record.recordId ||
          pending.runId !== record.runId || pending.state !== "pending" || pending.creationFileTime !== null ||
          typeof pending.fixturePath !== "string" || pending.fixturePath !== record.fixturePath) throw invalidTarget();
    }
    if (renameError && performance.now() >= deadline) throw renameError;
    try { fs.renameSync(temporary, recordFile); return; }
    catch (error) {
      // Windows EPERM does not prove sharing contention. Keep any persistent
      // permission failure intact after this small monotonic retry bound.
      if (process.platform !== "win32" || record.state !== "ready" || error?.code !== "EPERM") throw error;
      renameError = error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      Atomics.wait(pause, 0, 0, Math.min(25, remaining));
    }
  }
}

// Used by the real held-handle protocol and its portable regression cases.
export function classifyFixtureProcess(record, live, expected) {
  if (!live) return "gone";
  if (!validPid(record?.pid) || !UUID.test(record?.recordId ?? "") || record?.runId !== expected.runId ||
      record?.state !== "ready" || !validFileTime(record?.creationFileTime) ||
      !validFileTime(live.creationFileTime)) return "unproven";
  // A different retained-handle birth excludes ownership even if a later
  // command-line query failed. Reused processes are preserved, never killed.
  if (record.creationFileTime !== live.creationFileTime) return "reused";
  if (live.error) return "unproven";
  if (typeof record.fixturePath !== "string" || comparablePath(record.fixturePath) !== comparablePath(expected.fixturePath) ||
      typeof record.executablePath !== "string" || comparablePath(record.executablePath) !== comparablePath(expected.executablePath) ||
      typeof live.executablePath !== "string" || comparablePath(live.executablePath) !== comparablePath(expected.executablePath)) return "unproven";
  if (!Array.isArray(live.argv) || live.argv.some((value) => typeof value !== "string") || live.argv.length < 3 ||
      comparablePath(live.argv[0]) !== comparablePath(expected.executablePath) ||
      comparablePath(live.argv[1]) !== comparablePath(expected.fixturePath) ||
      live.argv.filter((value) => value === runArgument(expected.runId)).length !== 1) return "unproven";
  return "owned";
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

export async function readFixtureProcessRecords(directory, runId, { publicationTimeoutMs = GRACE_MS } = {}) {
  if (!UUID.test(runId ?? "") || !Number.isSafeInteger(publicationTimeoutMs) ||
      publicationTimeoutMs < 0 || publicationTimeoutMs > GRACE_MS) throw new Error("Invalid fixture publication observation");
  const deadline = performance.now() + publicationTimeoutMs;
  const observed = new Map();
  while (true) {
    const names = fs.readdirSync(directory).sort();
    if (names.length > 512) throw new Error("Fixture process ledger exceeded its limit");
    const records = new Map();
    let publishing = false;
    for (const name of names) {
      const match = /^(\d+)-([0-9a-f-]{36})\.json(?:\.([0-9a-f-]{36})\.tmp)?$/i.exec(name);
      const pid = Number(match?.[1]);
      if (!match || !validPid(pid) || String(pid) !== match[1] || !UUID.test(match[2]) ||
          (match[3] !== undefined && match[3] !== runId)) throw new Error("Unexpected file in fixture process ledger");
      const key = `${pid}-${match[2]}`;
      const staging = match[3] !== undefined;
      if (staging) observed.set(key, { version: 1, pid, recordId: match[2], runId, state: "pending", creationFileTime: null });
      const file = path.join(directory, name);
      let stat;
      try { stat = fs.lstatSync(file); }
      catch (error) {
        if (staging && error?.code === "ENOENT") { publishing = true; continue; }
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Fixture record is not a regular file");
      if (staging) {
        // Partial staging is never parsed or promoted to an owned identity.
        // An absent PID proves only that the interrupted publisher is gone.
        if (processAlive(pid)) publishing = true;
        continue;
      }
      let record;
      try { record = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (error) { throw new Error("Fixture process final record is malformed or unreadable; evidence was preserved", { cause: error }); }
      if (record?.version !== 1 || record.pid !== pid || record.recordId !== match[2] ||
          record.runId !== runId || !["ready", "pending"].includes(record.state)) {
        throw new Error("Fixture process record does not belong to this test run");
      }
      records.set(key, record);
    }
    for (const [key, pending] of observed) {
      if (records.has(key)) continue;
      if (processAlive(pending.pid)) publishing = true;
      else records.set(key, pending); // Keep interrupted publication as explicit gone evidence.
    }
    const changed = JSON.stringify(names) !== JSON.stringify(fs.readdirSync(directory).sort());
    if (!publishing && !changed) return [...records.values()];
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Fixture process publication did not finish; identity was unproven and evidence was preserved");
    // Wait only for observed publication, never retry malformed final JSON.
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
}

function reapWithRetainedHandles(records, expected) {
  return new Promise((resolve, reject) => {
    const worker = spawn(nativePowerShell(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", nativeScript, "-Operation", "Serve"], {
      env: nativeEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const byId = new Map(records.map((record) => [record.recordId, record]));
    const decisions = new Map();
    const finished = new Set();
    const terminated = [];
    const failures = [];
    let done = false;
    let protocolError = null;
    let outputBytes = 0;
    const failProtocol = (message) => {
      protocolError ??= new Error(message);
      worker.stdin.destroy();
    };
    const deadline = setTimeout(() => {
      failProtocol("Fixture process cleanup timed out");
      worker.kill(); // Only this task-owned native helper, never a recorded PID.
    }, Math.min(120000, 30000 + records.length * 5000));
    worker.stderr.on("data", () => {});
    worker.stdin.on("error", () => { protocolError ??= new Error("Fixture cleanup controller disconnected"); });
    const lines = createInterface({ input: worker.stdout });
    lines.on("line", (line) => {
      outputBytes += Buffer.byteLength(line);
      if (outputBytes > 4 * 1024 * 1024) return failProtocol("Fixture cleanup output exceeded its limit");
      try {
        const message = JSON.parse(line);
        if (message.type === "fatal") throw new Error("Native fixture cleanup failed");
        if (message.type === "done") {
          if (done || finished.size !== records.length) throw new Error("Fixture cleanup completion is incomplete");
          done = true;
          worker.stdin.end();
          return;
        }
        const record = byId.get(message.recordId);
        if (!record || finished.has(message.recordId)) throw new Error("Unexpected fixture cleanup record");
        if (message.type === "inspect") {
          if (decisions.has(message.recordId) || !message.live || typeof message.live !== "object") throw new Error("Invalid fixture identity inspection");
          const verdict = classifyFixtureProcess(record, message.live, expected);
          decisions.set(message.recordId, verdict);
          if (verdict === "unproven") failures.push(`PID ${record.pid} identity was unproven; it was left alone ${JSON.stringify({
            snapshotState: record.state,
            snapshotHasBirth: validFileTime(record.creationFileTime),
            liveHasBirth: validFileTime(message.live.creationFileTime),
            birthMatches: validFileTime(record.creationFileTime) && validFileTime(message.live.creationFileTime)
              ? record.creationFileTime === message.live.creationFileTime : null,
            nativeErrorKind: message.live.error ? "unreadable" : null,
            nativeErrorCode: Number.isInteger(message.live.errorCode) && message.live.errorCode >= 0
              && message.live.errorCode <= 0xffffffff ? message.live.errorCode : null,
            nativeObservationErrorCode: Number.isInteger(message.live.observationErrorCode) && message.live.observationErrorCode >= 0
              && message.live.observationErrorCode <= 0xffffffff ? message.live.observationErrorCode : null,
            nativeFailurePhase: ["open-process", "read-identity", "query-command-line", "parse-command-line", "recheck-liveness", "retained-original"]
              .includes(message.live.errorPhase) ? message.live.errorPhase : null,
          })}`);
          worker.stdin.write(`${JSON.stringify({ recordId: record.recordId, action: verdict === "owned" ? "terminate" : "leave" })}\n`);
        } else if (message.type === "result") {
          if (!["gone", "left", "terminated"].includes(message.state)) throw new Error("Invalid fixture cleanup result");
          if (message.proof !== undefined && (message.state !== "gone" || message.proof !== "retained-original")) throw new Error("Invalid fixture exit proof");
          const decision = decisions.get(message.recordId);
          if (message.state === "terminated" && decision !== "owned") throw new Error("Fixture termination was not authorized");
          if (message.state === "left" && !["unproven", "reused", "gone"].includes(decision)) throw new Error("Fixture preservation has no identity decision");
          if (message.state === "terminated") terminated.push(record.pid);
          finished.add(record.recordId);
        } else throw new Error("Unknown fixture cleanup message");
      } catch (error) { failProtocol(error.message); }
    });
    worker.on("error", (error) => { protocolError ??= error; });
    worker.on("close", (code) => {
      clearTimeout(deadline);
      lines.close();
      if (protocolError || code !== 0 || !done) reject(protocolError ?? new Error("Native fixture cleanup did not finish"));
      else if (failures.length) reject(new Error(`Fixture process cleanup failed: ${failures.join("; ")}`));
      else resolve(terminated);
    });
    worker.stdin.write(`${JSON.stringify({ version: 1, controllerPid: expected.controllerPid,
      controllerCreationFileTime: expected.controllerCreationFileTime, records })}\n`);
  });
}

export async function createFixtureProcessLedger({ directory, fixturePath }) {
  // The supported main-thread controller owns one module-wide handle budget.
  // Worker isolates must not create independent budgets in the same process.
  if (!isMainThread) throw new Error("Fixture ledgers require the main-thread controller");
  const runId = randomUUID();
  fs.mkdirSync(directory); // The test must supply a fresh, task-owned directory.
  const canonicalDirectory = fs.realpathSync(directory);
  const admission = getControllerAdmission();
  await admission.ready; // Never give a fixture an unready or failed listener.
  if (admission.failed || admission.contexts.size >= HANDLE_LIMIT) throw new Error("Fixture admission controller unavailable");
  const expected = Object.freeze({ runId, directory: canonicalDirectory, key: randomBytes(32),
    controllerPid: admission.controllerPid, controllerCreationFileTime: admission.controllerCreationFileTime,
    fixturePath: fs.realpathSync(fixturePath), executablePath: fs.realpathSync(process.execPath) });
  const context = { ...expected, sealed: false, pending: new Set(), failures: [] };
  admission.contexts.set(runId, context);
  return Object.freeze({
    directory: canonicalDirectory,
    runId,
    fixtureArgs: Object.freeze([runArgument(runId)]),
    environment: Object.freeze({ RAIL_FAKE_CLAUDE_PROCESS_DIR: canonicalDirectory, RAIL_FAKE_CLAUDE_RUN_ID: runId,
      [KEY_ENV]: expected.key.toString("hex"), RAIL_FAKE_CLAUDE_CONTROLLER_PID: String(expected.controllerPid),
      RAIL_FAKE_CLAUDE_CONTROLLER_BIRTH: expected.controllerCreationFileTime, RAIL_FAKE_CLAUDE_HANDLE_PIPE: admission.pipe }),
    async reap({ expectRecords = true, graceMs = GRACE_MS, final = false } = {}) {
      if (process.platform !== "win32") throw new Error("Fixture process cleanup requires Windows");
      if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== canonicalDirectory) throw new Error("Fixture ledger directory changed");
      if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > GRACE_MS) throw new Error("Invalid fixture cleanup grace period");
      if (typeof final !== "boolean") throw new Error("Invalid fixture final cleanup");
      if (final) {
        context.sealed = true;
        // Drain already-admitted publication under its bounded capture/socket
        // lifecycle. Disconnect/deadline cancels only its exact owned helper;
        // interrupting a live publisher here would manufacture pending evidence.
        await Promise.allSettled([...context.pending]);
      }
      if (graceMs) await new Promise((resolve) => setTimeout(resolve, graceMs));
      const records = await readFixtureProcessRecords(canonicalDirectory, runId);
      if (records.length > 256) throw new Error("Fixture process ledger exceeded its limit");
      if (expectRecords && records.length === 0) throw new Error("No fixture process recorded its ownership");
      const trusted = [];
      const failures = [];
      if (admission.failed) failures.push("Fixture admission listener failed; evidence was preserved");
      for (const failure of context.failures) failures.push(`Fixture capture was unproven at ${failure.phase}; helperExitUnproven=${failure.exitUnproven}; stdioDrainUnproven=${failure.drainUnproven}`);
      for (const record of records) {
        if (record.state === "ready" && authenticatedRecord(record, expected)) {
          // Freeze this authenticated snapshot. Never reread disk after MAC verification.
          trusted.push(Object.freeze({ ...record }));
        } else if (record.state === "ready" || processAlive(record.pid)) {
          failures.push(`PID ${record.pid} identity was unproven; its original handle was not authenticated`);
        }
      }
      let terminated = [];
      try { if (trusted.length) terminated = await reapWithRetainedHandles(trusted, expected); }
      catch (error) { failures.push(error.message); }
      if (failures.length) throw new Error(`Fixture process cleanup failed: ${failures.join("; ")}`);
      return terminated;
    },
  });
}
