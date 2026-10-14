import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

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

function createCapabilityProbeFixture() {
  const root = path.join(testRoot, "active-probes");
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

try {
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
  for (const fixture of ownedProbeFixtures) fixture.release();
  await cleanupOwnedChildren();
  for (const fixture of ownedProbeFixtures) await assertProbeExtinction(fixture);
  assertOwnedTemporaryRoot(testRoot);
  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
