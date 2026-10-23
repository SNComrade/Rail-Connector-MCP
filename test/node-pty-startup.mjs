import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { applyNodePtyFix, verifyNodePtyFix, nodePtyFixSpecPath } from "../tools/install-node-pty-fix.mjs";

// Behavioral VMs read the reviewed installed postimages verbatim. Installer
// fixtures and an explicit hash-qualified negative control reconstruct before
// bytes without rewriting any installed dependency file.
const require = createRequire(import.meta.url);
const libraryRoot = path.dirname(require.resolve("node-pty"));
const packageRoot = path.dirname(libraryRoot);
const spec = JSON.parse(fs.readFileSync(nodePtyFixSpecPath, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Historical99f readiness identities are independent of the new descriptor.
// In particular, a future recipe edit must not silently redefine this upgrade.
const historicalReadiness = [
  { path: "lib/windowsTerminal.js",
    sha256Before: "b05d53d49cf9f422c2836029676ac2829f59cc14f5bbbbfaafa08382ff044267",
    sha256After: "75fd46726fb2bf55b9461e365413867fdad223764de974532024d206817a2494" },
  { path: "lib/windowsPtyAgent.js",
    sha256Before: "4f503c377b11cbd113e1f32b3932fdc35e8132b0e647f4c6b70dc84224127c53",
    sha256After: "b0596fd3813b9bf1428531c504b6e0bdce311a484e743e3623a3966cc40804aa" },
  { path: "typings/node-pty.d.ts",
    sha256Before: "5e2960f29b6d3ca6b8a438cca419e0485d046cb7d9acf67471d5627803ad8db0",
    sha256After: "915230c6276abe2eeb0c74319c18967187970f4d960bd8d29a9d806b7d7beb2c" },
];
assert.deepEqual(spec.patches.slice(0, 3).map(({ path, sha256Before, sha256After }) =>
  ({ path, sha256Before, sha256After })), historicalReadiness);
const originalConoutHash = "c87159520fc74cb0745f273260cc701cdb9e4c01ab0bae12cb4bd8d7f6e2f7c9";
const sources = Object.fromEntries(["windowsTerminal", "windowsPtyAgent", "windowsConoutConnection"]
  .map((name) => [name, fs.readFileSync(path.join(libraryRoot, `${name}.js`), "utf8")]));
assert.equal(JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version, spec.version);
for (const name of ["windowsTerminal", "windowsPtyAgent", "windowsConoutConnection"]) {
  const patch = spec.patches.find((item) => item.path === `lib/${name}.js`);
  assert.equal(sha256(sources[name]), patch.sha256After, "behavioral VM input must match reviewed installed postimage");
}

function reconstructBefore(patch, afterBytes) {
  assert.equal(sha256(afterBytes), patch.sha256After, "reconstruction requires a reviewed postimage");
  let text = afterBytes.toString("utf8");
  for (const { from, to } of [...patch.replacements].reverse()) {
    assert.equal(text.split(to).length, 2, "known postimage must have exactly one reverse anchor");
    text = text.replace(to, from);
  }
  const bytes = Buffer.from(text);
  assert.equal(sha256(bytes), patch.sha256Before);
  return bytes;
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

function evaluate(name, dependencies, virtualClock, beforeConout) {
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
  if (beforeConout !== undefined) {
    assert.equal(name, "windowsConoutConnection", "only the explicit Conout negative control may override VM input");
    assert.equal(sha256(beforeConout), originalConoutHash);
  }
  vm.runInNewContext(beforeConout ?? sources[name], context, { filename: `inert/${name}.js`, timeout: 1000 });
  return exports;
}

function terminalBase() {
  function Terminal() { EventEmitter.call(this); }
  Object.setPrototypeOf(Terminal.prototype, EventEmitter.prototype);
  Terminal.prototype._checkType = () => {};
  Terminal.prototype._parseEnv = (environment) => Object.entries(environment).map(([key, value]) => `${key}=${value}`);
  Terminal.prototype._forwardEvents = function () { this._socket.on("data", (data) => this.emit("data", data)); };
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

function agentHarness(options, { terminalBudget, throughTerminal = false, useConptyDll = true, connectError,
  closeOnTerminate = false, beforeConout } = {}) {
  const virtualClock = clock();
  const sockets = [];
  const workers = [];
  const calls = { start: 0, connect: 0, kill: 0, open: 0, helpers: 0, errors: [], events: [] };
  let onNativeExit;
  class Socket extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.closed = false; sockets.push(this); }
    setEncoding() {}
    write() {}
    connect() { virtualClock.setTimeout(() => { if (!this.destroyed) this.emit("connect"); }, 0); }
    destroy() {
      if (this.destroyed) return this;
      this.destroyed = true;
      // Model net.Socket's asynchronous, once-only close notification.
      virtualClock.setTimeout(() => { this.closed = true; this.emit("close"); }, 0);
      return this;
    }
  }
  class Worker extends EventEmitter {
    constructor() { super(); this.ready = false; this.terminations = 0; workers.push(this); }
    emit(event, value) {
      if (event === "message" && value === 1) this.ready = true;
      return super.emit(event, value);
    }
    terminate() {
      this.terminations++;
      calls.events.push({ kind: "terminate", at: virtualClock.now });
      if (closeOnTerminate) sockets[0].destroy(); // Inert relay-close consequence of Worker shutdown.
      return Promise.resolve(0);
    }
  }
  const ConoutConnection = evaluate("windowsConoutConnection", {
    worker_threads: { Worker }, path,
    "./shared/conout": { getWorkerPipeName: () => "inert-output-pipe" },
    "./eventEmitter2": { EventEmitter2: InertEmitter },
  }, virtualClock, beforeConout).ConoutConnection;
  const native = {
    startProcess() { calls.start++; return { fd: -1, pty: 1, conin: "inert-input", conout: "inert-output" }; },
    connect(...args) {
      calls.connect++;
      assert.equal(workers[0]?.ready, true, "native connect must follow observed worker READY");
      if (connectError) throw connectError;
      onNativeExit = args.at(-1);
      return { pid: 101 }; // Metadata only; never supplied to an OS API.
    },
    kill() { calls.kill++; }, resize() {}, clear() {},
  };
  const Agent = evaluate("windowsPtyAgent", {
    fs: { openSync() { calls.open++; return 4; } }, path,
    child_process: { fork() {
      // The default backend queries a console helper on kill. This boundary is
      // an inert emitter, never child_process.fork or an OS process handle.
      calls.helpers++;
      const helper = new EventEmitter();
      helper.kill = () => assert.fail("inert console helper must answer before its timeout");
      virtualClock.setTimeout(() => helper.emit("message", { consoleProcessList: [] }), 0);
      return helper;
    } },
    net: { Socket }, "./windowsConoutConnection": { ConoutConnection },
    "./eventEmitter2": { EventEmitter2: InertEmitter },
    "./utils": { loadNativeModule(name) { assert.equal(name, "conpty"); return { module: native }; } },
  }, virtualClock).WindowsPtyAgent;
  let agent;
  let terminal;
  if (terminalBudget !== undefined || throughTerminal) {
    const Terminal = terminalModule(Agent, virtualClock);
    terminal = new Terminal("inert-shell.exe", [], { cwd: libraryRoot, env: {}, useConptyDll,
      conptyConnectionTimeout: terminalBudget });
    agent = terminal._agent;
    terminal.on("exit", (code) => calls.events.push({ kind: "exit", code, at: virtualClock.now }));
    terminal.on("data", (data) => calls.events.push({ kind: "data", data, at: virtualClock.now }));
  } else {
    agent = new Agent("inert-shell.exe", [], [], libraryRoot, 80, 24, false, useConptyDll, false, options);
    agent.onError((error) => calls.errors.push({ message: error.message, at: virtualClock.now }));
  }
  return { clock: virtualClock, sockets, workers, calls, agent, terminal,
    nativeExit(code) {
      assert.equal(typeof onNativeExit, "function", "native exit requires a completed connection");
      onNativeExit(code);
    },
    output(data) {
      assert.equal(sockets[0].closed, false, "no output may arrive after socket close");
      sockets[0].emit("data", data);
    },
    closeOutput() { sockets[0].destroy(); virtualClock.advance(0); },
    ready() { workers[0].emit("message", 1); virtualClock.advance(0); },
  };
}

const results = [];
const failures = [];
const installerEvidence = {};
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

for (const useConptyDll of [false, true]) check(`backend${useConptyDll} unconfigured upstream timeout remains5000`, () => {
  const h = agentHarness(undefined, { useConptyDll });
  h.clock.advance(4999);
  assert.equal(h.calls.kill, 0);
  h.clock.advance(1);
  assert.equal(h.calls.kill, 1);
  assert.equal(h.calls.errors.length, 1);
  assert.equal(h.calls.errors[0].at, 5000);
  assert.equal(h.agent.exitCode, -1);
});

for (const useConptyDll of [false, true]) check(`backend${useConptyDll} configured15000 timeout disposes and ignores late READY`, () => {
  const h = agentHarness({ connectionTimeout: 15000 }, { useConptyDll });
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

for (const useConptyDll of [false, true]) for (const reason of ["error", "exit0", "exit1"]) check(`backend${useConptyDll} pre-ready worker ${reason} is fatal`, () => {
  const h = agentHarness({ connectionTimeout: 15000 }, { useConptyDll });
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

check("pre-ready DLL kill remains outside connected-close cleanup", () => {
  const h = agentHarness({ connectionTimeout: 15000 });
  h.clock.advance(1000);
  h.agent.kill();
  h.clock.advance(0); // Deliver the input socket's ordinary asynchronous close.
  assert.equal(h.calls.kill, 1);
  assert.equal(h.clock.pending, 0);
  h.workers[0].emit("message", 1);
  h.clock.advance(30000);
  assert.equal(h.calls.connect, 0);
  assert.equal(h.calls.kill, 1);
  assert.equal(h.calls.errors.length, 0);
  assert.equal(h.workers[0].terminations, 0, "no connectSocket means no new close observer; this boundary is unchanged");
  // Simulate already-buffered output so the unchanged DLL drain path runs.
  h.agent.outSocket.emit("data", "inert buffered output");
  h.clock.advance(1000);
  assert.equal(h.workers[0].terminations, 1);
});

for (const useConptyDll of [false, true]) {
  const backend = useConptyDll ? "bundled" : "default";
  for (const nativeExitDelay of [500, 1500]) check(`${backend} output close before native exit at${nativeExitDelay} preserves cleanup`, () => {
    const h = agentHarness(undefined, { throughTerminal: true, useConptyDll });
    h.ready();
    h.output("final output before close");
    h.closeOutput();
    assert.deepEqual(h.calls.events.map(({ kind }) => kind), ["data", "exit"]);
    // This is the existing Terminal contract: close may precede the native
    // status callback. Worker cleanup must not depend on that callback.
    assert.equal(h.calls.events[1].code, undefined);
    if (nativeExitDelay < 1000) {
      h.clock.advance(nativeExitDelay);
      h.nativeExit(12);
      h.clock.advance(999 - nativeExitDelay);
    } else h.clock.advance(999);
    assert.equal(h.workers[0].terminations, 0);
    h.clock.advance(1);
    assert.equal(h.workers[0].terminations, 1);
    assert.equal(h.calls.events.find((event) => event.kind === "terminate").at, 1000);
    if (nativeExitDelay > 1000) {
      h.clock.advance(nativeExitDelay - 1000);
      h.nativeExit(12);
    }
    assert.equal(h.agent.exitCode, 12);
    h.clock.advance(30000);
    assert.equal(h.workers[0].terminations, 1);
    assert.equal(h.calls.events.filter((event) => event.kind === "exit").length, 1);
    assert.equal(h.calls.kill, 0);
    assert.equal(h.calls.connect, 1);
    assert.equal(h.clock.pending, 0);
  });

  check(`${backend} natural close without late output drains worker`, () => {
    const h = agentHarness(undefined, { throughTerminal: true, useConptyDll });
    h.ready();
    h.nativeExit(7);
    assert.equal(h.calls.events.length, 0, "native exit must not itself terminate the worker or emit terminal exit");
    if (useConptyDll) h.closeOutput();
    else {
      h.clock.advance(999);
      assert.equal(h.sockets[0].closed, false, "retain the default backend's pre-close output drain");
      h.clock.advance(1);
    }
    assert.deepEqual(h.calls.events, [{ kind: "exit", code: 7, at: h.clock.now }]);
    const closedAt = h.clock.now;
    h.clock.advance(999);
    assert.equal(h.workers[0].terminations, 0, "output close must retain the existing1000ms worker drain");
    h.clock.advance(1);
    assert.deepEqual(h.calls.events.at(-1), { kind: "terminate", at: closedAt + 1000 });
    assert.equal(h.workers[0].terminations, 1);
    assert.equal(h.calls.kill, 0, "natural close must not issue native kill after exit");
    assert.equal(h.clock.pending, 0);
  });

  check(`${backend} buffered output precedes exit and worker termination`, () => {
    const h = agentHarness(undefined, { throughTerminal: true, useConptyDll });
    h.ready();
    h.output("before exit");
    h.nativeExit(9);
    h.clock.advance(900);
    h.output("final buffered output");
    h.clock.advance(999);
    assert.equal(h.sockets[0].closed, false, "late output must retain the default drain reset");
    assert.equal(h.workers[0].terminations, 0);
    if (useConptyDll) h.closeOutput();
    else h.clock.advance(1);
    assert.deepEqual(h.calls.events.map(({ kind, data, code }) => ({ kind, data, code })), [
      { kind: "data", data: "before exit", code: undefined },
      { kind: "data", data: "final buffered output", code: undefined },
      { kind: "exit", data: undefined, code: 9 },
    ]);
    h.clock.advance(999);
    assert.equal(h.workers[0].terminations, 0);
    h.clock.advance(1);
    assert.equal(h.calls.events.at(-1).kind, "terminate");
    assert.equal(h.workers[0].terminations, 1);
    assert.equal(h.calls.kill, 0);
  });

  check(`${backend} connected kill needs no post-kill output`, () => {
    const h = agentHarness(undefined, { throughTerminal: true, useConptyDll });
    h.ready();
    h.output("ready"); // WindowsTerminal intentionally defers public kill until first data.
    h.terminal.kill();
    assert.equal(h.calls.kill, 1);
    h.nativeExit(0);
    h.closeOutput();
    h.clock.advance(999);
    assert.equal(h.workers[0].terminations, 0);
    h.clock.advance(1);
    assert.equal(h.workers[0].terminations, 1);
    assert.equal(h.calls.events.filter((event) => event.kind === "exit").length, 1);
    assert.equal(h.calls.events.filter((event) => event.kind === "data").length, 1);
    assert.equal(h.calls.kill, 1);
    assert.equal(h.clock.pending, 0);
  });

  check(`${backend} repeated close and worker notifications do not rearm cleanup`, () => {
    const h = agentHarness(undefined, { useConptyDll });
    h.ready();
    h.nativeExit(0);
    h.nativeExit(0);
    h.closeOutput();
    h.clock.advance(500);
    // Deliberately repeat the close at the ConoutConnection boundary. Real
    // net.Socket closes once; the observer must also be consumed once.
    h.sockets[0].emit("close");
    h.workers[0].emit("message", 1);
    h.workers[0].emit("error", new Error("inert post-ready notification"));
    h.workers[0].emit("exit", 0);
    h.clock.advance(500);
    assert.equal(h.workers[0].terminations, 1, "duplicate close must not postpone the original drain deadline");
    h.clock.advance(30000);
    assert.equal(h.workers[0].terminations, 1);
    assert.equal(h.calls.connect, 1);
    assert.equal(h.calls.kill, 0);
    assert.equal(h.calls.errors.length, 0);
    assert.equal(h.clock.pending, 0);
  });

  check(`${backend} kill drain followed by worker-owned close does not dispose twice`, () => {
    const h = agentHarness(undefined, { throughTerminal: true, useConptyDll, closeOnTerminate: true });
    h.ready();
    h.output("ready");
    h.terminal.kill();
    h.nativeExit(0);
    h.output("buffered after kill");
    h.clock.advance(999);
    assert.equal(h.workers[0].terminations, 0);
    h.clock.advance(1);
    assert.equal(h.workers[0].terminations, 1);
    assert.equal(h.calls.events.filter((event) => event.kind === "exit").length, 1);
    assert.equal(h.sockets[0].closed, true);
    h.clock.advance(30000);
    assert.equal(h.workers[0].terminations, 1, "worker shutdown closing its relay must not schedule another termination");
    assert.equal(h.calls.kill, 1);
    assert.equal(h.clock.pending, 0);
  });

  check(`${backend} connected native failure keeps readiness cleanup`, () => {
    const h = agentHarness(undefined, { throughTerminal: true, useConptyDll,
      connectError: new Error("inert connect failure, error code: 87") });
    h.ready();
    assert.equal(h.calls.connect, 1);
    assert.equal(h.calls.kill, 1);
    assert.ok(h.sockets.every((socket) => socket.destroyed));
    assert.deepEqual(h.calls.events, [{ kind: "exit", code: 87, at: 0 }]);
    h.workers[0].emit("message", 1);
    h.clock.advance(1000);
    assert.equal(h.workers[0].terminations, 1);
    h.clock.advance(30000);
    assert.equal(h.calls.connect, 1);
    assert.equal(h.calls.kill, 1);
    assert.equal(h.calls.events.filter((event) => event.kind === "exit").length, 1);
    assert.equal(h.clock.pending, 0);
  });
}

for (const killAt of [1500, 2500]) check(`default natural close then agent kill at${killAt} retains original disposal`, () => {
  const h = agentHarness(undefined, { throughTerminal: true, useConptyDll: false });
  h.ready();
  h.nativeExit(0);
  h.clock.advance(1000);
  assert.equal(h.sockets[0].closed, true);
  assert.equal(h.workers[0].terminations, 0);
  h.clock.advance(killAt - 1000);
  h.agent.kill(); // Native boundary stays mocked; this is a disposal-state regression.
  h.clock.advance(0);
  if (killAt < 2000) {
    h.clock.advance(1999 - killAt);
    assert.equal(h.workers[0].terminations, 0);
    h.clock.advance(1);
  }
  assert.equal(h.workers[0].terminations, 1);
  assert.equal(h.calls.events.find((event) => event.kind === "terminate").at, 2000,
    "later kill must not replace the original dispose deadline with a bespoke timer");
  h.clock.advance(30000);
  assert.equal(h.workers[0].terminations, 1);
  assert.equal(h.calls.events.filter((event) => event.kind === "exit").length, 1);
  assert.equal(h.clock.pending, 0);
});

const conoutPatch = spec.patches.find((patch) => patch.path === "lib/windowsConoutConnection.js");
const beforeConout = reconstructBefore(conoutPatch, Buffer.from(sources.windowsConoutConnection)).toString("utf8");
assert.equal(sha256(beforeConout), originalConoutHash, "negative control must be the published compiled Conout preimage");
for (const useConptyDll of [false, true]) check(`backend${useConptyDll} original Conout negative control retains inert worker`, () => {
  const h = agentHarness(undefined, { throughTerminal: true, useConptyDll, beforeConout });
  h.ready();
  h.nativeExit(0);
  if (useConptyDll) h.closeOutput();
  h.clock.advance(30000);
  assert.equal(h.sockets[0].closed, true);
  assert.equal(h.calls.events.filter((event) => event.kind === "exit").length, 1);
  assert.equal(h.workers[0].terminations, 0, "unpatched natural close must expose the missing termination request");
  assert.equal(h.calls.kill, 0);
  assert.equal(h.calls.connect, 1);
  assert.equal(h.clock.pending, 0);
});

check("bundled kill retains repeated-data drain reset before output close", () => {
  const h = agentHarness(undefined, { throughTerminal: true, useConptyDll: true, closeOnTerminate: true });
  h.ready();
  h.output("ready");
  h.terminal.kill();
  h.nativeExit(0);
  h.output("first buffered output");
  h.clock.advance(900);
  h.output("last buffered output");
  h.clock.advance(999);
  assert.equal(h.workers[0].terminations, 0, "later data must keep resetting the existing DLL1000ms drain");
  h.clock.advance(1);
  assert.equal(h.workers[0].terminations, 1);
  assert.equal(h.sockets[0].closed, true);
  assert.equal(h.calls.events.find((event) => event.kind === "terminate").at, 1900);
  assert.equal(h.calls.events.filter((event) => event.kind === "data").length, 3);
  assert.equal(h.calls.events.filter((event) => event.kind === "exit").length, 1);
  h.clock.advance(30000);
  assert.equal(h.workers[0].terminations, 1);
  assert.equal(h.calls.kill, 1);
  assert.equal(h.clock.pending, 0);
});

check("install guards idempotence tamper and partial known state", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rail-node-pty-install-guard-"));
  const canonicalRoot = fs.realpathSync(fixtureRoot);
  const beforeBytes = new Map(spec.patches.map((patch) => {
    let bytes = fs.readFileSync(path.join(packageRoot, patch.path));
    if (sha256(bytes) === patch.sha256After) {
      bytes = reconstructBefore(patch, bytes);
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
  const identity = (directory, relative) => {
    const file = path.join(directory, relative);
    const stat = fs.lstatSync(file, { bigint: true });
    assert.ok(stat.isFile() && stat.ino > 0n, "migration evidence requires ordinary file identity");
    return { path: relative, sha256: sha256(fs.readFileSync(file)),
      ...Object.fromEntries(["dev", "ino", "mode", "nlink", "size", "birthtimeNs", "mtimeNs", "ctimeNs"]
        .map((key) => [key, stat[key].toString()])) };
  };
  const noStaging = (directory) => {
    const residues = [directory, path.join(directory, "lib"), path.join(directory, "typings")]
      .flatMap((folder) => fs.readdirSync(folder).filter((name) => name.includes(".readiness-") && name.endsWith(".tmp")));
    assert.deepEqual(residues, [], "compatibility staging files must not remain");
  };
  try {
    const pristine = makePackage("pristine");
    assert.throws(() => verifyNodePtyFix({ packageRoot: pristine }), (error) => error.code === "EPTYCOMPAT");
    installerEvidence.pristineWrites = applyNodePtyFix({ packageRoot: pristine }).appliedFiles;
    assert.equal(installerEvidence.pristineWrites, 4);
    assert.equal(verifyNodePtyFix({ packageRoot: pristine }).verifiedFiles.length, 4);
    assert.deepEqual(hashes(pristine), spec.patches.map((patch) => patch.sha256After));
    const installed = hashes(pristine);
    installerEvidence.combinedWrites = applyNodePtyFix({ packageRoot: pristine }).appliedFiles;
    assert.equal(installerEvidence.combinedWrites, 0);
    assert.deepEqual(hashes(pristine), installed);
    noStaging(pristine);

    const readinessOnly = makePackage("previous-readiness-install");
    for (const patch of historicalReadiness) {
      fs.copyFileSync(path.join(pristine, patch.path), path.join(readinessOnly, patch.path));
    }
    const oldIdentities = historicalReadiness.map(({ path }) => identity(readinessOnly, path));
    assert.deepEqual(oldIdentities.map(({ sha256 }) => sha256), historicalReadiness.map(({ sha256After }) => sha256After));
    assert.throws(() => verifyNodePtyFix({ packageRoot: readinessOnly }), (error) => error.code === "EPTYCOMPAT");
    installerEvidence.readinessUpgradeWrites = applyNodePtyFix({ packageRoot: readinessOnly }).appliedFiles;
    assert.equal(installerEvidence.readinessUpgradeWrites, 1, "old readiness postimages upgrade without rewriting");
    const unchangedIdentities = historicalReadiness.map(({ path }) => identity(readinessOnly, path));
    assert.deepEqual(unchangedIdentities, oldIdentities, "one-write upgrade must preserve all three existing file identities and metadata");
    installerEvidence.unchangedReadinessFiles = unchangedIdentities;
    assert.deepEqual(hashes(readinessOnly), installed);
    assert.equal(applyNodePtyFix({ packageRoot: readinessOnly }).appliedFiles, 0);
    noStaging(readinessOnly);

    const tamperedReadiness = makePackage("previous-readiness-tampered-conout");
    for (const patch of historicalReadiness) {
      fs.copyFileSync(path.join(pristine, patch.path), path.join(tamperedReadiness, patch.path));
    }
    fs.appendFileSync(path.join(tamperedReadiness, conoutPatch.path), "\n// unknown Conout fixture bytes\n");
    const tamperedIdentities = spec.patches.map(({ path }) => identity(tamperedReadiness, path));
    assert.throws(() => applyNodePtyFix({ packageRoot: tamperedReadiness }), (error) => error.code === "EPTYCOMPAT");
    assert.deepEqual(spec.patches.map(({ path }) => identity(tamperedReadiness, path)), tamperedIdentities,
      "readiness-only plus unknown Conout must refuse before any target or identity changes");
    noStaging(tamperedReadiness);
    installerEvidence.tamperedReadinessRefusedWithZeroChanges = true;

    const tampered = makePackage("tampered-last-target");
    fs.appendFileSync(path.join(tampered, spec.patches.at(-1).path), "\n// unknown fixture modification\n");
    const tamperedBefore = hashes(tampered);
    assert.throws(() => applyNodePtyFix({ packageRoot: tampered }), (error) => error.code === "EPTYCOMPAT");
    assert.deepEqual(hashes(tampered), tamperedBefore, "all targets must preflight before the first write");
    noStaging(tampered);

    const wrongVersion = makePackage("unsupported-version");
    fs.writeFileSync(path.join(wrongVersion, "package.json"), JSON.stringify({ name: spec.package, version: "0.0.0" }));
    const unsupportedBefore = hashes(wrongVersion);
    assert.throws(() => applyNodePtyFix({ packageRoot: wrongVersion }), (error) => error.code === "EPTYCOMPAT");
    assert.deepEqual(hashes(wrongVersion), unsupportedBefore);
    noStaging(wrongVersion);

    const interrupted = makePackage("known-partial-install");
    fs.copyFileSync(path.join(pristine, spec.patches[0].path), path.join(interrupted, spec.patches[0].path));
    assert.equal(applyNodePtyFix({ packageRoot: interrupted }).appliedFiles, 3);
    assert.deepEqual(hashes(interrupted), installed);
    noStaging(interrupted);
    installerEvidence.noStagingResidue = true;
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
  sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, text]) => [name, sha256(text)])),
  negativeControlSourceHash: sha256(beforeConout), installerEvidence, results }));
if (failures.length) throw new AggregateError(failures, "node-pty startup compatibility checks failed");
console.log("node-pty-startup ok");
