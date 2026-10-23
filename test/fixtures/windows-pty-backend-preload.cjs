"use strict";

// Armed only in this test's dedicated broker. Fake CLI children inherit the
// preload but must not acquire its interception or receipt-writing authority.
const path = require("node:path");
const brokerScript = path.resolve(__dirname, "../../src/windows-broker.js");
if (process.env.NODE_ENV === "test" &&
    path.resolve(process.argv[1] || ".").toLowerCase() === brokerScript.toLowerCase() &&
    process.env.RAIL_CONNECTOR_TEST_PTY_BACKEND_RECEIPT) {
  const fs = require("node:fs");
  const childProcess = require("node:child_process");
  const { syncBuiltinESMExports } = require("node:module");
  const stateDir = fs.realpathSync(process.env.RAIL_CONNECTOR_STATE_DIR);
  const receipt = path.resolve(process.env.RAIL_CONNECTOR_TEST_PTY_BACKEND_RECEIPT);
  if (path.dirname(receipt).toLowerCase() !== stateDir.toLowerCase() ||
      path.basename(receipt) !== "pty-backend-events.jsonl") {
    throw new Error("PTY backend test receipt must belong to its dedicated state directory");
  }
  const agent = require.resolve(path.join(path.dirname(require.resolve("node-pty")), "conpty_console_list_agent"));
  const record = (kind, detail = {}) => fs.appendFileSync(receipt, JSON.stringify({
    version: 1, kind, at: new Date().toISOString(), brokerPid: process.pid, ...detail,
  }) + "\n");
  record("preload-armed");
  const originalFork = childProcess.fork;
  childProcess.fork = function (modulePath, ...arguments_) {
    let resolved;
    try { resolved = require.resolve(modulePath); } catch { /* Unrelated fork: preserve normal behavior. */ }
    if (resolved?.toLowerCase() === agent.toLowerCase()) {
      record("forbidden-console-list-fork", { blockedBeforeLaunch: true });
      const error = new Error("Legacy console-list helper was blocked before launch");
      error.code = "EPTESTCONSOLELIST";
      throw error;
    }
    return Reflect.apply(originalFork, this, [modulePath, ...arguments_]);
  };
  syncBuiltinESMExports();

  // Synthetic cases replace only the public spawn export in this already
  // armed broker. Their positive PID is metadata only, never an OS target.
  const pty = require("node-pty");
  const originalSpawn = pty.spawn;
  const modes = new Set(["delayed-pid", "exit-before-pid", "no-data-timeout", "spawn-error"]);
  pty.spawn = function (file, args, options) {
    const mode = options?.env?.RAIL_CONNECTOR_TEST_PTY_BACKEND_MODE;
    if (!mode) return Reflect.apply(originalSpawn, this, [file, args, options]);
    if (!modes.has(mode) || options.env.NODE_ENV !== "test" ||
        options.env.RAIL_CONNECTOR_TEST_PTY_BACKEND_RECEIPT !== receipt) {
      throw new Error("Invalid inert PTY test selection");
    }
    record("inert-spawn", { mode, initialPid: 0, synthetic: true });
    if (mode === "spawn-error") {
      const error = new Error("Synthetic bundled PTY spawn failure");
      error.code = "EPTESTPTYSPAWN";
      throw error;
    }
    const dataListeners = new Set();
    const exitListeners = new Set();
    const errorListeners = new Set();
    let pid = 0;
    let closed = false;
    let kills = 0;
    const subscribe = (listeners, listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    };
    const emitExit = (exitCode) => {
      if (closed) return;
      closed = true;
      record("inert-exit", { mode, syntheticPid: pid, exitCode, synthetic: true });
      for (const listener of exitListeners) listener({ exitCode });
    };
    const mock = {
      get pid() { return pid; },
      _agent: { inSocket: {
        on(event, listener) {
          if (event !== "error") throw new Error("Unsupported inert input socket event");
          errorListeners.add(listener);
        },
        write() {}, destroy() {},
      } },
      on(event, listener) {
        if (event !== "error") throw new Error("Unsupported inert PTY event");
        errorListeners.add(listener);
        return this;
      },
      onData: (listener) => subscribe(dataListeners, listener),
      onExit: (listener) => subscribe(exitListeners, listener),
      write: (data) => record("inert-write", { mode, characters: String(data).length, synthetic: true }),
      kill() {
        kills++;
        record("inert-kill", { mode, call: kills, synthetic: true });
        // Model a deferred initial cancellation without inventing exit proof.
        // An exact recovery stop can then settle this entirely inert object.
        if (mode !== "no-data-timeout" || kills > 1) setImmediate(() => emitExit(0));
      },
      resize() {}, clear() {}, pause() {}, resume() {},
    };
    if (mode === "delayed-pid") setImmediate(() => {
      if (closed) return;
      pid = 101;
      record("inert-data", { mode, syntheticPid: pid, synthetic: true });
      for (const listener of dataListeners) listener("Inert PTY ready\r\n");
    });
    if (mode === "exit-before-pid") setImmediate(() => emitExit(23));
    return mock;
  };
}
