import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createLifecycleTransport, requestDelay, withSessionOperationLock } from "../src/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const TEMP_PREFIX = "rail-stdio-lifecycle-";
const EXIT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
const ownedChildren = new Set();
const ownedProbeFixtures = new Set();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const childDescription = (server) => `${server.label} (pid ${server.child.pid ?? "unknown"})`;
const childExited = (child) =>
  child.pid === undefined || child.exitCode !== null || child.signalCode !== null;

function assertOwnedTemporaryRoot(target) {
  assert.equal(path.dirname(path.resolve(target)), path.resolve(os.tmpdir()), "test cleanup must remain inside the system temp directory");
  assert.equal(path.basename(path.resolve(target)).startsWith(TEMP_PREFIX), true, "test cleanup must target this test's directory");
}

function createServer(label, envOverrides = {}) {
  const isolatedRoot = path.join(testRoot, label);
  const stateDir = path.join(isolatedRoot, "state");
  const configDir = path.join(isolatedRoot, "claude-config");
  fs.mkdirSync(isolatedRoot, { recursive: true });

  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS: "",
      RAIL_CONNECTOR_STATE_DIR: stateDir,
      CLAUDE_CONFIG_DIR: configDir,
      RAIL_CONNECTOR_ALLOWED_ROOTS: isolatedRoot,
      ...envOverrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  ownedChildren.add(child);

  let stderrText = "";
  const pending = new Map();
  let stdoutBuffer = "";
  let nextRequestId = 1;
  let exited = false;
  let exitDetails = null;
  let spawnError = null;

  const rejectPending = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  const server = {
    label,
    child,
    closeInput() {
      assert.ok(child.stdin, `${childDescription(server)} must expose stdin`);
      child.stdin.end();
    },
    closeInputCompletely() {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          child.stdin.off("close", onClose);
          child.stdin.off("error", onError);
        };
        const onClose = () => { cleanup(); resolve(); };
        const onError = (error) => { cleanup(); reject(error); };
        const timer = setTimeout(() => onError(new Error("owned stdin pipe did not close")), EXIT_TIMEOUT_MS);
        child.stdin.once("close", onClose);
        child.stdin.once("error", onError);
        // Flush the request, then close this parent's write handle. Keep the
        // child's stdout/stderr readers open to observe response drain.
        child.stdin.end(() => child.stdin.destroy());
      });
    },
    request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
      assert.equal(spawnError, null, `${childDescription(server)} could not start: ${spawnError?.message}`);
      assert.equal(exited, false, `${childDescription(server)} exited before ${method}`);
      assert.ok(child.stdin, `${childDescription(server)} must expose stdin`);
      const id = nextRequestId++;
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${childDescription(server)} timed out waiting for ${method}; stderr: ${stderrText}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(payload, (error) => {
          if (!error) return;
          const entry = pending.get(id);
          if (!entry) return;
          clearTimeout(entry.timer);
          pending.delete(id);
          reject(error);
        });
      });
    },
    notify(method, params = {}) {
      assert.equal(exited, false, `${childDescription(server)} exited before ${method}`);
      assert.ok(child.stdin, `${childDescription(server)} must expose stdin`);
      const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
      return new Promise((resolve, reject) => {
        child.stdin.write(payload, (error) => (error ? reject(error) : resolve()));
      });
    },
    async initializeAndListTools() {
      const initialized = await server.request("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "rail-stdio-lifecycle-test", version: "1.0.0" },
      });
      assert.equal(initialized.error, undefined, `${childDescription(server)} rejected initialize`);
      assert.equal(initialized.result?.protocolVersion, LATEST_PROTOCOL_VERSION);
      await server.notify("notifications/initialized");
      await server.assertListsTools();
    },
    async assertListsTools() {
      const tools = await server.request("tools/list");
      assert.equal(tools.error, undefined, `${childDescription(server)} rejected tools/list`);
      assert.equal(tools.result?.tools?.some((tool) => tool.name === "status"), true, `${childDescription(server)} must remain able to list tools`);
    },
    waitForExit(timeoutMs = EXIT_TIMEOUT_MS) {
      if (exited) return Promise.resolve(exitDetails);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.off("exit", onExit);
          reject(new Error(`${childDescription(server)} did not exit within ${timeoutMs}ms; stderr: ${stderrText}`));
        }, timeoutMs);
        const onExit = (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        };
        child.once("exit", onExit);
      });
    },
    assertAlive() {
      assert.equal(spawnError, null, `${childDescription(server)} could not start: ${spawnError?.message}`);
      assert.equal(exited, false, `${childDescription(server)} must stay alive while stdin remains open`);
      assert.equal(child.exitCode, null, `${childDescription(server)} must not have an exit code while stdin remains open`);
    },
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        rejectPending(new Error(`${childDescription(server)} emitted invalid JSON-RPC: ${error.message}`));
        continue;
      }
      if (!Object.hasOwn(message, "id")) continue;
      const entry = pending.get(message.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      entry.resolve(message);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrText = (stderrText + chunk.toString("utf8")).slice(-16 * 1024);
  });
  child.stdin.on("error", rejectPending);
  child.once("error", (error) => {
    spawnError = error;
    rejectPending(error);
  });
  child.once("exit", (code, signal) => {
    exited = true;
    exitDetails = { code, signal };
  });
  // Process exit can precede the last stdout data event. Reject unanswered
  // requests only after stdio closes so a drained final response is accepted.
  child.once("close", (code, signal) => {
    rejectPending(
      new Error(`${childDescription(server)} exited before its response (code ${code}, signal ${signal ?? "none"}); stderr: ${stderrText}`)
    );
  });

  return server;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function waitUntil(predicate, description, timeoutMs = EXIT_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, description);
    await delay(25);
  }
}

function createCapabilityProbeFixture(label = "active-probes", { failVersionEarly = false } = {}) {
  const root = path.join(testRoot, label);
  fs.mkdirSync(root);
  const release = path.join(root, "release");
  const script = path.join(root, "fake-cli.mjs");
  const wrapper = path.join(root, process.platform === "win32" ? "claude.cmd" : "claude");
  fs.writeFileSync(script, `
import fs from "node:fs";
import path from "node:path";
const root = ${JSON.stringify(root)};
const release = ${JSON.stringify(release)};
const args = process.argv.slice(2);
const kind = args.includes("--effort=rail-invalid-probe") ? "invalid-control"
  : args.includes("--effort=ultracode") ? "ultracode"
  : args.includes("--help") ? "help" : "version";
const record = { kind, pid: process.pid, parentPid: process.ppid };
const started = path.join(root, kind + "-" + process.pid + ".started.json");
const temporary = started + ".tmp";
fs.writeFileSync(temporary, JSON.stringify(record));
fs.renameSync(temporary, started);
if (kind === "version" && ${failVersionEarly}) {
  fs.writeFileSync(path.join(root, kind + "-" + process.pid + ".completed.json"), JSON.stringify(record));
  console.error("synthetic immediate version failure");
  process.exitCode = 42;
} else {
const deadline = setTimeout(() => {
  clearInterval(poll);
  process.exitCode = 86;
  console.error("owned fake CLI barrier expired");
}, 8000);
const poll = setInterval(() => {
  if (!fs.existsSync(release)) return;
  clearInterval(poll);
  clearTimeout(deadline);
  fs.writeFileSync(path.join(root, kind + "-" + process.pid + ".completed.json"), JSON.stringify(record));
  if (kind === "invalid-control") {
    process.exitCode = 64;
    console.error("Unknown --effort value 'rail-invalid-probe'");
  } else if (kind === "help") {
    console.log("Usage: claude [options]\\n  --effort <level> (low, medium, high, xhigh, max)\\n  --permission-mode <mode> (choices: default, dontAsk)\\n  --remote-control [name]");
  } else {
    console.log("2.1.234 (stdio lifecycle fixture)");
  }
}, 25);
}
`);
  if (process.platform === "win32") {
    fs.writeFileSync(wrapper, ["@echo off", `"${process.execPath}" "${script}" %*`, "exit /b %ERRORLEVEL%", ""].join("\r\n"));
  } else {
    const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  }
  const fixture = {
    root,
    wrapper,
    serverPid: null,
    release() { fs.writeFileSync(release, "release owned probes\n"); },
    records() {
      return fs.readdirSync(root).filter((name) => name.endsWith(".started.json"))
        .map((name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")));
    },
    completedCount() { return fs.readdirSync(root).filter((name) => name.endsWith(".completed.json")).length; },
    processIds() {
      return [...new Set(fixture.records().flatMap(({ pid, parentPid }) => {
        assert.ok(Number.isInteger(pid) && pid > 1, "fake probe must record a valid PID");
        // Windows .cmd launchers are owned synchronous parents of the fake
        // Node probes. Unix launchers use exec, so the MCP is their parent.
        const wrapperPid = process.platform === "win32" && parentPid !== fixture.serverPid
          && parentPid !== process.pid && Number.isInteger(parentPid) && parentPid > 1;
        return wrapperPid ? [pid, parentPid] : [pid];
      }))];
    },
  };
  ownedProbeFixtures.add(fixture);
  return fixture;
}

async function assertProbeExtinction(fixture) {
  // Signal 0 only checks existence; PID reuse can cause a safe false failure.
  // No PID-based termination is used for these grandchildren or wrappers.
  await waitUntil(() => fixture.processIds().every((pid) => !processExists(pid)),
    "owned fake capability probes and wrappers must exit naturally");
}

async function assertActiveRequestDrainAfterEof() {
  const fixture = createCapabilityProbeFixture();
  const server = createServer("active-request", { RAIL_CONNECTOR_CLAUDE_PATH: fixture.wrapper });
  fixture.serverPid = server.child.pid;
  await server.initializeAndListTools();
  let requestSettled = false;
  const response = server.request("tools/call", { name: "get_claude_capabilities", arguments: {} }, 15_000)
    .then((value) => { requestSettled = true; return { value }; },
      (error) => { requestSettled = true; return { error }; });
  await waitUntil(() => fixture.records().length === 4, "all four capability probes must start");
  assert.deepEqual(fixture.records().map(({ kind }) => kind).sort(), ["help", "invalid-control", "ultracode", "version"]);
  assert.equal(fixture.processIds().every(processExists), true, "all owned probe processes must still be running");
  assert.equal(fixture.completedCount(), 0, "probes must be held before stdin closure");
  assert.equal(requestSettled, false, "tool request must be in flight before stdin closure");
  server.assertAlive();

  await server.closeInputCompletely();
  assert.equal(fixture.completedCount(), 0, "stdin must close before any probe completes");
  assert.equal(requestSettled, false, "request must remain pending at client stdin closure");
  server.assertAlive();
  const exit = server.waitForExit();
  fixture.release();
  const [outcome, details] = await Promise.all([response, exit]);
  assert.equal(outcome.error, undefined, outcome.error?.message);
  assert.equal(outcome.value.error, undefined, "active tool must drain a JSON-RPC response");
  assert.equal(outcome.value.result?.isError, undefined, "capability probe tool must succeed");
  const capabilities = JSON.parse(outcome.value.result.content[0].text);
  assert.equal(capabilities.available, true);
  assert.equal(capabilities.version, "2.1.234 (stdio lifecycle fixture)");
  assert.equal(details.code, 0, "active server must exit successfully after drain");
  assert.equal(details.signal, null, "active server must exit naturally after drain");
  assert.equal(fixture.completedCount(), 4, "all probes must finish after release");
  await assertProbeExtinction(fixture);
  console.log("stdio lifecycle active capability request EOF drain ok");
}

async function assertNaturalExitAfterEof(server) {
  server.closeInput();
  const exit = await server.waitForExit();
  assert.equal(exit.signal, null, `${childDescription(server)} must exit naturally after stdin EOF`);
  assert.equal(exit.code, 0, `${childDescription(server)} must exit successfully after stdin EOF`);
}

async function cleanupOwnedChildren() {
  for (const child of ownedChildren) {
    if (childExited(child)) continue;
    try {
      child.kill();
    } catch {
      // A just-exited owned child needs no further action.
    }
  }
  const waitForOwnedExits = () => Promise.race([
    Promise.all([...ownedChildren].filter((child) => !childExited(child)).map((child) => new Promise((resolve) => child.once("exit", resolve)))),
    delay(1000),
  ]);
  await waitForOwnedExits();
  for (const child of ownedChildren) {
    if (childExited(child)) continue;
    try {
      child.kill("SIGKILL");
    } catch {
      // A just-exited owned child needs no further action.
    }
  }
  await waitForOwnedExits();
  assert.equal([...ownedChildren].every(childExited), true, "owned test children must exit before test cleanup");
}


class FixtureWritable extends EventEmitter {
  constructor() { super(); this.messages = []; this.mode = "normal"; this.held = []; }
  write(bytes, callback) {
    this.messages.push(JSON.parse(bytes));
    if (this.mode === "throw") throw new Error("synthetic write throw");
    if (this.mode === "error") { queueMicrotask(() => this.emit("error", new Error("synthetic output error"))); return false; }
    if (this.mode === "close") { queueMicrotask(() => this.emit("close")); return false; }
    if (this.mode === "never" || this.mode === "backpressure") { this.held.push(callback); return false; }
    if (this.mode === "sync") { callback(); return true; }
    queueMicrotask(() => callback());
    return true;
  }
  release() { for (const callback of this.held.splice(0)) callback(); this.emit("drain"); }
}
const ownedHarnesses = new Set();
const frame = (message) => JSON.stringify(message) + "\n";
const toolRequest = (id, key = "wait") => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "fixture", arguments: { key } } });
const cancellation = (requestId) => ({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } });
function fixtureGate() { let release; const promise = new Promise((done) => { release = done; }); return { promise, release }; }

async function memoryHarness(handler, drainTimeoutMs = 50) {
  const input = new PassThrough();
  const output = new FixtureWritable();
  const transport = createLifecycleTransport({ input, output, drainTimeoutMs });
  const sdk = new McpServer({ name: "cancellation-fixture", version: "1.0.0" });
  const errors = [];
  let closed = false;
  sdk.server.onerror = (error) => errors.push(error.message);
  sdk.server.onclose = () => { closed = true; };
  // No input schema is needed: the SDK still supplies its public extra object.
  sdk.registerTool("fixture", {}, (...args) => transport.runTool(
    () => handler(args.at(-1), { input, output, transport }),
    args, args.at(-1)
  ));
  const harness = { input, output, transport, sdk, errors, get closed() { return closed; },
    write(...messages) { input.write(messages.map(frame).join("")); },
    async close() { await transport.close(); input.destroy(); ownedHarnesses.delete(harness); },
  };
  ownedHarnesses.add(harness);
  await sdk.connect(transport);
  return harness;
}

async function assertCancellationIdentityAndScope() {
  let started = 0;
  let finished = 0;
  const h = await memoryHarness(async () => {
    started++;
    try { await requestDelay(60_000); return { content: [] }; }
    finally { finished++; }
  });
  try {
    // String and numeric IDs occupy distinct keys; empty string and zero are
    // valid IDs. Their cancellation must not depend on the SDK's falsy guard.
    h.write(toolRequest(0), toolRequest(""), toolRequest(1), toolRequest("1"));
    await waitUntil(() => started === 4, "four distinct request identities must start");
    const at = performance.now();
    h.write(cancellation(0), cancellation(""), cancellation(1));
    await waitUntil(() => finished === 3, "only the three selected waits must cancel");
    assert.ok(performance.now() - at < 1000, "read-only wait cancellation must settle within 1s");
    assert.equal(h.transport.pendingRequestCount(), 1, "string1 must remain active");
    h.write(cancellation("unknown"), cancellation("1"));
    await waitUntil(() => h.transport.pendingRequestCount() === 0, "all cancelled contexts must dispose");
    assert.equal(h.output.messages.length, 0, "cancelled IDs, including falsy IDs, must have no response");
    h.write(toolRequest(0), cancellation(0));
    await delay(25);
    assert.equal(started, 4, "same-chunk cancellation must prevent handler work");
    assert.equal(h.transport.pendingRequestCount(), 0);
    h.write(cancellation(0)); // late unknown cancellation retains no tombstone.
    await delay(10);
    assert.equal(h.transport.pendingRequestCount(), 0);
  } finally { await h.close(); }
  console.log("stdio lifecycle typed/falsy/same-chunk cancellation and local scope ok");
}

async function assertCancellationGenerationIsolation() {
  const cases = [
    ["unknown-before-admission", [cancellation("future-id"), toolRequest("future-id")], "future-id"],
    ["cancelled-id-reused-in-chunk", [toolRequest(1), cancellation(1), toolRequest(1)], 1],
    ["typed-generation", [toolRequest(1), cancellation(1), toolRequest("1")], "1"],
    ["zero-reused-in-chunk", [toolRequest(0), cancellation(0), toolRequest(0)], 0],
    ["empty-reused-in-chunk", [toolRequest(""), cancellation(""), toolRequest("")], ""],
  ];
  for (const [label, messages, expectedId] of cases) {
    let started = 0;
    const h = await memoryHarness(async () => {
      started++;
      await requestDelay(5);
      return { content: [{ type: "text", text: "fresh generation" }] };
    });
    try {
      // One parser chunk reaches the actual locked SDK. A deferred SDK lookup
      // must never reinterpret an earlier cancellation as a later generation.
      h.write(...messages);
      await waitUntil(() => h.output.messages.length === 1, label + " must deliver the fresh generation response");
      assert.equal(started, 1, label + " starts only the fresh handler");
      assert.equal(h.output.messages[0].id, expectedId);
      assert.equal(h.output.messages[0].error, undefined);
      await waitUntil(() => h.transport.pendingRequestCount() === 0, label + " must release request contexts");
      h.write(cancellation(expectedId), toolRequest(expectedId));
      await waitUntil(() => h.output.messages.length === 2, label + " late unknown cancellation must not poison reuse");
      assert.equal(started, 2);
      assert.equal(h.output.messages[1].id, expectedId);
      assert.equal(h.output.messages[1].error, undefined);
      await waitUntil(() => h.transport.pendingRequestCount() === 0, label + " reuse must dispose");
    } finally { await h.close(); }
  }
  console.log("stdio lifecycle actual SDK cancellation generation/reuse isolation ok");
}

async function assertDelayedGenerationRetirement() {
  for (const id of [7, "7"]) {
    const cleanup = fixtureGate();
    let started = 0;
    let oldCleanup = false;
    let reused = false;
    const h = await memoryHarness(async () => {
      const ordinal = ++started;
      try { await requestDelay(60_000); return { content: [] }; }
      finally {
        if (ordinal === 1) { oldCleanup = true; await cleanup.promise; }
      }
    });
    // Reuse after app-owned cleanup, but before the actual SDK can retire the
    // old handler promise. This invokes the real runTool and SDK chains; no
    // SDK private map or cancellation implementation is inspected/mirrored.
    const runTool = h.transport.runTool;
    h.transport.runTool = (...args) => runTool(...args).finally(() => {
      if (!reused) { reused = true; h.write(toolRequest(id)); }
    });
    try {
      h.write(toolRequest(id));
      await waitUntil(() => started === 1, "older admitted handler must start");
      h.write(cancellation(id));
      await waitUntil(() => oldCleanup, "old generation cleanup must reach its owned gate");
      assert.equal(h.transport.pendingRequestCount(), 1, "cancellation must retain the old context until finally");
      assert.equal(reused, false);
      cleanup.release();
      await waitUntil(() => started === 2, "fresh generation must start during old SDK retirement");
      await delay(10);
      assert.equal(h.transport.pendingRequestCount(), 1, "old response/finally must not retire the fresh context");
      h.write(cancellation(id));
      await waitUntil(() => h.transport.pendingRequestCount() === 0, "fresh cancellation remains effective after old SDK retirement");
      assert.equal(h.output.messages.length, 0, "both cancelled generations must suppress responses");
    } finally { cleanup.release(); await h.close(); }
  }
  const cleanup = fixtureGate();
  let cleanupStarted = false;
  const duplicate = await memoryHarness(async () => {
    try { await requestDelay(60_000); return { content: [] }; }
    finally { cleanupStarted = true; await cleanup.promise; }
  });
  try {
    duplicate.write(toolRequest("still-owned"));
    await waitUntil(() => duplicate.transport.pendingRequestCount() === 1, "duplicate test first generation must be admitted");
    // Ensure it has entered the handler before cancellation.
    await delay(10);
    duplicate.write(cancellation("still-owned"));
    await waitUntil(() => cleanupStarted, "duplicate first finally must be held");
    duplicate.write(toolRequest("still-owned"));
    await delay(20);
    assert.ok(duplicate.errors.some((error) => /Duplicate/.test(error)));
    assert.equal(duplicate.closed, false, "active duplicate refusal must still await the original finally");
    cleanup.release();
    await waitUntil(() => duplicate.closed, "duplicate cleanup must eventually close");
    assert.equal(duplicate.transport.pendingRequestCount(), 0);
    assert.equal(duplicate.output.messages.length, 0);
  } finally { cleanup.release(); await duplicate.close(); }
  console.log("stdio lifecycle delayed SDK retirement/reuse and duplicate-owned cleanup ok");
}

async function assertDuplicateAndParserClose() {
  const h = await memoryHarness(async () => { await requestDelay(60_000); return { content: [] }; });
  try {
    h.write(toolRequest("duplicate"));
    await waitUntil(() => h.transport.pendingRequestCount() === 1, "first identity must be admitted");
    h.write(toolRequest("duplicate"));
    await waitUntil(() => h.closed, "duplicate identity must close through cleanup");
    assert.equal(h.transport.pendingRequestCount(), 0);
    assert.ok(h.errors.some((error) => /Duplicate/.test(error)));
  } finally { await h.close(); }
  const malformed = await memoryHarness(async () => ({ content: [] }));
  try {
    malformed.input.write("{malformed\n");
    await waitUntil(() => malformed.closed, "parser error must use the cleanup close path");
    assert.equal(malformed.transport.pendingRequestCount(), 0);
  } finally { await malformed.close(); }
  console.log("stdio lifecycle duplicate IDs and malformed parser close ok");
}

async function assertQueuedTombstoneAndCleanupBeforeClose() {
  const first = fixtureGate();
  const release = fixtureGate();
  const entered = [];
  let cleanupStarted = false;
  let cleanupFinished = false;
  const h = await memoryHarness(async () => {
    const ordinal = entered.length;
    entered.push(ordinal);
    return withSessionOperationLock("synthetic-queue", async () => {
      if (ordinal === 0) {
        try { await first.promise; }
        finally { cleanupStarted = true; await release.promise; cleanupFinished = true; }
      } else entered.push("product-" + ordinal);
      return { content: [] };
    });
  });
  try {
    h.write(toolRequest(10));
    await waitUntil(() => entered.length === 1, "first mutation must own the queue");
    h.write(toolRequest(11), toolRequest(12));
    await waitUntil(() => entered.length === 3, "second and third handlers must be queued");
    h.write(cancellation(11));
    first.release();
    await waitUntil(() => cleanupStarted, "first finally must begin");
    await delay(30);
    assert.equal(entered.includes("product-2"), false, "third must not pass cancelled second tombstone");
    h.input.end();
    await delay(30);
    assert.equal(h.closed, false, "EOF must not close before owned release/finally");
    release.release();
    await waitUntil(() => h.closed, "EOF must finish after exact owned cleanup");
    assert.equal(cleanupFinished, true);
    assert.equal(entered.some((value) => typeof value === "string"), false, "EOF prevents both unsent product calls");
    assert.equal(h.transport.pendingRequestCount(), 0);
  } finally { first.release(); release.release(); await h.close(); }
  console.log("stdio lifecycle cancelled queue tombstone and finally-before-close ok");
}

async function assertWritableSettlement() {
  for (const mode of ["sync", "normal", "backpressure", "never", "error", "close", "throw"]) {
    let cleaned = false;
    const h = await memoryHarness(async () => {
      try { return { content: [] }; }
      finally { cleaned = true; }
    }, mode === "backpressure" ? 500 : 40);
    try {
      h.output.mode = mode;
      h.write(toolRequest("write-" + mode));
      await waitUntil(() => h.output.messages.length === 1, mode + " response must reach writable");
      assert.equal(cleaned, true, "operation cleanup must precede output settlement");
      if (mode === "backpressure") {
        h.input.end();
        await delay(10);
        assert.equal(h.closed, false, "EOF must retain admitted response until drain");
        h.output.release();
      } else if (mode === "never") {
        h.input.end();
      } else if (mode === "sync" || mode === "normal") {
        await waitUntil(() => h.transport.pendingRequestCount() === 0, "normal send must settle");
        h.input.end();
      }
      await waitUntil(() => h.closed, mode + " writable must close without unbounded retention");
      assert.equal(h.transport.pendingRequestCount(), 0);
      for (const event of ["drain", "error", "close"]) assert.equal(h.output.listenerCount(event), 0, mode + " leaves no writable listeners");
      assert.equal(h.input.listenerCount("data"), 0);
    } finally { h.output.release(); await h.close(); }
  }
  console.log("stdio lifecycle callback/drain/error/close/deadline settlement ok (injected writable)");
}

async function assertOneCapabilityWaiterCanCancel() {
  const fixture = createCapabilityProbeFixture("shared-probes");
  const server = createServer("shared-capability", { RAIL_CONNECTOR_CLAUDE_PATH: fixture.wrapper });
  fixture.serverPid = server.child.pid;
  await server.initializeAndListTools(); // initialize1, tools/list2.
  const first = server.request("tools/call", { name: "get_claude_capabilities", arguments: {} }, 15_000).catch((error) => ({ cancelledOrClosed: true, error }));
  const second = server.request("tools/call", { name: "get_claude_capabilities", arguments: {} }, 15_000);
  await waitUntil(() => fixture.records().length === 4, "one shared probe group must start");
  await server.notify("notifications/cancelled", { requestId: 3 });
  await delay(25);
  assert.equal(fixture.processIds().every(processExists), true, "one cancelled subscriber must not kill shared probes");
  fixture.release();
  const result = await second;
  assert.equal(result.error, undefined);
  assert.equal(result.result?.isError, undefined);
  assert.equal(fixture.records().length, 4, "the peer must reuse the same shared probe");
  await server.closeInputCompletely();
  const exit = await server.waitForExit();
  assert.equal(exit.code, 0);
  assert.equal((await first).cancelledOrClosed, true, "cancelled subscriber must not receive a late result");
  await assertProbeExtinction(fixture);
  console.log("stdio lifecycle shared capability waiter-local cancellation ok (owned Windows/POSIX child)");
}

async function assertFailedProbeSiblingCleanupAfterEof() {
  const fixture = createCapabilityProbeFixture("failed-version-probes", { failVersionEarly: true });
  const server = createServer("failed-version-capability", { RAIL_CONNECTOR_CLAUDE_PATH: fixture.wrapper });
  fixture.serverPid = server.child.pid;
  await server.initializeAndListTools();
  let settled = false;
  const response = server.request("tools/call", { name: "get_claude_capabilities", arguments: {} }, 15_000)
    .then((value) => { settled = true; return { value }; },
      (error) => { settled = true; return { error }; });
  await waitUntil(() => fixture.records().length === 4 && fixture.completedCount() === 1,
    "version must fail while three sibling probes are gated");
  const versionPid = fixture.records().find(({ kind }) => kind === "version").pid;
  await waitUntil(() => !processExists(versionPid), "failed version process must exit");
  await delay(50);
  assert.equal(settled, false, "one failed probe must not settle shared work before its owned peers");
  await server.closeInputCompletely();
  assert.equal(settled, false, "EOF must retain the admitted capability outcome while peers are gated");
  assert.equal(fixture.completedCount(), 1);
  server.assertAlive();
  fixture.release();
  const [outcome, exit] = await Promise.all([response, server.waitForExit()]);
  assert.equal(outcome.error, undefined, outcome.error?.message);
  assert.equal(outcome.value.error, undefined);
  const capabilities = JSON.parse(outcome.value.result.content[0].text);
  assert.equal(capabilities.available, false);
  assert.match(capabilities.error, /synthetic immediate version failure/);
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null);
  assert.equal(fixture.completedCount(), 4, "all owned probes must finish before cleanup completes");
  await assertProbeExtinction(fixture);
  console.log("stdio lifecycle failed capability probe retains sibling cleanup through EOF ok");
}


try {
  await assertCancellationGenerationIsolation();
  await assertDelayedGenerationRetirement();
  await assertCancellationIdentityAndScope();
  await assertDuplicateAndParserClose();
  await assertQueuedTombstoneAndCleanupBeforeClose();
  await assertWritableSettlement();
  await assertFailedProbeSiblingCleanupAfterEof();
  await assertOneCapabilityWaiterCanCancel();
  const beforeInitialize = createServer("before-initialize");
  await delay(150);
  beforeInitialize.assertAlive();
  await assertNaturalExitAfterEof(beforeInitialize);
  console.log("stdio lifecycle before-initialize EOF ok");

  const initialized = createServer("after-initialize");
  await initialized.initializeAndListTools();
  initialized.assertAlive();
  await assertNaturalExitAfterEof(initialized);
  console.log("stdio lifecycle initialized EOF ok");

  const first = createServer("multiple-first");
  const second = createServer("multiple-second");
  await Promise.all([first.initializeAndListTools(), second.initializeAndListTools()]);
  first.assertAlive();
  second.assertAlive();
  await assertNaturalExitAfterEof(first);
  second.assertAlive();
  await second.assertListsTools();
  await assertNaturalExitAfterEof(second);
  console.log("stdio lifecycle multiple clients ok");

  await assertActiveRequestDrainAfterEof();
} finally {
  for (const harness of [...ownedHarnesses]) await harness.close();
  for (const fixture of ownedProbeFixtures) fixture.release();
  await cleanupOwnedChildren();
  for (const fixture of ownedProbeFixtures) await assertProbeExtinction(fixture);
  assertOwnedTemporaryRoot(testRoot);
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
