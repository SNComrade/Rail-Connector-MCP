import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { applyNodePtyFix, verifyNodePtyFix, nodePtyFixSpecPath } from "../tools/install-node-pty-fix.mjs";

// Read the installed compiled modules verbatim. Only install-guard fixtures
// reconstruct reviewed before bytes; the behavioral VMs never rewrite input.
const require = createRequire(import.meta.url);
const libraryRoot = path.dirname(require.resolve("node-pty"));
const packageRoot = path.dirname(libraryRoot);
const spec = JSON.parse(fs.readFileSync(nodePtyFixSpecPath, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = Object.fromEntries(["windowsTerminal", "windowsPtyAgent", "windowsConoutConnection"]
  .map((name) => [name, fs.readFileSync(path.join(libraryRoot, `${name}.js`), "utf8")]));
assert.equal(JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version, spec.version);
for (const name of ["windowsTerminal", "windowsPtyAgent"]) {
  const patch = spec.patches.find((item) => item.path === `lib/${name}.js`);
  assert.ok([patch.sha256Before, patch.sha256After].includes(sha256(sources[name])), "VM input must match reviewed installed bytes");
}

function clock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    get now() { return now; },
    get pending() { return timers.size; },
    setTimeout(callback, delay) {
      assert.ok(Number.isFinite(delay) && delay >= 0, "virtual timer requires a finite nonnegative delay");
      const token = { id: ++nextId };
      timers.set(token, { at: now + delay, callback });
      return token;
    },
    clearTimeout(token) { timers.delete(token); },
    advance(milliseconds) {
      const end = now + milliseconds;
      let fired = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0].id - b[0].id)[0];
        if (!next) break;
        assert.ok(++fired <= 1000, "virtual callback budget exceeded");
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = end;
    },
  };
}

class InertEmitter {
  constructor() { this.listeners = new Set(); }
  get event() { return (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
}

function evaluate(name, dependencies, virtualClock) {
  const exports = {};
  const context = {
    exports, module: { exports }, __dirname: libraryRoot,
    require(id) {
      assert.ok(Object.hasOwn(dependencies, id), `unapproved VM dependency: ${id}`);
      return dependencies[id];
    },
    process: { env: {}, cwd: () => libraryRoot, kill: () => assert.fail("VM must never target an OS PID") },
    console: { warn() {} },
    setTimeout: virtualClock.setTimeout, clearTimeout: virtualClock.clearTimeout,
  };
  vm.runInNewContext(sources[name], context, { filename: `inert/${name}.js`, timeout: 1000 });
  return exports;
}

function terminalBase() {
  function Terminal() { EventEmitter.call(this); }
  Object.setPrototypeOf(Terminal.prototype, EventEmitter.prototype);
  Terminal.prototype._checkType = () => {};
  Terminal.prototype._parseEnv = (environment) => Object.entries(environment).map(([key, value]) => `${key}=${value}`);
  Terminal.prototype._forwardEvents = () => {};
  Terminal.prototype._close = function () { this.closed = true; };
  Object.defineProperty(Terminal.prototype, "pid", { get() { return this._pid; } });
  return { Terminal, DEFAULT_COLS: 80, DEFAULT_ROWS: 24 };
}

function terminalModule(Agent, virtualClock) {
  return evaluate("windowsTerminal", {
    "./terminal": terminalBase(), "./windowsPtyAgent": { WindowsPtyAgent: Agent },
    "./utils": { assign: Object.assign },
  }, virtualClock).WindowsTerminal;
}

function agentHarness(options, { terminalBudget } = {}) {
  const virtualClock = clock();
  const sockets = [];
  const workers = [];
  const calls = { start: 0, connect: 0, kill: 0, open: 0, errors: [] };
  class Socket extends EventEmitter {
    constructor() { super(); this.destroyed = false; sockets.push(this); }
    setEncoding() {}
    write() {}
    connect() { virtualClock.setTimeout(() => this.emit("connect"), 0); }
    destroy() { this.destroyed = true; }
  }
  class Worker extends EventEmitter {
    constructor() { super(); this.ready = false; this.terminations = 0; workers.push(this); }
    emit(event, value) {
      if (event === "message" && value === 1) this.ready = true;
      return super.emit(event, value);
    }
    terminate() { this.terminations++; return Promise.resolve(0); }
  }
  const ConoutConnection = evaluate("windowsConoutConnection", {
    worker_threads: { Worker }, path,
    "./shared/conout": { getWorkerPipeName: () => "inert-output-pipe" },
    "./eventEmitter2": { EventEmitter2: InertEmitter },
  }, virtualClock).ConoutConnection;
  const native = {
    startProcess() { calls.start++; return { fd: -1, pty: 1, conin: "inert-input", conout: "inert-output" }; },
    connect() {
      calls.connect++;
      assert.equal(workers[0]?.ready, true, "native connect must follow observed worker READY");
      return { pid: 101 }; // Metadata only; never supplied to an OS API.
    },
    kill() { calls.kill++; }, resize() {}, clear() {},
  };
  const Agent = evaluate("windowsPtyAgent", {
    fs: { openSync() { calls.open++; return 4; } }, path,
    child_process: { fork: () => assert.fail("VM must never fork a console helper") },
    net: { Socket }, "./windowsConoutConnection": { ConoutConnection },
    "./eventEmitter2": { EventEmitter2: InertEmitter },
    "./utils": { loadNativeModule(name) { assert.equal(name, "conpty"); return { module: native }; } },
  }, virtualClock).WindowsPtyAgent;
  let agent;
  let terminal;
  if (terminalBudget !== undefined) {
    const Terminal = terminalModule(Agent, virtualClock);
    terminal = new Terminal("inert-shell.exe", [], { cwd: libraryRoot, env: {}, useConptyDll: true,
      conptyConnectionTimeout: terminalBudget });
    terminal.on("exit", (code) => calls.errors.push({ code, at: virtualClock.now }));
  } else {
    agent = new Agent("inert-shell.exe", [], [], libraryRoot, 80, 24, false, true, false, options);
    agent.onError((error) => calls.errors.push({ message: error.message, at: virtualClock.now }));
  }
  return { clock: virtualClock, sockets, workers, calls, agent, terminal };
}

const results = [];
const failures = [];
function check(name, action) {
  try { action(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, message: error.message }); failures.push(error); }
}

check("public option forwarding and bounds", () => {
  const constructed = [];
  class Agent {
    constructor(...args) {
      constructed.push(args);
      this.outSocket = new EventEmitter(); this.innerPid = 0; this.fd = -1; this.pty = 1;
    }
    onError() {}
  }
  const Terminal = terminalModule(Agent, clock());
  for (const value of [1, 15000, 30000]) {
    new Terminal("inert-shell.exe", [], { cwd: libraryRoot, env: {}, conptyConnectionTimeout: value });
    assert.equal(constructed.at(-1)[9]?.connectionTimeout, value, "actual WindowsTerminal must forward the public option");
  }
  new Terminal("inert-shell.exe", [], { cwd: libraryRoot, env: {} });
  assert.equal(constructed.at(-1)[9], undefined, "unconfigured upstream default must remain selected");
  for (const value of [0, -1, 30001, 1.5, NaN, Infinity, "15000"]) {
    const before = constructed.length;
    assert.throws(() => new Terminal("inert-shell.exe", [], { cwd: libraryRoot, env: {}, conptyConnectionTimeout: value }),
      (error) => error.name === "RangeError");
    assert.equal(constructed.length, before, "invalid option must fail before an agent is constructed");
  }
});

check("actual terminal accepts worker READY at6000 under15000", () => {
  const h = agentHarness(undefined, { terminalBudget: 15000 });
  h.clock.advance(6000);
  assert.equal(h.calls.connect, 0);
  assert.equal(h.calls.kill, 0, "configured readiness must not abort at upstream5000");
  assert.equal(h.calls.errors.length, 0);
  h.workers[0].emit("message", 1);
  h.clock.advance(0);
  assert.equal(h.calls.connect, 1);
  assert.equal(h.terminal.pid, 101);
  h.clock.advance(20000);
  assert.equal(h.calls.kill, 0, "successful readiness clears its connection timer");
});

check("partial agent option preserves default factory", () => {
  const h = agentHarness({ connectionTimeout: 15000 });
  assert.equal(h.workers.length, 1, "partial options must retain the actual default conout factory");
  h.clock.advance(6000);
  assert.equal(h.calls.kill, 0);
  h.workers[0].emit("message", 1);
  h.clock.advance(0);
  assert.equal(h.calls.connect, 1);
  assert.equal(h.agent.innerPid, 101);
});

check("unconfigured upstream timeout remains5000", () => {
  const h = agentHarness();
  h.clock.advance(4999);
  assert.equal(h.calls.kill, 0);
  h.clock.advance(1);
  assert.equal(h.calls.kill, 1);
  assert.equal(h.calls.errors.length, 1);
  assert.equal(h.calls.errors[0].at, 5000);
  assert.equal(h.agent.exitCode, -1);
});

check("configured15000 timeout disposes and ignores late READY", () => {
  const h = agentHarness({ connectionTimeout: 15000 });
  h.clock.advance(14999);
  assert.equal(h.calls.kill, 0);
  h.clock.advance(1);
  assert.equal(h.calls.kill, 1);
  assert.equal(h.calls.errors.length, 1);
  assert.equal(h.calls.errors[0].at, 15000);
  assert.equal(h.agent.exitCode, -1);
  assert.ok(h.sockets.every((socket) => socket.destroyed));
  h.workers[0].emit("message", 1);
  h.clock.advance(20000);
  assert.equal(h.calls.connect, 0);
  assert.equal(h.calls.kill, 1);
  assert.equal(h.calls.errors.length, 1);
  assert.equal(h.workers[0].terminations, 1);
});

for (const reason of ["error", "exit0", "exit1"]) check(`pre-ready worker ${reason} is fatal`, () => {
  const h = agentHarness({ connectionTimeout: 15000 });
  if (reason === "error") h.workers[0].emit("error", new Error("inert worker failure"));
  else h.workers[0].emit("exit", reason === "exit0" ? 0 : 1);
  assert.equal(h.calls.kill, 1);
  assert.equal(h.calls.errors.length, 1);
  assert.equal(h.agent.exitCode, -1);
  assert.ok(h.sockets.every((socket) => socket.destroyed));
  h.workers[0].emit("message", 1);
  h.clock.advance(30000);
  assert.equal(h.calls.connect, 0);
  assert.equal(h.calls.kill, 1);
  assert.equal(h.calls.errors.length, 1);
  assert.equal(h.workers[0].terminations, 1);
});

check("explicit kill clears timer and ignores late READY", () => {
  const h = agentHarness({ connectionTimeout: 15000 });
  h.clock.advance(1000);
  h.agent.kill();
  assert.equal(h.calls.kill, 1);
  assert.equal(h.clock.pending, 0);
  h.workers[0].emit("message", 1);
  h.clock.advance(30000);
  assert.equal(h.calls.connect, 0);
  assert.equal(h.calls.kill, 1);
  assert.equal(h.calls.errors.length, 0);
  // Simulate already-buffered output so the unchanged DLL drain path runs.
  h.agent.outSocket.emit("data", "inert buffered output");
  h.clock.advance(1000);
  assert.equal(h.workers[0].terminations, 1);
});

check("install guards idempotence tamper and partial known state", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rail-node-pty-install-guard-"));
  const canonicalRoot = fs.realpathSync(fixtureRoot);
  const beforeBytes = new Map(spec.patches.map((patch) => {
    let bytes = fs.readFileSync(path.join(packageRoot, patch.path));
    if (sha256(bytes) === patch.sha256After) {
      let text = bytes.toString("utf8");
      for (const { from, to } of [...patch.replacements].reverse()) {
        assert.equal(text.split(to).length, 2, "known patched fixture must have one reverse anchor");
        text = text.replace(to, from);
      }
      bytes = Buffer.from(text);
    }
    assert.equal(sha256(bytes), patch.sha256Before);
    return [patch.path, bytes];
  }));
  let primaryError = null;
  const makePackage = (name) => {
    const directory = path.join(fixtureRoot, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: spec.package, version: spec.version }));
    for (const [relative, bytes] of beforeBytes) {
      const target = path.join(directory, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    return directory;
  };
  const hashes = (directory) => spec.patches.map((patch) => sha256(fs.readFileSync(path.join(directory, patch.path))));
  try {
    const pristine = makePackage("pristine");
    assert.throws(() => verifyNodePtyFix({ packageRoot: pristine }), (error) => error.code === "EPTYCOMPAT");
    assert.equal(applyNodePtyFix({ packageRoot: pristine }).appliedFiles, 3);
    assert.equal(verifyNodePtyFix({ packageRoot: pristine }).verifiedFiles.length, 3);
    assert.deepEqual(hashes(pristine), spec.patches.map((patch) => patch.sha256After));
    const installed = hashes(pristine);
    assert.equal(applyNodePtyFix({ packageRoot: pristine }).appliedFiles, 0);
    assert.deepEqual(hashes(pristine), installed);

    const tampered = makePackage("tampered-last-target");
    fs.appendFileSync(path.join(tampered, spec.patches.at(-1).path), "\n// unknown fixture modification\n");
    const tamperedBefore = hashes(tampered);
    assert.throws(() => applyNodePtyFix({ packageRoot: tampered }), (error) => error.code === "EPTYCOMPAT");
    assert.deepEqual(hashes(tampered), tamperedBefore, "all targets must preflight before the first write");

    const wrongVersion = makePackage("unsupported-version");
    fs.writeFileSync(path.join(wrongVersion, "package.json"), JSON.stringify({ name: spec.package, version: "0.0.0" }));
    const unsupportedBefore = hashes(wrongVersion);
    assert.throws(() => applyNodePtyFix({ packageRoot: wrongVersion }), (error) => error.code === "EPTYCOMPAT");
    assert.deepEqual(hashes(wrongVersion), unsupportedBefore);

    const interrupted = makePackage("known-partial-install");
    fs.copyFileSync(path.join(pristine, spec.patches[0].path), path.join(interrupted, spec.patches[0].path));
    assert.equal(applyNodePtyFix({ packageRoot: interrupted }).appliedFiles, 2);
    assert.deepEqual(hashes(interrupted), installed);
  } catch (error) {
    primaryError = error;
    console.error(`node-pty install-guard evidence preserved: ${path.basename(fixtureRoot)}`);
    throw error;
  } finally {
    if (!primaryError) {
      assert.equal(fs.realpathSync(fixtureRoot), canonicalRoot);
      assert.equal(path.dirname(canonicalRoot), fs.realpathSync(os.tmpdir()));
      assert.ok(path.basename(canonicalRoot).startsWith("rail-node-pty-install-guard-"));
      fs.rmSync(canonicalRoot, { recursive: true });
    }
  }
});

console.log(JSON.stringify({ test: "node-pty-startup", virtualClock: true, realNativeCalls: 0,
  sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, text]) => [name, sha256(text)])), results }));
if (failures.length) throw new AggregateError(failures, "node-pty startup compatibility checks failed");
console.log("node-pty-startup ok");
