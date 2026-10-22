import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

// Evaluate the real handler and its helpers without broker startup, imports,
// sockets, child processes, node-pty, or native fixtures. Timers and renderer
// observations are inert boundaries; the chunk loop and its guards are not copied.
async function framedZeroDelayInertTests() {
  const brokerSource = fs.readFileSync(new URL("../src/windows-broker.js", import.meta.url), "utf8");
  const terminalSource = fs.readFileSync(new URL("../src/terminal.js", import.meta.url), "utf8");
  function sourceRange(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `Missing inert source boundary: ${startMarker}`);
    assert.equal(source.indexOf(startMarker, start + startMarker.length), -1);
    return source.slice(start, end);
  }
  const librarySource = [
    sourceRange(terminalSource, "const TERMINAL_CONTROL_RE =", "function terminalText(").replace(/^export /gm, ""),
    sourceRange(brokerSource, "const MAX_REQUEST_BYTES =", "function argumentValue("),
    sourceRange(brokerSource, "function sleep(ms)", "const server = net.createServer"),
    "({ handleOperation, sessions })",
  ].join("\n");
  function fixture({ firstBodyEffect, framed = true } = {}) {
    const writes = [];
    const sleeps = [];
    const state = { flushes: 0, pendingModeOff: false, bodyObserved: false };
    const context = vm.createContext({
      setTimeout(callback, delay) {
        assert.ok(sleeps.length < 100, "Inert handler exceeded its timer budget");
        sleeps.push(delay);
        queueMicrotask(callback);
      },
    }, { codeGeneration: { strings: false, wasm: false } });
    const { handleOperation, sessions } = new vm.Script(librarySource, {
      filename: "windows-broker-inert-source.js",
    }).runInContext(context, { timeout: 1000 });
    const session = {
      generationId: "inert-framed-zero-generation",
      startedAtMs: 123456,
      exited: false,
      recoveryOnly: false,
      lease: { id: "inert-framed-zero-lease", expiresAt: Date.now() + 60_000 },
      renderer: {
        bracketedPasteMode: framed,
        async flush() {
          state.flushes += 1;
          await Promise.resolve();
          if (state.pendingModeOff) this.bracketedPasteMode = false;
        },
      },
      ptyProcess: {
        write(text) {
          writes.push(text);
          if (!state.bodyObserved && text !== "\x1b[200~") {
            state.bodyObserved = true;
            queueMicrotask(() => firstBodyEffect?.({ session, sessions, state }));
          }
        },
      },
    };
    sessions.set("inert_framed_zero", session);
    return {
      session, writes, sleeps, state,
      send(text, overrides = {}) {
        return handleOperation("sendText", {
          sessionName: "inert_framed_zero",
          requireExactPair: true,
          expectedGenerationId: session.generationId,
          expectedStartedAtMs: session.startedAtMs,
          leaseId: "inert-framed-zero-lease",
          text, bracketedPaste: framed, requireBracketedPaste: framed,
          chunkSize: 256, chunkDelayMs: 0, submit: true,
          ...overrides,
        });
      },
    };
  }
  const cases = [
    ["framed zero-delay observes queued mode loss before later body", async () => {
      const f = fixture({ firstBodyEffect: ({ state }) => { state.pendingModeOff = true; } });
      const text = `${"x".repeat(256)}\nsecond\rthird${"y".repeat(300)}`;
      await assert.rejects(f.send(text), (error) => error.code === "EPASTEMODE");
      assert.deepEqual(f.writes.map((text) => text.length), [6, 256],
        "Mode loss must prevent later body/newlines, closing frame, and Enter");
      assert.deepEqual(f.writes, ["\x1b[200~", text.slice(0, 256)]);
      assert.equal(f.session.recoveryOnly, true);
      assert.deepEqual(f.sleeps, [0]);
      assert.equal(f.state.flushes, 2);
    }],
    ["framed zero-delay preserves Unicode and line endings", async () => {
      const f = fixture();
      const text = `${"x".repeat(255)}🚀\tline\nnext\r${"y".repeat(300)}`;
      const result = await f.send(text);
      assert.equal(result.bracketedPasteUsed, true);
      assert.deepEqual(f.writes, ["\x1b[200~", text.slice(0, 255), text.slice(255, 511), text.slice(511), "\x1b[201~", "\r"]);
      assert.deepEqual(f.sleeps, [0, 0, 100, 400]);
      assert.equal(f.state.flushes, 5);
    }],
    ["unframed zero-delay keeps uninterrupted chunk pacing", async () => {
      const f = fixture({ framed: false });
      const text = "u".repeat(600);
      const result = await f.send(text);
      assert.equal(result.bracketedPasteUsed, false);
      assert.deepEqual(f.writes, [text.slice(0, 256), text.slice(256, 512), text.slice(512), "\r"]);
      assert.deepEqual(f.sleeps, [100, 400]);
      assert.equal(f.state.flushes, 0);
    }],
    ...[
      ["generation", "ESTALE", ({ sessions, session }) => sessions.set("inert_framed_zero", { ...session })],
      ["lease", "ELEASE", ({ session }) => { session.lease = null; }],
      ["exit", null, ({ session }) => { session.exited = true; }],
      ["terminal fault", "ERECOVERY", ({ session }) => { session.terminalErrorCode = "EIO"; }],
    ].map(([name, code, firstBodyEffect]) => [
      `framed zero-delay rechecks ${name} after yielding`, async () => {
        const f = fixture({ firstBodyEffect });
        const text = "g".repeat(600);
        await assert.rejects(f.send(text), (error) => code
          ? error.code === code
          : /Managed native Windows Claude session has exited: inert_framed_zero/.test(error.message));
        assert.deepEqual(f.writes, ["\x1b[200~", text.slice(0, 256)]);
        assert.deepEqual(f.sleeps, [0]);
        assert.equal(f.state.flushes, 1);
      },
    ]),
  ];
  const failures = [];
  for (const [name, test] of cases) {
    try {
      await test();
      console.log(`windows-broker inert PASS: ${name}`);
    } catch (error) {
      console.error(`windows-broker inert FAIL: ${name}\n${error.stack}`);
      failures.push(error);
    }
  }
  assert.equal(failures.length, 0, `${failures.length} framed zero-delay inert regression(s) failed`);
  console.log(`windows-broker inert: ${cases.length} actual-handler cases passed; no native boundaries`);
}

await framedZeroDelayInertTests();
if (process.argv.includes("--framed-zero-inert-only")) process.exit(0);

const { createFixtureProcessLedger, inspectFixtureProcess,
  readFixtureProcessRecords } = await import("./fixtures/fixture-process-ledger.mjs");
const {
  WINDOWS_BROKER_VERSION,
  probeWindowsBroker,
  windowsBrokerLaunchPolicyFingerprint,
  windowsBrokerPaths,
  windowsBrokerCleanupRequest,
  windowsBrokerRequest,
} = await import("../src/windows-broker-client.js");

await import("./fixture-process-ledger.mjs");

if (process.platform !== "win32") {
  console.log("windows-broker skipped on non-Windows");
  process.exit(0);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const canonicalRepoRoot =
  fs.realpathSync.native?.(repoRoot) ?? fs.realpathSync(repoRoot);
const fixture = path.join(repoRoot, "test", "fixtures", "fake-claude-tui.mjs");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-connector-broker-"));
console.log(`windows-broker owned state ${stateDir}`);
const fixtureLedger = await createFixtureProcessLedger({ directory: path.join(stateDir, "fixture-processes"), fixturePath: fixture });
const fixtureLedgers = new Set([fixtureLedger]);
const previousFixtureEnvironment = Object.fromEntries(Object.keys(fixtureLedger.environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, fixtureLedger.environment);
let primaryError = null;
const previousStateDir = process.env.RAIL_CONNECTOR_STATE_DIR;
const previousClaudePath = process.env.RAIL_CONNECTOR_CLAUDE_PATH;
process.env.RAIL_CONNECTOR_STATE_DIR = stateDir;
process.env.RAIL_CONNECTOR_CLAUDE_PATH = process.execPath;
// Node 20 puts a Windows console in plain raw mode, so the fake terminal (a
// Node program) never sees bracketed-paste markers; Node 22 and later use
// UV_TTY_MODE_RAW_VT. On Node below 22 the keyword checks that need the
// markers verify the broker's exact PTY writes instead (a test-only recorder
// loaded into the broker), plus the end-to-end facts that terminal can show.
const fakeTerminalSeesPasteMarkers = Number(process.versions.node.split(".")[0]) >= 22;
const previousNodeOptions = process.env.NODE_OPTIONS;
const previousNodeEnv = process.env.NODE_ENV;
const previousBrokerErrorDir = process.env.RAIL_TEST_BROKER_ERROR_DIR;
process.env.NODE_ENV = "test";
process.env.RAIL_TEST_BROKER_ERROR_DIR = stateDir;
const errorPreload = pathToFileURL(path.join(repoRoot, "test", "fixtures", "broker-error-injection.mjs"));
process.env.NODE_OPTIONS = [previousNodeOptions, `--import=${errorPreload.href}`].filter(Boolean).join(" ");
const ptyWriteReceipt = path.join(stateDir, "pty-writes.jsonl");
if (!fakeTerminalSeesPasteMarkers) {
  const recorder = pathToFileURL(path.join(repoRoot, "test", "fixtures", "pty-write-recorder-loader.mjs"));
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${recorder.href}`].filter(Boolean).join(" ");
  process.env.RAIL_TEST_PTY_WRITE_RECEIPT = ptyWriteReceipt;
  console.log(`windows-broker: Node ${process.versions.node} fake terminal cannot see paste markers; keyword framing is verified at the broker's PTY writes`);
}
async function brokerPtyWrites(name) {
  const session = (await probeWindowsBroker())?.managedSessions?.find((item) => item.name === name);
  assert.ok(session?.pid, `missing broker session ${name}`);
  if (!fs.existsSync(ptyWriteReceipt)) return [];
  return fs.readFileSync(ptyWriteReceipt, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line)).filter((entry) => entry.pid === session.pid).map((entry) => entry.data);
}
const sessionName = `broker_test_${process.pid}`;
const tokenA = "a".repeat(64);
const tokenB = "b".repeat(64);
const launchEnvironment = {
  status: "blocking",
  evidenceScope: "claude_child_launch_environment",
  effortOverrideStatus: "blocking_non_xhigh",
  workflowsDisabled: true,
  blockers: ["workflows_disabled", "non_xhigh_effort_override"],
  note: "This caller-provided note must not be trusted.",
  rawValue: "private-launch-value-must-not-persist",
};
const pipeA = windowsBrokerPaths(
  { ...process.env, RAIL_CONNECTOR_STATE_DIR: stateDir },
  tokenA
).pipeName;
const pipeB = windowsBrokerPaths(
  { ...process.env, RAIL_CONNECTOR_STATE_DIR: stateDir },
  tokenB
).pipeName;
assert.notEqual(pipeA, pipeB);
assert.equal(pipeA.includes(tokenA), false);
assert.equal(pipeB.includes(tokenB), false);

let activeGenerationId = "";
async function waitForCapture(pattern) {
  const deadline = Date.now() + 10000;
  let capture = "";
  while (Date.now() < deadline) {
    capture = (
      await windowsBrokerRequest(
        "capture",
        {
          sessionName,
          lines: 80,
          expectedGenerationId: activeGenerationId || undefined,
        },
        { startIfMissing: false }
      )
    ).capture;
    if (pattern.test(capture)) return capture;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for broker capture: ${capture}`);
}

let legacyServer = null;
let olderVersionServer = null;
try {
  const absentStateDir = path.join(stateDir, "read-only-token-absent");
  await assert.rejects(
    windowsBrokerRequest(
      "ping",
      {},
      {
        startIfMissing: false,
        env: { ...process.env, RAIL_CONNECTOR_STATE_DIR: absentStateDir },
      }
    ),
    (error) => error?.code === "ENOENT"
  );
  assert.equal(
    fs.existsSync(absentStateDir),
    false,
    "a no-start broker request must not create a token directory"
  );

  const symlinkStateDir = path.join(stateDir, "read-only-token-symlink");
  const symlinkPaths = windowsBrokerPaths({
    ...process.env,
    RAIL_CONNECTOR_STATE_DIR: symlinkStateDir,
  });
  fs.mkdirSync(symlinkPaths.stateDir, { recursive: true, mode: 0o700 });
  const symlinkTarget = path.join(symlinkPaths.stateDir, "token-target");
  fs.writeFileSync(symlinkTarget, `${"c".repeat(64)}\n`, { mode: 0o600 });
  try {
    fs.symlinkSync(symlinkTarget, symlinkPaths.tokenFile, "file");
    await assert.rejects(
      windowsBrokerRequest(
        "ping",
        {},
        {
          startIfMissing: false,
          env: { ...process.env, RAIL_CONNECTOR_STATE_DIR: symlinkStateDir },
        }
      ),
      (error) => error?.code === "EAUTH"
    );
    assert.equal(fs.lstatSync(symlinkPaths.tokenFile).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(symlinkTarget, "utf8"), `${"c".repeat(64)}\n`);
    await assert.rejects(
      windowsBrokerCleanupRequest("cleanupStop", {}, {
        env: { ...process.env, RAIL_CONNECTOR_STATE_DIR: symlinkStateDir },
      }),
      (error) => error?.code === "EAUTH"
    );
    assert.equal(await probeWindowsBroker({
      ...process.env, RAIL_CONNECTOR_STATE_DIR: symlinkStateDir,
    }), null);
    await assert.rejects(
      windowsBrokerRequest(
        "ping",
        {},
        {
          env: { ...process.env, RAIL_CONNECTOR_STATE_DIR: symlinkStateDir },
        }
      ),
      (error) => error?.code === "EAUTH"
    );
    assert.equal(fs.lstatSync(symlinkPaths.tokenFile).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(symlinkTarget, "utf8"), `${"c".repeat(64)}\n`);
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
    console.log("windows-broker symlink token check skipped: insufficient symlink privilege");
  }

  const tokenPaths = windowsBrokerPaths(process.env);
  fs.mkdirSync(tokenPaths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPaths.tokenFile, "short\n", { mode: 0o600 });
  await assert.rejects(
    windowsBrokerRequest("ping", {}, { startIfMissing: false }),
    (error) => error?.code === "EAUTH"
  );
  assert.equal(
    fs.readFileSync(tokenPaths.tokenFile, "utf8"),
    "short\n",
    "a no-start broker request must not repair a corrupt token"
  );
  for (const malformedToken of ["a".repeat(32), "g".repeat(64), "a".repeat(65)]) {
    fs.writeFileSync(tokenPaths.tokenFile, `${malformedToken}\n`, { mode: 0o600 });
    let malformedConnections = 0;
    const malformedServer = net.createServer((socket) => {
      malformedConnections += 1;
      socket.end(`${JSON.stringify({ ok: false, code: "EAUTH", error: "synthetic invalid token" })}\n`);
    });
    try {
      await new Promise((resolve, reject) => {
        malformedServer.once("error", reject);
        malformedServer.listen(windowsBrokerPaths(process.env, malformedToken).pipeName, resolve);
      });
      await assert.rejects(
        windowsBrokerRequest("ping", {}, { startIfMissing: false }),
        (error) => error?.code === "EAUTH"
      );
      await assert.rejects(
        windowsBrokerCleanupRequest("cleanupStop"),
        (error) => error?.code === "EAUTH"
      );
      assert.equal(await probeWindowsBroker(), null);
      assert.equal(malformedConnections, 0, "invalid tokens must be rejected before pipe contact");
      assert.equal(fs.readFileSync(tokenPaths.tokenFile, "utf8"), `${malformedToken}\n`);
    } finally {
      await new Promise((resolve) => malformedServer.close(resolve));
    }
  }
  const malformedStartupToken = "g".repeat(64);
  fs.writeFileSync(tokenPaths.tokenFile, `${malformedStartupToken}\n`, { mode: 0o600 });
  const olderVersionStateDir = path.join(stateDir, "older-version-broker");
  const olderVersionEnv = {
    ...process.env,
    RAIL_CONNECTOR_STATE_DIR: olderVersionStateDir,
    RAIL_CONNECTOR_CLAUDE_PATH: process.execPath,
  };
  const olderVersionToken = "d".repeat(64);
  const olderVersionTokenPaths = windowsBrokerPaths(olderVersionEnv);
  fs.mkdirSync(olderVersionTokenPaths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(olderVersionTokenPaths.tokenFile, `${olderVersionToken}\n`, { mode: 0o600 });
  const olderVersionPaths = windowsBrokerPaths(olderVersionEnv, olderVersionToken);
  const olderVersionOperations = [];
  const olderVersionPolicy = windowsBrokerLaunchPolicyFingerprint(olderVersionEnv);
  let olderVersionActive = true;
  olderVersionServer = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      const newline = request.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(request.slice(0, newline));
      olderVersionOperations.push(message.operation);
      socket.end(`${JSON.stringify({
        ok: true,
        result: {
          protocol: 1,
          version: "1.2.0+agility.16",
          launchPolicyFingerprint: olderVersionPolicy,
          ...(message.operation === "status" ? { managedSessions: olderVersionActive
            ? [{ name: "inert-predecessor-session", exited: false }] : [] } : {}),
        },
      })}\n`, () => {
        if (message.operation === "shutdown") olderVersionServer.close();
      });
    });
  });
  await new Promise((resolve, reject) => {
    olderVersionServer.once("error", reject);
    olderVersionServer.listen(olderVersionPaths.pipeName, resolve);
  });
  await assert.rejects(
    windowsBrokerRequest(
      "conditionalStopMetadata",
      {
        sessionName: "old_broker_exact_stop",
        expectedGenerationId: "00000000-0000-4000-8000-000000000000",
        expectedStartedAtMs: 1,
        expectedResolvedSessionId: "11111111-1111-4111-8111-111111111111",
        expectedCanonicalCwd: canonicalRepoRoot,
      },
      { env: olderVersionEnv, startIfMissing: false }
    ),
    (error) => error?.code === "EBROKERUPGRADE"
  );
  assert.deepEqual(
    olderVersionOperations,
    ["ping"],
    "an older same-policy broker must be rejected before exact-stop metadata dispatch"
  );
  await assert.rejects(windowsBrokerRequest("ping", {}, { env: olderVersionEnv }),
    (error) => error.code === "EBROKERUPGRADE");
  assert.deepEqual(olderVersionOperations.slice(1), ["ping", "status"],
    "the immediate predecessor with an active session must not receive shutdown");
  assert.equal(olderVersionServer.listening, true);
  olderVersionActive = false;
  const idleOperationsBefore = olderVersionOperations.length;
  try {
    // Only this owned inert predecessor is retired. The replacement is an
    // ordinary current broker in this test's unique token/state, with no PTY.
    const upgraded = await windowsBrokerRequest("ping", {}, { env: olderVersionEnv });
    assert.equal(upgraded.version, WINDOWS_BROKER_VERSION);
    assert.ok(Number.isSafeInteger(upgraded.pid) && upgraded.pid > 0);
    assert.deepEqual(olderVersionOperations.slice(idleOperationsBefore), ["ping", "status", "shutdown"],
      "an idle predecessor must be queried then shut down before the current broker is accepted");
    console.log("broker compatibility evidence agility.16 predecessor active refused; idle replaced by agility.17");
  } finally {
    if (olderVersionServer.listening) await new Promise((resolve) => olderVersionServer.close(resolve));
    olderVersionServer = null;
    const current = await probeWindowsBroker(olderVersionEnv);
    if (current) {
      assert.equal(current.compatible, true, "owned replacement cleanup must identify the current broker");
      assert.deepEqual(current.managedSessions, []);
      await windowsBrokerRequest("shutdown", {}, { env: olderVersionEnv, startIfMissing: false });
      const deadline = Date.now() + 5000;
      while (await probeWindowsBroker(olderVersionEnv)) {
        assert.ok(Date.now() < deadline, "owned compatibility replacement failed to exit");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  const legacyIdentity = createHash("sha256")
    .update(`${os.userInfo().username}\0${stateDir.toLowerCase()}`)
    .digest("hex")
    .slice(0, 24);
  const legacyPipe = `\\\\.\\pipe\\rail-connector-${legacyIdentity}`;
  let legacyConnections = 0;
  let legacyData = "";
  legacyServer = net.createServer((socket) => {
    legacyConnections += 1;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      legacyData += chunk;
    });
  });
  await new Promise((resolve, reject) => {
    legacyServer.once("error", reject);
    legacyServer.listen(legacyPipe, resolve);
  });
  assert.equal(await probeWindowsBroker(), null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(legacyConnections, 0);
  const ping = await windowsBrokerRequest("ping");
  assert.equal(ping.protocol, 1);
  const brokerToken = fs.readFileSync(tokenPaths.tokenFile, "utf8").trim();
  assert.match(brokerToken, /^[0-9a-f]{64}$/i);
  assert.notEqual(brokerToken, malformedStartupToken);
  await windowsBrokerRequest("ping");
  assert.equal(
    fs.readFileSync(tokenPaths.tokenFile, "utf8").trim(),
    brokerToken,
    "normal startup preserves an already valid broker token"
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(legacyConnections, 0);
  assert.equal(legacyData.includes(brokerToken), false);
  await new Promise((resolve) => legacyServer.close(resolve));
  legacyServer = null;

  // Faults run only inside this test's real broker, never a shared runtime.
  // Every request below forbids restart so a crash cannot masquerade as recovery.
  {
  const faultReceipts = path.join(stateDir, "broker-error-receipts.jsonl");
  const faultControl = path.join(stateDir, "broker-error-control.json");
  const noStart = { startIfMissing: false };
  const readFaults = () => fs.existsSync(faultReceipts)
    ? fs.readFileSync(faultReceipts, "utf8").split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  let faultId = 0;
  function armFault(command) {
    const id = ++faultId;
    fs.writeFileSync(faultControl, JSON.stringify({ ...command, id }), { flag: "wx" });
    return id;
  }
  async function faultReceipt(id) {
    let record;
    const deadline = Date.now() + 5000;
    do {
      record = readFaults().find((entry) => entry.id === id);
      if (record) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.ok(record, "deterministic broker fault was not acknowledged");
    return record;
  }
  async function sameBroker() {
    const status = await windowsBrokerRequest("status", {}, noStart);
    assert.equal(status.pid, ping.pid, "fault must not restart the broker");
    return status;
  }
  async function rawConnection(text) {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(windowsBrokerPaths(process.env, brokerToken).pipeName);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("owned socket did not close")); }, 5000);
      socket.on("error", () => {});
      socket.on("close", () => { clearTimeout(timer); resolve(); });
      socket.on("connect", () => socket.write(text));
      socket.resume();
    });
  }
  let id = armFault({ kind: "socket", stage: "setup", code: "private-error-code\n" });
  await rawConnection("not-json\n");
  assert.equal((await faultReceipt(id)).destroyed, true);
  await sameBroker();
  id = armFault({ kind: "socket", stage: "reply", code: "ECONNRESET" });
  await assert.rejects(windowsBrokerRequest("ping", {}, noStart));
  assert.equal((await faultReceipt(id)).responseOk, true);
  assert.equal((await faultReceipt(id)).destroyed, true);
  await sameBroker();
  id = armFault({ kind: "socket", stage: "reply", code: "ECONNRESET" });
  await rawConnection("not-json\n");
  assert.equal((await faultReceipt(id)).responseOk, false);
  assert.equal((await faultReceipt(id)).destroyed, true);
  await sameBroker();

  const faultName = `${sessionName}_fault`;
  const healthyName = `${sessionName}_healthy`;
  const faultLease = "fault-generation-lease";
  const healthyLease = "healthy-generation-lease";
  async function startErrorFixture(name, lease, target, ledger = fixtureLedger) {
    return windowsBrokerRequest("start", {
      sessionName: name, command: process.execPath,
      args: [fixture, ...ledger.fixtureArgs], metadataCommand: process.execPath,
      metadataArgs: [fixture, ...ledger.fixtureArgs],
      cwd: repoRoot, canonicalCwd: canonicalRepoRoot,
      env: { ...process.env, ...ledger.environment, RAIL_TEST_BROKER_ERROR_TARGET: target },
      leaseId: lease, leaseTtlMs: 120000,
    }, noStart);
  }
  const failedStart = await startErrorFixture(faultName, faultLease, "fault");
  const healthyStart = await startErrorFixture(healthyName, healthyLease, "healthy");
  const failedBinding = { expectedGenerationId: failedStart.metadata.generationId, expectedStartedAtMs: failedStart.metadata.startedAtMs };
  const healthyBinding = { expectedGenerationId: healthyStart.metadata.generationId, expectedStartedAtMs: healthyStart.metadata.startedAtMs };
  // Actual onExit callbacks are buffered only by the preload, making the
  // distinction between an error and confirmed exit deterministic.
  id = armFault({ kind: "terminal", stage: "setup", target: "fault", code: "ECONNRESET" });
  await windowsBrokerRequest("ping", {}, noStart);
  await faultReceipt(id);
  let faulted = (await sameBroker()).managedSessions.find((entry) => entry.name === faultName);
  assert.equal(faulted.recoveryOnly, true);
  assert.equal(faulted.terminalErrorCode, "ECONNRESET");
  assert.equal(faulted.exited, false, "error alone must not claim child exit");
  assert.equal(faulted.exitCode, null);
  assert.equal(faulted.pid, failedStart.metadata.pid);
  assert.equal(faulted.generationId, failedStart.metadata.generationId);
  await assert.rejects(windowsBrokerRequest("sendText", {
    sessionName: faultName, text: "must-not-send", submit: true,
    leaseId: faultLease, ...failedBinding,
  }, noStart), (error) => error.code === "ERECOVERY");
  await assert.rejects(windowsBrokerRequest("stop", {
    sessionName: faultName, force: true, leaseId: faultLease,
  }, noStart), /exact expectedGenerationId/);
  assert.equal((await windowsBrokerRequest("acquireLease", {
    sessionName: faultName, leaseId: "foreign-lease", ...failedBinding,
  }, noStart)).status, "busy", "terminal failure must preserve the existing lease");
  await windowsBrokerRequest("sendText", {
    sessionName: healthyName, text: "error-isolated-healthy", submit: true,
    leaseId: healthyLease, ...healthyBinding,
  }, noStart);
  let healthyCapture = "";
  const healthyDeadline = Date.now() + 10000;
  do {
    healthyCapture = (await windowsBrokerRequest("capture", { sessionName: healthyName, ...healthyBinding }, noStart)).capture;
    if (healthyCapture.includes("ACK:error-isolated-healthy")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < healthyDeadline);
  assert.match(healthyCapture, /ACK:error-isolated-healthy/);
  const pendingFaultStop = windowsBrokerRequest("stop", {
    sessionName: faultName, force: true, leaseId: faultLease, ...failedBinding,
  }, noStart).then((value) => ({ value }), (error) => ({ error }));
  const exitDeadline = Date.now() + 4000;
  while (!readFaults().some((entry) => entry.kind === "actualExitBuffered" && entry.target === "fault") && Date.now() < exitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(readFaults().some((entry) => entry.kind === "actualExitBuffered" && entry.target === "fault"));
  id = armFault({ kind: "releaseExit", stage: "setup", target: "fault", code: "private-error-code\n" });
  await windowsBrokerRequest("ping", {}, noStart);
  const releasedExit = await faultReceipt(id);
  assert.ok(Number.isInteger(releasedExit.observedExit), "released exit must carry numeric actual evidence");
  const faultStop = await pendingFaultStop;
  if (faultStop.error) throw faultStop.error;
  assert.equal(faultStop.value.status, "stopped");
  assert.ok(Number.isInteger(faultStop.value.exitCode));
  assert.equal(faultStop.value.exitCode, releasedExit.observedExit, "duplicate callback must retain actual exit evidence");
  // Real socket destruction, with unmodified/unheld public onExit delivery.
  // A separate authenticated ledger isolates exact-owned native cleanup.
  for (const channel of ["outputSocket", "inputSocket"]) {
    const ledger = await createFixtureProcessLedger({ directory: path.join(stateDir, `${channel}-processes`), fixturePath: fixture });
    fixtureLedgers.add(ledger);
    const name = `${sessionName}_${channel}`;
    const leaseId = `${channel}-lease`;
    const started = await startErrorFixture(name, leaseId, channel, ledger);
    const binding = { expectedGenerationId: started.metadata.generationId, expectedStartedAtMs: started.metadata.startedAtMs };
    let record;
    const publicationDeadline = Date.now() + 10000;
    do {
      const records = await readFixtureProcessRecords(ledger.directory, ledger.runId);
      record = records.find((entry) => entry.pid === started.metadata.pid && entry.state === "ready");
      if (record) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < publicationDeadline);
    assert.ok(record, "socket fault child must have an authenticated ledger record");
    const assertOwnedAlive = () => {
      assert.equal(record.runId, ledger.runId);
      assert.equal(path.resolve(record.fixturePath).toLowerCase(), path.resolve(fixture).toLowerCase());
      for (let check = 0; check < 2; check += 1) {
        const identity = inspectFixtureProcess(record.pid);
        assert.equal(identity.creationFileTime, record.creationFileTime);
        assert.equal(path.resolve(identity.executablePath).toLowerCase(), path.resolve(process.execPath).toLowerCase());
        // Read-only native signal-zero observation bracketed by exact birth
        // checks. Actual termination later uses authenticated retained handles.
        if (check === 0) process.kill(record.pid, 0);
      }
    };
    assertOwnedAlive();
    id = armFault({ kind: channel, stage: "setup", target: channel, code: "ECONNRESET" });
    await windowsBrokerRequest("ping", {}, noStart);
    await faultReceipt(id);
    if (channel === "outputSocket") {
      const deadline = Date.now() + 3000;
      while (!readFaults().some((entry) => entry.kind === "onExitObserved" && entry.target === channel) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(readFaults().some((entry) => entry.kind === "onExitObserved" && entry.target === channel && entry.numeric === false && entry.held === false),
        "actual output close must expose the unheld unknown-exit regression");
    }
    const failed = (await sameBroker()).managedSessions.find((entry) => entry.name === name);
    assert.equal(failed.recoveryOnly, true);
    assert.equal(failed.terminalErrorCode, "ECONNRESET");
    if (channel === "outputSocket" || !failed.exited) {
      assert.equal(failed.exited, false);
      assert.equal(failed.exitCode, null);
    } else {
      assert.ok(Number.isInteger(failed.exitCode), "input EOF may end the fixture, but only numeric exit evidence is accepted");
      assert.ok(readFaults().some((entry) => entry.kind === "nativeExitObserved" && entry.target === channel && entry.exitCode === failed.exitCode));
      assert.ok(readFaults().some((entry) => entry.kind === "onExitObserved" && entry.target === channel && entry.numeric && entry.held === false));
    }
    assert.equal(failed.generationId, binding.expectedGenerationId);
    if (channel === "outputSocket") assertOwnedAlive(); // Output close is not native child-exit proof.
    await windowsBrokerRequest("sendText", { sessionName: healthyName, text: `healthy-after-${channel}`, submit: true,
      leaseId: healthyLease, ...healthyBinding }, noStart);
    const healthyUntil = Date.now() + 5000;
    let capture = "";
    do {
      capture = (await windowsBrokerRequest("capture", { sessionName: healthyName, ...healthyBinding }, noStart)).capture;
      if (capture.includes(`ACK:healthy-after-${channel}`)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < healthyUntil);
    assert.ok(capture.includes(`ACK:healthy-after-${channel}`));
    if (channel === "outputSocket" && process.argv.includes("--exercise-fault-cleanup")) {
      throw new Error("Intentional actual-socket fault-cleanup exercise");
    }
    const stopped = await windowsBrokerRequest("stop", { sessionName: name, force: true, leaseId, ...binding }, noStart);
    if (channel === "outputSocket") assert.equal(stopped.status, "stop_timeout", "unknown output-close evidence must not manufacture a stopped result");
    else assert.ok(["stopped", "not_running", "stop_timeout"].includes(stopped.status));
    if (stopped.status !== "stop_timeout") {
      assert.ok(Number.isInteger(stopped.exitCode));
      assert.ok(readFaults().some((entry) => entry.kind === "nativeExitObserved" && entry.target === channel && entry.exitCode === stopped.exitCode));
      assert.ok(readFaults().some((entry) => entry.kind === "onExitObserved" && entry.target === channel && entry.numeric && entry.held === false));
    }
    else {
      const retained = (await sameBroker()).managedSessions.find((entry) => entry.name === name);
      assert.equal(retained.exited, false);
      assert.equal(retained.exitCode, null);
      assert.equal(retained.recoveryOnly, true);
      await assert.rejects(windowsBrokerRequest("shutdown", {}, noStart), /sessions are running/);
    }
    // Retained handles verify original-child extinction (or perform exact-owned
    // recovery); neither a stale PID nor public onExit is substituted for it.
    const reaped = await ledger.reap({ graceMs: 0, final: true });
    assert.deepEqual(reaped, [], "the exact ConPTY stop must have ended this original child");
    if (stopped.status === "stop_timeout") {
      assert.ok(readFaults().some((entry) => entry.kind === "nativeExitObserved" && entry.target === channel && Number.isInteger(entry.exitCode)));
      id = armFault({ kind: "cleanupNativeExits", stage: "setup" });
      await windowsBrokerRequest("ping", {}, noStart);
      await faultReceipt(id);
      assert.ok(readFaults().some((entry) => entry.kind === "syntheticNativeExitCleanup" && entry.target === channel && entry.synthetic));
      const lease = await windowsBrokerRequest("acquireLease", { sessionName: name, leaseId, ...binding }, noStart);
      assert.equal(lease.status, "acquired");
      assert.equal((await windowsBrokerRequest("stop", { sessionName: name, force: true, leaseId, ...binding }, noStart)).status, "not_running");
    }
    console.log(`broker socket-destroy evidence ${JSON.stringify({ channel,
      nativeBirthMatchedBeforeFault: true,
      nativeBirthAndSignalZeroAliveAfterFault: channel === "outputSocket" ? true : "not-measured-input-EOF-may-exit",
      publicOnExitHeld: false,
      unknownPublicExitObserved: readFaults().some((entry) => entry.kind === "onExitObserved" && entry.target === channel && entry.numeric === false),
      productionStopStatus: stopped.status, originalChildAlreadyGoneAtRetainedHandleCleanup: reaped.length === 0,
      syntheticNativeExitForwardedOnlyForTestCleanup: stopped.status === "stop_timeout" })}`);
  }
  async function waitForErrorFixtureReady(name, binding) {
    // Start can observe ConPTY handshake output before the fake program's
    // ready banner/paste mode. Flush that output before arming a send race.
    const deadline = Date.now() + 5000;
    while (!(await windowsBrokerRequest("capture", { sessionName: name, ...binding }, noStart)).capture.includes("Fake Claude TUI")) {
      assert.ok(Date.now() < deadline, "send-race fixture failed to become ready");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  // Each fault lands inside an in-flight send, rather than before admission.
  // Exact PTY write suffixes prove that no later body/frame/Enter is replayed.
  const sendRaces = [
    { label: "opening-sync", afterWrite: "\x1b[200~", asynchronous: false,
      payload: { text: "race-opening", bracketedPaste: true, submit: true },
      writes: ["\x1b[200~"] },
    { label: "ordinary-chunk", afterWrite: "x".repeat(256), asynchronous: true,
      payload: { text: "x".repeat(300), chunkSize: 256, chunkDelayMs: 250, submit: true },
      writes: ["x".repeat(256)] },
    { label: "prefix-settle", afterWrite: "ultracode:", asynchronous: true,
      payload: { text: "ultracode:race-prefix", keywordPrefix: true, bracketedPaste: true, submit: true },
      writes: ["ultracode:"] },
    { label: "keyword-chunk", afterWrite: "x".repeat(256), asynchronous: true,
      payload: { text: `ultracode:${"x".repeat(300)}`, keywordPrefix: true, bracketedPaste: true,
        chunkSize: 256, chunkDelayMs: 250, submit: true },
      writes: ["ultracode:", "\x1b[200~", "x".repeat(256)] },
    { label: "submit-settle", afterWrite: "\x1b[201~", asynchronous: true,
      payload: { text: "race-submit", bracketedPaste: true, submit: true, submitSettleMs: 500 },
      writes: ["\x1b[200~", "race-submit", "\x1b[201~"] },
    { label: "keyword-submit", afterWrite: "\x1b[201~", asynchronous: true,
      payload: { text: "ultracode:race-submit", keywordPrefix: true, bracketedPaste: true,
        submit: true, submitSettleMs: 500 },
      writes: ["ultracode:", "\x1b[200~", "race-submit", "\x1b[201~"] },
    { label: "text-final", afterWrite: "\r", asynchronous: true,
      payload: { text: "race-final", submit: true }, writes: ["race-final", "\r"] },
    { label: "key-final", operation: "sendKey", afterWrite: "\t", asynchronous: true,
      payload: { key: "Tab" }, writes: ["\t"] },
  ];
  for (const scenario of sendRaces) {
    const target = `send-race-${scenario.label}`;
    const name = `${sessionName}_${target}`;
    const leaseId = `${target}-lease`;
    const started = await startErrorFixture(name, leaseId, target);
    const binding = { expectedGenerationId: started.metadata.generationId, expectedStartedAtMs: started.metadata.startedAtMs };
    const writes = () => readFaults().filter((entry) => entry.kind === "ptyWrite" && entry.target === target).map((entry) => entry.data);
    let before;
    try {
      await waitForErrorFixtureReady(name, binding);
      before = writes().length;
      id = armFault({ kind: "terminalWrite", stage: "write", target, afterWrite: scenario.afterWrite,
        asynchronous: scenario.asynchronous, code: "ECONNRESET" });
      await assert.rejects(windowsBrokerRequest(scenario.operation ?? "sendText", {
        sessionName: name, ...scenario.payload, leaseId, ...binding,
      }, noStart), (error) => error.code === "ERECOVERY", `${scenario.label} must not return sent`);
      const observed = await faultReceipt(id);
      assert.equal(observed.stage, "write");
      assert.deepEqual(writes().slice(before), scenario.writes, `${scenario.label}: no later write after fault`);
      const failed = (await sameBroker()).managedSessions.find((entry) => entry.name === name);
      assert.equal(failed.recoveryOnly, true);
      assert.equal(failed.exited, false, "an emitted terminal error is not exit evidence");
      assert.equal(failed.generationId, binding.expectedGenerationId);
      assert.equal((await windowsBrokerRequest("acquireLease", {
        sessionName: name, leaseId: "foreign-race-lease", ...binding,
      }, noStart)).status, "busy", "interrupted sends must preserve the original lease");
      await windowsBrokerRequest("sendText", { sessionName: healthyName, text: `healthy-${scenario.label}`,
        submit: true, leaseId: healthyLease, ...healthyBinding }, noStart);
      const capture = (await windowsBrokerRequest("capture", { sessionName: healthyName, ...healthyBinding }, noStart)).capture;
      assert.ok(capture.includes(`ACK:healthy-${scenario.label}`));
      assert.deepEqual(writes().slice(before), scenario.writes, "healthy traffic must not replay a failed send");
    } finally {
      // This scenario emits an error but leaves its real sockets intact, so a
      // normal exact-owned ConPTY stop must provide numeric native exit proof.
      const stopped = await windowsBrokerRequest("stop", { sessionName: name, force: true, leaseId, ...binding }, noStart);
      assert.equal(stopped.status, "stopped");
      assert.ok(Number.isInteger(stopped.exitCode));
    }
    console.log(`broker send-race evidence ${JSON.stringify({ label: scenario.label,
      asynchronous: scenario.asynchronous, noLaterWrites: true, noFalseSent: true,
      generationAndLeasePreserved: true, sameBrokerHealthyAck: true })}`);
  }
  // A genuine fixture /exit during the final settle is also not a successful
  // send. This observes the actual native/public numeric exit, with no fault or
  // synthetic callback and without conflating an output close with child exit.
  {
    const target = "send-numeric-exit";
    const name = `${sessionName}_${target}`;
    const leaseId = `${target}-lease`;
    const started = await startErrorFixture(name, leaseId, target);
    const binding = { expectedGenerationId: started.metadata.generationId, expectedStartedAtMs: started.metadata.startedAtMs };
    try {
      await waitForErrorFixtureReady(name, binding);
      await assert.rejects(windowsBrokerRequest("sendText", {
        sessionName: name, text: "/exit", submit: true, leaseId, ...binding,
      }, noStart), /session has exited/);
      const exited = (await sameBroker()).managedSessions.find((entry) => entry.name === name);
      assert.equal(exited.exited, true);
      assert.ok(Number.isInteger(exited.exitCode));
      assert.ok(readFaults().some((entry) => entry.kind === "nativeExitObserved" && entry.target === target && entry.exitCode === exited.exitCode));
      assert.ok(readFaults().some((entry) => entry.kind === "onExitObserved" && entry.target === target && entry.numeric && !entry.held && entry.exitCode === exited.exitCode));
    } finally {
      const stopped = await windowsBrokerRequest("stop", { sessionName: name, force: true, leaseId, ...binding }, noStart);
      assert.ok(["stopped", "not_running"].includes(stopped.status));
      assert.ok(Number.isInteger(stopped.exitCode));
    }
    console.log("broker send-race evidence actual numeric exit rejected before sent");
  }
  const healthyStop = await windowsBrokerRequest("stop", { sessionName: healthyName, graceful: true, force: false, leaseId: healthyLease, ...healthyBinding }, noStart);
  assert.equal(healthyStop.status, "stopped");
  assert.equal(healthyStop.graceful, true);
  const afterFaults = await sameBroker();
  assert.equal(afterFaults.managedSessions.some((entry) => [faultName, healthyName].includes(entry.name)), false);
  const faultLog = fs.readFileSync(path.join(tokenPaths.stateDir, "broker.log"), "utf8");
  assert.match(faultLog, /client_socket_error ESOCKET/);
  assert.match(faultLog, /terminal_error ECONNRESET/);
  assert.equal(faultLog.includes("private-error-message"), false);
  assert.equal(faultLog.includes("private-error-code"), false);
  assert.equal(JSON.stringify(afterFaults).includes("private-error-"), false);
  }

  await assert.rejects(
    windowsBrokerRequest("start", {
      sessionName: `${sessionName}_rejected`,
      command: process.env.ComSpec,
      args: ["/d", "/c", "exit 0"],
      metadataCommand: process.env.ComSpec,
      metadataArgs: ["/d", "/c", "exit 0"],
      cwd: repoRoot,
      env: { ...process.env },
      leaseId: "rejected-start-lease",
    }),
    /does not match RAIL_CONNECTOR_CLAUDE_PATH/
  );
  await assert.rejects(
    windowsBrokerRequest("start", {
      sessionName: `${sessionName}_cwd_rejected`,
      command: process.execPath,
      args: [fixture, ...fixtureLedger.fixtureArgs],
      metadataCommand: process.execPath,
      metadataArgs: [fixture, ...fixtureLedger.fixtureArgs],
      cwd: repoRoot,
      canonicalCwd: stateDir,
      env: { ...process.env },
      leaseId: "rejected-cwd-lease",
    }),
    (error) => error?.code === "ECWDPROVENANCE"
  );
  await assert.rejects(
    windowsBrokerRequest("start", {
      sessionName: `${sessionName}_launch_env_rejected`,
      command: process.execPath,
      args: [fixture, ...fixtureLedger.fixtureArgs],
      metadataCommand: process.execPath,
      metadataArgs: [fixture, ...fixtureLedger.fixtureArgs],
      cwd: repoRoot,
      canonicalCwd: canonicalRepoRoot,
      env: {
        ...process.env,
        RAIL_FAKE_CLAUDE_ARGV_DIR: path.join(stateDir, "rejected-launch-records"),
      },
      launchEnvironment: {
        ...launchEnvironment,
        status: "compatible",
      },
      leaseId: "rejected-launch-env-lease",
    }),
    (error) => error?.code === "ELAUNCHENV"
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    fs.existsSync(path.join(stateDir, "rejected-launch-records")),
    false,
    "invalid launch metadata must be rejected before spawning Claude"
  );

  // The updater guard is supplied only to this task-owned child launch.  This
  // covers the broker's payload.env handoff without modifying this test
  // process or a user's persistent Claude configuration.
  const updaterChild = path.join(stateDir, "updater-env-child.mjs");
  const updaterReceipt = path.join(stateDir, "updater-env-child.json");
  const inheritedUpdaterGuard = process.env.DISABLE_AUTOUPDATER;
  fs.writeFileSync(
    updaterChild,
    [
      'import fs from "node:fs";',
      `import { recordFixtureProcess } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "test", "fixtures", "fixture-process-ledger.mjs")).href)};`,
      'await recordFixtureProcess();',
      'const receipt = process.argv[2];',
      'fs.writeFileSync(receipt, JSON.stringify({ disableAutoUpdater: process.env.DISABLE_AUTOUPDATER ?? null }) + "\\n", { flag: "wx" });',
      'setInterval(() => {}, 1000);',
      "",
    ].join("\n"),
    { mode: 0o600 }
  );
  const updaterLedger = await createFixtureProcessLedger({ directory: path.join(stateDir, "updater-processes"), fixturePath: updaterChild });
  fixtureLedgers.add(updaterLedger);
  const updaterSession = `${sessionName}_updater_env`;
  const updaterLease = "updater-env-lease";
  const updaterStarted = await windowsBrokerRequest("start", {
    sessionName: updaterSession,
    command: process.execPath,
    args: [updaterChild, updaterReceipt, ...updaterLedger.fixtureArgs],
    metadataCommand: process.execPath,
    metadataArgs: [updaterChild, updaterReceipt, ...updaterLedger.fixtureArgs],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: { ...process.env, ...updaterLedger.environment, DISABLE_AUTOUPDATER: "1" },
    leaseId: updaterLease,
    leaseTtlMs: 10000,
  });
  assert.equal(updaterStarted.status, "started");
  const updaterDeadline = Date.now() + 10000;
  while (!fs.existsSync(updaterReceipt) && Date.now() < updaterDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(fs.existsSync(updaterReceipt), "task-owned child did not record its launch environment");
  assert.deepEqual(JSON.parse(fs.readFileSync(updaterReceipt, "utf8")), {
    disableAutoUpdater: "1",
  });
  assert.equal(
    process.env.DISABLE_AUTOUPDATER,
    inheritedUpdaterGuard,
    "the task-scoped updater guard must not mutate the parent environment"
  );
  const updaterStopped = await windowsBrokerRequest("stop", {
    sessionName: updaterSession,
    graceful: false,
    force: true,
    omitCapture: true,
    leaseId: updaterLease,
    expectedGenerationId: updaterStarted.metadata.generationId,
  });
  assert.equal(updaterStopped.status, "stopped");

  const rejectedFreshArgvDir = path.join(stateDir, "rejected-fresh-argv");
  fs.mkdirSync(rejectedFreshArgvDir);
  await assert.rejects(
    windowsBrokerRequest("start", {
      sessionName: `${sessionName}_rejected_fresh`,
      command: process.execPath,
      args: [fixture, ...fixtureLedger.fixtureArgs, "--session-id", "not-a-uuid"],
      metadataCommand: process.execPath,
      metadataArgs: [fixture, ...fixtureLedger.fixtureArgs, "--session-id", "not-a-uuid"],
      cwd: repoRoot,
      canonicalCwd: canonicalRepoRoot,
      env: { ...process.env, RAIL_FAKE_CLAUDE_ARGV_DIR: rejectedFreshArgvDir },
      freshSessionId: "not-a-uuid",
      resolvedSessionId: "not-a-uuid",
      leaseId: "rejected-fresh-lease",
      leaseTtlMs: 10000,
    }),
    (error) => error?.code === "ESESSIONIDENTITY"
  );
  assert.deepEqual(
    fs.readdirSync(rejectedFreshArgvDir),
    [],
    "an invalid fresh-session identity must be rejected before the fake Claude child starts"
  );

  const snapshotBindingSession = `${sessionName}_snapshot_binding`;
  const snapshotBindingLease = "snapshot-binding-lease";
  const freshSessionId = "77777777-7777-4777-8777-777777777777";
  const snapshotBindingStarted = await windowsBrokerRequest("start", {
    sessionName: snapshotBindingSession,
    command: process.execPath,
    args: [fixture, ...fixtureLedger.fixtureArgs, "--session-id", freshSessionId],
    metadataCommand: process.execPath,
    metadataArgs: [fixture, ...fixtureLedger.fixtureArgs, "--session-id", freshSessionId],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: { ...process.env },
    freshSessionId,
    resolvedSessionId: freshSessionId,
    leaseId: snapshotBindingLease,
    leaseTtlMs: 10000,
  });
  assert.equal(snapshotBindingStarted.metadata.snapshotIdentityBinding, null);
  const snapshotBindingGenerationId = snapshotBindingStarted.metadata.generationId;
  const snapshotBindingStartedAtMs = snapshotBindingStarted.metadata.startedAtMs;
  const snapshotBindingPayload = {
    sessionName: snapshotBindingSession,
    leaseId: snapshotBindingLease,
    expectedGenerationId: snapshotBindingGenerationId,
    expectedStartedAtMs: snapshotBindingStartedAtMs,
    requestedSessionId: freshSessionId,
    resolvedSessionId: freshSessionId,
    logFileIdentity: "fake-log-file-identity-v1",
  };
  await assert.rejects(
    windowsBrokerRequest("bindWorkflowSnapshotIdentity", {
      ...snapshotBindingPayload,
      expectedStartedAtMs: undefined,
    }),
    (error) => error?.code === "EINVAL"
  );
  await assert.rejects(
    windowsBrokerRequest("bindWorkflowSnapshotIdentity", {
      ...snapshotBindingPayload,
      expectedGenerationId: "00000000-0000-4000-8000-000000000000",
    }),
    (error) => error?.code === "ESTALE"
  );
  await assert.rejects(
    windowsBrokerRequest("bindWorkflowSnapshotIdentity", {
      ...snapshotBindingPayload,
      requestedSessionId: "88888888-8888-4888-8888-888888888888",
    }),
    (error) => error?.code === "ESESSIONIDENTITY"
  );
  await assert.rejects(
    windowsBrokerRequest("bindWorkflowSnapshotIdentity", {
      ...snapshotBindingPayload,
      logFileIdentity: " ",
    }),
    (error) => error?.code === "EINVAL"
  );
  const snapshotIdentityBound = await windowsBrokerRequest(
    "bindWorkflowSnapshotIdentity",
    snapshotBindingPayload
  );
  assert.equal(snapshotIdentityBound.status, "bound");
  assert.deepEqual(snapshotIdentityBound.metadata.snapshotIdentityBinding, {
    generationId: snapshotBindingGenerationId,
    startedAtMs: snapshotBindingStartedAtMs,
    resolvedSessionId: freshSessionId,
    logFileIdentity: "fake-log-file-identity-v1",
    mode: "fresh",
  });
  await assert.rejects(
    windowsBrokerRequest("bindWorkflowSnapshotIdentity", snapshotBindingPayload),
    (error) => error?.code === "EBOUND"
  );
  await assert.rejects(
    windowsBrokerRequest("updateMetadata", {
      sessionName: snapshotBindingSession,
      leaseId: snapshotBindingLease,
      expectedGenerationId: snapshotBindingGenerationId,
      expectedStartedAtMs: snapshotBindingStartedAtMs,
      resolvedSessionId: "99999999-9999-4999-8999-999999999999",
    }),
    (error) => error?.code === "EBOUND"
  );
  assert.equal(
    (
      await windowsBrokerRequest("updateMetadata", {
        sessionName: snapshotBindingSession,
        leaseId: snapshotBindingLease,
        expectedGenerationId: snapshotBindingGenerationId,
        expectedStartedAtMs: snapshotBindingStartedAtMs,
        resolvedSessionId: freshSessionId,
      })
    ).metadata.resolvedSessionId,
    freshSessionId
  );

  const resumeBindingSession = `${sessionName}_snapshot_resume`;
  const resumeSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const resumeBindingStarted = await windowsBrokerRequest("start", {
    sessionName: resumeBindingSession,
    command: process.execPath,
    args: [fixture, ...fixtureLedger.fixtureArgs, "--session-id", resumeSessionId, "--resume", resumeSessionId],
    metadataCommand: process.execPath,
    metadataArgs: [fixture, ...fixtureLedger.fixtureArgs, "--session-id", resumeSessionId, "--resume", resumeSessionId],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: { ...process.env },
    resolvedSessionId: resumeSessionId,
    leaseId: "snapshot-resume-lease",
    leaseTtlMs: 10000,
  });
  await assert.rejects(
    windowsBrokerRequest("bindWorkflowSnapshotIdentity", {
      sessionName: resumeBindingSession,
      leaseId: "snapshot-resume-lease",
      expectedGenerationId: resumeBindingStarted.metadata.generationId,
      expectedStartedAtMs: resumeBindingStarted.metadata.startedAtMs,
      requestedSessionId: resumeSessionId,
      resolvedSessionId: resumeSessionId,
      logFileIdentity: "resume-log-file-identity",
    }),
    (error) => error?.code === "ESESSIONIDENTITY"
  );
  assert.equal(
    (
      await windowsBrokerRequest("stop", {
        sessionName: resumeBindingSession,
        graceful: false,
        force: true,
        omitCapture: true,
        leaseId: "snapshot-resume-lease",
        expectedGenerationId: resumeBindingStarted.metadata.generationId,
        expectedStartedAtMs: resumeBindingStarted.metadata.startedAtMs,
      })
    ).status,
    "stopped"
  );

  const noFreshBindingSession = `${sessionName}_snapshot_no_fresh`;
  const noFreshSessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const noFreshBindingStarted = await windowsBrokerRequest("start", {
    sessionName: noFreshBindingSession,
    command: process.execPath,
    args: [fixture, ...fixtureLedger.fixtureArgs, "--session-id", noFreshSessionId],
    metadataCommand: process.execPath,
    metadataArgs: [fixture, ...fixtureLedger.fixtureArgs, "--session-id", noFreshSessionId],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: { ...process.env },
    resolvedSessionId: noFreshSessionId,
    leaseId: "snapshot-no-fresh-lease",
    leaseTtlMs: 10000,
  });
  await assert.rejects(
    windowsBrokerRequest("bindWorkflowSnapshotIdentity", {
      sessionName: noFreshBindingSession,
      leaseId: "snapshot-no-fresh-lease",
      expectedGenerationId: noFreshBindingStarted.metadata.generationId,
      expectedStartedAtMs: noFreshBindingStarted.metadata.startedAtMs,
      requestedSessionId: noFreshSessionId,
      resolvedSessionId: noFreshSessionId,
      logFileIdentity: "no-fresh-log-file-identity",
    }),
    (error) => error?.code === "ESESSIONIDENTITY"
  );
  assert.equal(
    (
      await windowsBrokerRequest("stop", {
        sessionName: noFreshBindingSession,
        graceful: false,
        force: true,
        omitCapture: true,
        leaseId: "snapshot-no-fresh-lease",
        expectedGenerationId: noFreshBindingStarted.metadata.generationId,
        expectedStartedAtMs: noFreshBindingStarted.metadata.startedAtMs,
      })
    ).status,
    "stopped"
  );

  const exitedBindingSession = `${sessionName}_snapshot_exited`;
  const exitedSessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const exitedBindingStarted = await windowsBrokerRequest("start", {
    sessionName: exitedBindingSession,
    command: process.execPath,
    args: [fixture, ...fixtureLedger.fixtureArgs, "--session-id", exitedSessionId],
    metadataCommand: process.execPath,
    metadataArgs: [fixture, ...fixtureLedger.fixtureArgs, "--session-id", exitedSessionId],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: { ...process.env, RAIL_FAKE_CLAUDE_EXIT_ON_START: "1" },
    freshSessionId: exitedSessionId,
    resolvedSessionId: exitedSessionId,
    leaseId: "snapshot-exited-lease",
    leaseTtlMs: 10000,
  });
  const exitedBindingDeadline = Date.now() + 10000;
  let exitedBindingMetadata = null;
  while (Date.now() < exitedBindingDeadline) {
    exitedBindingMetadata = (await probeWindowsBroker()).managedSessions.find(
      (candidate) => candidate.name === exitedBindingSession
    );
    if (exitedBindingMetadata?.exited) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(exitedBindingMetadata?.exited, true);
  await assert.rejects(
    windowsBrokerRequest("bindWorkflowSnapshotIdentity", {
      sessionName: exitedBindingSession,
      leaseId: "snapshot-exited-lease",
      expectedGenerationId: exitedBindingStarted.metadata.generationId,
      expectedStartedAtMs: exitedBindingStarted.metadata.startedAtMs,
      requestedSessionId: exitedSessionId,
      resolvedSessionId: exitedSessionId,
      logFileIdentity: "exited-log-file-identity",
    }),
    (error) => error?.code === "ERECOVERY"
  );
  assert.equal(
    (
      await windowsBrokerRequest("stop", {
        sessionName: exitedBindingSession,
        graceful: false,
        force: false,
        omitCapture: true,
        leaseId: "snapshot-exited-lease",
        expectedGenerationId: exitedBindingStarted.metadata.generationId,
        expectedStartedAtMs: exitedBindingStarted.metadata.startedAtMs,
      })
    ).status,
    "not_running"
  );

  const replacementSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const snapshotBindingReplaced = await windowsBrokerRequest("replace", {
    sessionName: snapshotBindingSession,
    command: process.execPath,
    args: [fixture, ...fixtureLedger.fixtureArgs, "--session-id", replacementSessionId],
    metadataCommand: process.execPath,
    metadataArgs: [fixture, ...fixtureLedger.fixtureArgs, "--session-id", replacementSessionId],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: { ...process.env },
    freshSessionId: replacementSessionId,
    resolvedSessionId: replacementSessionId,
    graceful: false,
    force: true,
    leaseId: snapshotBindingLease,
    expectedGenerationId: snapshotBindingGenerationId,
    expectedStartedAtMs: snapshotBindingStartedAtMs,
  });
  assert.equal(snapshotBindingReplaced.status, "started");
  assert.equal(snapshotBindingReplaced.metadata.snapshotIdentityBinding, null);
  await assert.rejects(
    windowsBrokerRequest("bindWorkflowSnapshotIdentity", {
      sessionName: snapshotBindingSession,
      leaseId: snapshotBindingLease,
      expectedGenerationId: snapshotBindingReplaced.metadata.generationId,
      expectedStartedAtMs: snapshotBindingReplaced.metadata.startedAtMs,
      requestedSessionId: freshSessionId,
      resolvedSessionId: freshSessionId,
      logFileIdentity: "replacement-cannot-inherit",
    }),
    (error) => error?.code === "ESESSIONIDENTITY"
  );
  assert.equal(
    (
      await windowsBrokerRequest("stop", {
        sessionName: snapshotBindingSession,
        graceful: false,
        force: true,
        omitCapture: true,
        leaseId: snapshotBindingLease,
        expectedGenerationId: snapshotBindingReplaced.metadata.generationId,
        expectedStartedAtMs: snapshotBindingReplaced.metadata.startedAtMs,
      })
    ).status,
    "stopped"
  );

  const started = await windowsBrokerRequest("start", {
    sessionName,
    command: process.execPath,
    args: [fixture, ...fixtureLedger.fixtureArgs],
    metadataCommand: process.execPath,
    metadataArgs: [fixture, ...fixtureLedger.fixtureArgs],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: { ...process.env },
    requestedPosture: { permissionMode: "default" },
    resolvedPosture: { permissionMode: "manual" },
    launchEnvironment,
    resolvedSessionId: "33333333-3333-4333-8333-333333333333",
    leaseId: "startup-lease",
    leaseTtlMs: 10000,
  });
  assert.equal(started.status, "started");
  assert.deepEqual(started.metadata.launchEnvironment, {
    status: "blocking",
    evidenceScope: "claude_child_launch_environment",
    effortOverrideStatus: "blocking_non_xhigh",
    workflowsDisabled: true,
    blockers: ["non_xhigh_effort_override", "workflows_disabled"],
    note: "The captured Claude child launch environment contains an override that prevents the requested UltraCode workflow posture.",
  });
  assert.doesNotMatch(
    JSON.stringify(started.metadata),
    /private-launch-value-must-not-persist/
  );
  activeGenerationId = started.metadata.generationId;
  assert.match(activeGenerationId, /^[0-9a-f-]{36}$/i);
  assert.match(await waitForCapture(/Fake Claude TUI/), /Fake Claude TUI/);
  await assert.rejects(
    windowsBrokerRequest(
      "ping",
      {},
      {
        env: {
          ...process.env,
          RAIL_CONNECTOR_CLAUDE_PATH: path.join(
            stateDir,
            "different-claude.exe"
          ),
        },
      }
    ),
    /still owns active sessions/
  );

  const firstLease = "startup-lease";
  const secondLease = "second-lease";
  const firstLeaseResult = await windowsBrokerRequest("acquireLease", {
    sessionName,
    leaseId: firstLease,
    ttlMs: 300000,
  });
  assert.equal(firstLeaseResult.status, "acquired");
  assert.equal(firstLeaseResult.generationId, activeGenerationId);
  const originalSessionPair = {
    expectedGenerationId: activeGenerationId,
    expectedStartedAtMs: started.metadata.startedAtMs,
  };
  async function acquireOriginalFixtureLease() {
    // Independent native fixtures can outlive the earlier 10-second lease.
    // Acquire this phase explicitly; never revive an expired lease by renewal.
    const lease = await windowsBrokerRequest("acquireLease", {
      sessionName,
      leaseId: firstLease,
      ttlMs: 300000,
      requireExactPair: true,
      ...originalSessionPair,
    });
    assert.equal(lease.status, "acquired");
    assert.equal(lease.generationId, originalSessionPair.expectedGenerationId);
    assert.equal(lease.startedAtMs, originalSessionPair.expectedStartedAtMs);
    return lease;
  }
  async function renewOriginalFixtureLease() {
    // Preservation checks must expose a dropped lease or exited generation.
    // Unlike phase acquisition, renewal must never repair either condition.
    const lease = await windowsBrokerRequest("renewLease", {
      sessionName,
      leaseId: firstLease,
      ttlMs: 300000,
      requireExactPair: true,
      ...originalSessionPair,
    });
    assert.equal(lease.status, "renewed");
    return lease;
  }
  // Name-selected callers retain this legacy lease path. A controller that
  // opts into the paired protocol must instead be rejected before any listed
  // broker operation can observe, mutate, or stop a same-name session.
  const strictPairOperations = [
    ["acquireLease", { leaseId: "strict-missing-lease", ttlMs: 10000 }],
    ["conditionalMetadata", {}],
    ["capture", { lines: 40 }],
    [
      "updateMetadata",
      { leaseId: firstLease, resolvedSessionId: "55555555-5555-4555-8555-555555555555" },
    ],
    ["updateObservation", { observedPosture: { permissionMode: "manual" } }],
    ["releaseLease", { leaseId: firstLease }],
    ["stop", { leaseId: firstLease, graceful: false, force: true, omitCapture: true }],
    [
      "sendText",
      {
        leaseId: firstLease,
        text: "strict pair rejection must not write terminal text",
        submit: true,
      },
    ],
    ["sendKey", { leaseId: firstLease, key: "Enter" }],
    ["acquireCleanupLease", { leaseId: "strict-missing-cleanup", ttlMs: 10000 }],
    ["releaseCleanupLease", { leaseId: "strict-missing-cleanup" }],
    ["cleanupStop", { leaseId: "strict-missing-cleanup" }],
  ];
  for (const [operation, payload] of strictPairOperations) {
    for (const partialPair of [
      {},
      { expectedGenerationId: activeGenerationId },
      { expectedStartedAtMs: started.metadata.startedAtMs },
    ]) {
      await assert.rejects(
        windowsBrokerRequest(operation, {
          sessionName,
          requireExactPair: true,
          ...payload,
          ...partialPair,
        }),
        (error) => error?.code === "EINVAL",
        `${operation} must reject a strict request without both generation fields`
      );
    }
  }
  assert.doesNotMatch(
    await waitForCapture(/Fake Claude TUI/),
    /strict pair rejection must not write terminal text/,
    "a rejected strict sendText must not reach the terminal"
  );
  await assert.rejects(
    windowsBrokerRequest("capture", {
      sessionName,
      requireExactPair: true,
      expectedGenerationId: activeGenerationId,
      expectedStartedAtMs: started.metadata.startedAtMs + 1,
    }),
    (error) => error?.code === "ESTALE",
    "a strict capture must reject a same-generation, different-start binding"
  );
  assert.equal(
    (await windowsBrokerRequest("capture", {
      sessionName,
      requireExactPair: true,
      expectedGenerationId: activeGenerationId,
      expectedStartedAtMs: started.metadata.startedAtMs,
    })).capture.includes("Fake Claude TUI"),
    true,
    "a strict capture must accept the exact current generation pair"
  );
  assert.equal(
    (
      await windowsBrokerRequest("renewLease", {
        sessionName,
        leaseId: firstLease,
        ttlMs: 10000,
      })
    ).status,
    "renewed"
  );
  assert.equal(
    (
      await windowsBrokerRequest("renewLease", {
        sessionName,
        leaseId: secondLease,
        ttlMs: 10000,
      })
    ).status,
    "lost"
  );
  const queuedLease = await windowsBrokerRequest("acquireLease", {
    sessionName,
    leaseId: secondLease,
    ttlMs: 10000,
  });
  assert.equal(queuedLease.status, "busy");
  assert.equal(queuedLease.generationId, activeGenerationId);
  await assert.rejects(
    windowsBrokerRequest("sendText", {
      sessionName,
      text: "wrong owner",
      submit: true,
      leaseId: secondLease,
      expectedGenerationId: activeGenerationId,
    }),
    /leased by another MCP/
  );
  const sent = await windowsBrokerRequest("sendText", {
    sessionName,
    text: "broker prompt",
    submit: true,
    bracketedPaste: true,
    leaseId: firstLease,
    expectedGenerationId: activeGenerationId,
  });
  assert.equal(sent.bracketedPasteRequested, true);
  assert.equal(sent.bracketedPasteUsed, true);
  assert.match(await waitForCapture(/ACK:broker prompt/), /ACK:broker prompt/);

  async function ordinaryFramingFixture(suffix, environment = {}) {
    const name = `${sessionName}_${suffix}`;
    const leaseId = `framing-${suffix}`;
    const wireFile = path.join(stateDir, `${suffix}-wire.jsonl`);
    const started = await windowsBrokerRequest("start", {
      sessionName: name, command: process.execPath, args: [fixture, ...fixtureLedger.fixtureArgs],
      metadataCommand: process.execPath, metadataArgs: [fixture, ...fixtureLedger.fixtureArgs],
      cwd: repoRoot, canonicalCwd: canonicalRepoRoot,
      env: { ...process.env, RAIL_FAKE_CLAUDE_WIRE_RECEIPT: wireFile, ...environment },
      leaseId, leaseTtlMs: 10000,
    });
    const context = { name, leaseId, wireFile, metadata: started.metadata };
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const captured = await windowsBrokerRequest("capture", { sessionName: name,
        expectedGenerationId: started.metadata.generationId });
      if (captured.capture.includes("Fake Claude TUI")) return context;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Owned ordinary framing fixture did not become ready.");
  }
  const framedRequest = (context, payload) => windowsBrokerRequest("sendText", {
    sessionName: context.name, leaseId: context.leaseId,
    expectedGenerationId: context.metadata.generationId, ...payload,
  });
  async function ordinaryWire(context) {
    if (!fakeTerminalSeesPasteMarkers) return (await brokerPtyWrites(context.name)).join("");
    if (!fs.existsSync(context.wireFile)) return "";
    return fs.readFileSync(context.wireFile, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line)).join("");
  }
  async function stopOrdinaryFixture(context) {
    assert.equal((await windowsBrokerRequest("stop", {
      sessionName: context.name, leaseId: context.leaseId, graceful: false, force: true,
      expectedGenerationId: context.metadata.generationId,
      expectedStartedAtMs: context.metadata.startedAtMs, omitCapture: true,
    })).status, "stopped");
  }
  const ordinaryFrame = await ordinaryFramingFixture("ordinary_frame");
  const emptyOrdinaryWire = await ordinaryWire(ordinaryFrame);
  for (const text of ["body\x1b[201~\r/exit", "body\x00", "body\x7f", "body\u009f"]) {
    await assert.rejects(framedRequest(ordinaryFrame, { text, bracketedPaste: true,
      requireBracketedPaste: true, submit: true }), (error) => error.code === "EINVAL");
    assert.equal(await ordinaryWire(ordinaryFrame), emptyOrdinaryWire,
      "invalid ordinary framed text must send neither markers, body nor Enter");
  }
  for (const flags of [{ bracketedPaste: "true" },
    { bracketedPaste: true, requireBracketedPaste: "true" },
    { bracketedPaste: false, requireBracketedPaste: true }]) {
    await assert.rejects(framedRequest(ordinaryFrame, { text: "plain", ...flags, submit: true }),
      (error) => error.code === "EINVAL");
    assert.equal(await ordinaryWire(ordinaryFrame), emptyOrdinaryWire);
  }
  const ordinaryBody = `Unicode 🧪 résumé\tTAB\nLF\rCR\r\n${"x".repeat(300)}`;
  const ordinarySent = await framedRequest(ordinaryFrame, { text: ordinaryBody,
    bracketedPaste: true, requireBracketedPaste: true, chunkSize: 256,
    chunkDelayMs: 25, submit: true });
  assert.equal(ordinarySent.bracketedPasteUsed, true);
  assert.equal((await ordinaryWire(ordinaryFrame)).slice(emptyOrdinaryWire.length),
    `\x1b[200~${ordinaryBody}\x1b[201~\r`, "ordinary strict framing preserves exact Unicode/TAB/CR/LF wire content");
  await stopOrdinaryFixture(ordinaryFrame);

  const ordinaryOff = await ordinaryFramingFixture("ordinary_off", {
    RAIL_FAKE_CLAUDE_DISABLE_PASTE_AFTER_KEYWORD_PREFIX: "1",
  });
  // Explicit raw input is intentional here and remains outside framed guards.
  await framedRequest(ordinaryOff, { text: "ultracode:", bracketedPaste: false, submit: false });
  const offWire = await ordinaryWire(ordinaryOff);
  for (const [text, strict] of [["strict plain", true], ["line\nline", false],
    ["line\rline", false], ["has\ttab", false]]) {
    await assert.rejects(framedRequest(ordinaryOff, { text, bracketedPaste: true,
      requireBracketedPaste: strict, submit: true }),
    (error) => error.code === "EPASTEMODE" && /no input was sent/.test(error.message));
    assert.equal(await ordinaryWire(ordinaryOff), offWire, "mode-off refusal must write zero bytes");
  }
  assert.equal((await framedRequest(ordinaryOff, { text: "safe plain Unicode 🧪",
    bracketedPaste: true, submit: false })).bracketedPasteUsed, false);
  assert.equal((await ordinaryWire(ordinaryOff)).slice(offWire.length), "safe plain Unicode 🧪");
  await stopOrdinaryFixture(ordinaryOff);

  const ordinaryLoss = await ordinaryFramingFixture("ordinary_loss", {
    [fakeTerminalSeesPasteMarkers ? "RAIL_FAKE_CLAUDE_DISABLE_PASTE_AFTER_KEYWORD_BODY"
      : "RAIL_FAKE_CLAUDE_DISABLE_PASTE_AFTER_UNFRAMED_KEYWORD_BODY"]: "1",
  });
  // Bind this assertion to the send; ConPTY may exchange device attributes
  // during startup. Preserve every byte after this observed boundary.
  const ordinaryLossWireBefore = await ordinaryWire(ordinaryLoss);
  const lossBody = `ultracode:${"x".repeat(650)}`;
  await assert.rejects(framedRequest(ordinaryLoss, { text: lossBody, bracketedPaste: true,
    requireBracketedPaste: true, chunkSize: 256, chunkDelayMs: 100, submit: true }),
  (error) => error.code === "EPASTEMODE" && /Framed body was partially sent/.test(error.message));
  assert.equal((await ordinaryWire(ordinaryLoss)).slice(ordinaryLossWireBefore.length), `\x1b[200~${lossBody.slice(0, 256)}`,
    "ordinary mode loss must not repair, continue, close the frame or send Enter");
  await assert.rejects(framedRequest(ordinaryLoss, { text: "must not replay", bracketedPaste: false }),
    (error) => error.code === "ERECOVERY");
  await stopOrdinaryFixture(ordinaryLoss);

  await acquireOriginalFixtureLease();
  const keywordBody = `ultracode:${"x".repeat(255)}🧪\nsecond line\r\nthird line\rfinal line`;
  const keywordWritesBefore = fakeTerminalSeesPasteMarkers ? 0 : (await brokerPtyWrites(sessionName)).length;
  const keywordSent = await windowsBrokerRequest("sendText", {
    sessionName, text: keywordBody, keywordPrefix: true, bracketedPaste: true,
    chunkSize: 256, chunkDelayMs: 0, submit: true, leaseId: firstLease,
    expectedGenerationId: activeGenerationId,
  });
  assert.equal(keywordSent.bracketedPasteUsed, true);
  if (fakeTerminalSeesPasteMarkers) {
    // Wait for the whole acknowledgement row, not only its first characters: a
    // slow host can still be rendering the long row when KEYWORD_ACK appears.
    const keywordAck = `KEYWORD_ACK:${JSON.stringify(keywordBody)}`;
    const keywordCapture = await waitForCapture({
      test: (capture) => capture.replaceAll("\n", "").includes(keywordAck),
    });
    // Long terminal rows wrap, but the JSON escape sequences and Unicode must not.
    assert.ok(keywordCapture.replaceAll("\n", "").includes(keywordAck));
    assert.doesNotMatch(keywordCapture, /\ufffd/);
  } else {
    // Broker boundary: the ten prefix characters, the opening marker, the body
    // chunks in order, the closing marker, then exactly one Enter.
    const writes = (await brokerPtyWrites(sessionName)).slice(keywordWritesBefore);
    assert.equal(writes[0], "ultracode:", "keyword prefix must be written first, literally");
    assert.equal(writes[1], "\x1b[200~", "the body must open with a bracketed-paste marker");
    assert.equal(writes.at(-2), "\x1b[201~", "the body must close with a bracketed-paste marker");
    assert.equal(writes.at(-1), "\r", "exactly one Enter must follow the closing marker");
    const bodyChunks = writes.slice(2, -2);
    assert.ok(
      bodyChunks.length >= 2 && bodyChunks.every((chunk) => chunk.length <= 256 && !chunk.includes("\x1b[")),
      "the body must be written as unframed chunks"
    );
    assert.equal(bodyChunks.join(""), keywordBody.slice("ultracode:".length), "the body must be written whole, in order");
    assert.equal(writes.filter((chunk) => chunk === "\r").length, 1, "keyword delivery must write one Enter");
    // End to end, this terminal cannot hold the newlines in its composer, so it
    // acknowledges each line; the text must still arrive once, in order, intact.
    const firstLineAck = `KEYWORD_ACK:${JSON.stringify(`ultracode:${"x".repeat(255)}🧪`)}`;
    const lineAcks = [firstLineAck, "ACK:second line", "ACK:third line", "ACK:final line"];
    const keywordCapture = await waitForCapture({
      test: (capture) => lineAcks.every((ack) => capture.replaceAll("\n", "").includes(ack)),
    });
    const flat = keywordCapture.replaceAll("\n", "");
    const positions = lineAcks.map((ack) => flat.indexOf(ack));
    assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]), "lines must arrive in order");
    for (const ack of lineAcks) assert.equal(flat.split(ack).length - 1, 1, `${ack.slice(0, 24)} must arrive once`);
    assert.doesNotMatch(keywordCapture, /\ufffd/);
  }
  const keywordModeLossSession = `${sessionName}_keyword_mode_loss`;
  const keywordModeLossLease = "keyword-mode-loss-lease";
  const keywordModeLossWireReceipt = path.join(stateDir, "keyword-mode-loss-wire.jsonl");
  const keywordModeLossStarted = await windowsBrokerRequest("start", {
    sessionName: keywordModeLossSession,
    command: process.execPath,
    args: [fixture, ...fixtureLedger.fixtureArgs],
    metadataCommand: process.execPath,
    metadataArgs: [fixture, ...fixtureLedger.fixtureArgs],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: {
      ...process.env,
      RAIL_FAKE_CLAUDE_DISABLE_PASTE_AFTER_KEYWORD_PREFIX: "1",
      RAIL_FAKE_CLAUDE_WIRE_RECEIPT: keywordModeLossWireReceipt,
    },
    leaseId: keywordModeLossLease,
    leaseTtlMs: 10000,
  });
  const keywordModeLossGenerationId = keywordModeLossStarted.metadata.generationId;
  const keywordModeLossStartedAtMs = keywordModeLossStarted.metadata.startedAtMs;
  const keywordModeLossReadyDeadline = Date.now() + 10000;
  let keywordModeLossCapture = "";
  while (Date.now() < keywordModeLossReadyDeadline) {
    keywordModeLossCapture = (
      await windowsBrokerRequest("capture", {
        sessionName: keywordModeLossSession,
        expectedGenerationId: keywordModeLossGenerationId,
      })
    ).capture;
    if (keywordModeLossCapture.includes("Fake Claude TUI")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(keywordModeLossCapture, /Fake Claude TUI/);
  await assert.rejects(
    windowsBrokerRequest("sendText", {
      sessionName: keywordModeLossSession,
      text: "ultracode: body must never be delivered after a mode loss",
      keywordPrefix: true,
      bracketedPaste: true,
      submit: true,
      leaseId: keywordModeLossLease,
      expectedGenerationId: keywordModeLossGenerationId,
    }),
    (error) =>
      error?.code === "EPASTEMODE" &&
      /Keyword prefix was sent.*no body or Enter was sent/i.test(error.message)
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(
    fs
      .readFileSync(keywordModeLossWireReceipt, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    ["ultracode:"],
    "a post-prefix mode loss must not send a body, paste delimiter, or Enter"
  );
  const keywordModeLossStopped = await windowsBrokerRequest("stop", {
    sessionName: keywordModeLossSession,
    // The retained literal prefix is intentionally a real draft. A graceful
    // /exit would append to it, so this isolated synthetic child is stopped
    // only after its exact generation has been inspected and bound.
    graceful: false,
    force: true,
    omitCapture: true,
    leaseId: keywordModeLossLease,
    expectedGenerationId: keywordModeLossGenerationId,
    expectedStartedAtMs: keywordModeLossStartedAtMs,
  });
  assert.equal(keywordModeLossStopped.status, "stopped");
  const keywordPartialModeLossSession = `${sessionName}_keyword_partial_mode_loss`;
  const keywordPartialModeLossLease = "keyword-partial-mode-loss-lease";
  const keywordPartialModeLossWireReceipt = path.join(
    stateDir,
    "keyword-partial-mode-loss-wire.jsonl"
  );
  const keywordPartialModeLossStarted = await windowsBrokerRequest("start", {
    sessionName: keywordPartialModeLossSession,
    command: process.execPath,
    args: [fixture, ...fixtureLedger.fixtureArgs],
    metadataCommand: process.execPath,
    metadataArgs: [fixture, ...fixtureLedger.fixtureArgs],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: {
      ...process.env,
      ...(fakeTerminalSeesPasteMarkers
        ? { RAIL_FAKE_CLAUDE_DISABLE_PASTE_AFTER_KEYWORD_BODY: "1" }
        : { RAIL_FAKE_CLAUDE_DISABLE_PASTE_AFTER_UNFRAMED_KEYWORD_BODY: "1" }),
      RAIL_FAKE_CLAUDE_WIRE_RECEIPT: keywordPartialModeLossWireReceipt,
    },
    leaseId: keywordPartialModeLossLease,
    leaseTtlMs: 10000,
  });
  const keywordPartialModeLossGenerationId =
    keywordPartialModeLossStarted.metadata.generationId;
  const keywordPartialModeLossStartedAtMs =
    keywordPartialModeLossStarted.metadata.startedAtMs;
  const keywordPartialModeLossReadyDeadline = Date.now() + 10000;
  let keywordPartialModeLossCapture = "";
  while (Date.now() < keywordPartialModeLossReadyDeadline) {
    keywordPartialModeLossCapture = (
      await windowsBrokerRequest("capture", {
        sessionName: keywordPartialModeLossSession,
        expectedGenerationId: keywordPartialModeLossGenerationId,
      })
    ).capture;
    if (keywordPartialModeLossCapture.includes("Fake Claude TUI")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(keywordPartialModeLossCapture, /Fake Claude TUI/);
  // Bundled ConPTY can exchange device attributes during startup. Bind this
  // assertion to the send operation, retaining every subsequent PTY write.
  const keywordPartialWritesBefore = (await brokerPtyWrites(keywordPartialModeLossSession)).length;
  const keywordPartialBody = `ultracode:${"x".repeat(255)}🧪${"y".repeat(600)}`;
  await assert.rejects(
    windowsBrokerRequest("sendText", {
      sessionName: keywordPartialModeLossSession,
      text: keywordPartialBody,
      keywordPrefix: true,
      bracketedPaste: true,
      chunkSize: 256,
      // Request zero pacing to prove keyword transport still enforces its
      // positive observation floor before a next chunk can be emitted.
      chunkDelayMs: 0,
      submit: true,
      leaseId: keywordPartialModeLossLease,
      expectedGenerationId: keywordPartialModeLossGenerationId,
    }),
    (error) =>
      error?.code === "EPASTEMODE" &&
      /Keyword body was partially sent.*no later body, closing frame, or Enter was sent/i.test(
        error.message
      )
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const keywordPartialModeLossWire = fs
    .readFileSync(keywordPartialModeLossWireReceipt, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .join("");
  if (fakeTerminalSeesPasteMarkers) {
    assert.equal(
      keywordPartialModeLossWire,
      `ultracode:\x1b[200~${"x".repeat(255)}`,
      "a body mode loss must stop before later chunks, the closing frame, or Enter"
    );
  } else {
    // Recorded, not asserted: whether the paste markers reached this terminal.
    console.log(`windows-broker: Node ${process.versions.node} fake terminal received paste markers: ${keywordPartialModeLossWire.includes("\x1b[200~")}`);
    assert.deepEqual(
      (await brokerPtyWrites(keywordPartialModeLossSession)).slice(keywordPartialWritesBefore),
      ["ultracode:", "\x1b[200~", "x".repeat(255)],
      "after a body mode loss the broker must write no later chunk, closing marker, or Enter"
    );
    assert.equal(
      keywordPartialModeLossWire.replaceAll("\x1b[200~", ""),
      `ultracode:${"x".repeat(255)}`,
      "the terminal must receive only the prefix and the first body chunk"
    );
  }
  for (const [operation, payload] of [
    ["sendText", {
      text: "must not append after a partial keyword body",
      submit: false,
      leaseId: keywordPartialModeLossLease,
      expectedGenerationId: keywordPartialModeLossGenerationId,
      expectedStartedAtMs: keywordPartialModeLossStartedAtMs,
    }],
    ["sendKey", {
      key: "Enter",
      leaseId: keywordPartialModeLossLease,
      expectedGenerationId: keywordPartialModeLossGenerationId,
      expectedStartedAtMs: keywordPartialModeLossStartedAtMs,
    }],
  ]) {
    await assert.rejects(
      windowsBrokerRequest(operation, {
        sessionName: keywordPartialModeLossSession,
        ...payload,
      }),
      (error) => error?.code === "ERECOVERY"
    );
  }
  const keywordPartialModeLossStopped = await windowsBrokerRequest("stop", {
    sessionName: keywordPartialModeLossSession,
    graceful: false,
    force: true,
    omitCapture: true,
    leaseId: keywordPartialModeLossLease,
    expectedGenerationId: keywordPartialModeLossGenerationId,
    expectedStartedAtMs: keywordPartialModeLossStartedAtMs,
  });
  assert.equal(keywordPartialModeLossStopped.status, "stopped");
  await renewOriginalFixtureLease();
  for (const payload of [
    { text: "quoted ultracode: body", bracketedPaste: true },
    { text: "ultracode: body\x1b[201~\r/exit", bracketedPaste: true },
    { text: "ultracode: body", bracketedPaste: false },
  ]) {
    await assert.rejects(windowsBrokerRequest("sendText", {
      sessionName, ...payload, keywordPrefix: true, submit: true, leaseId: firstLease,
      expectedGenerationId: activeGenerationId,
    }), error => ["EINVAL", "EPASTEMODE"].includes(error.code));
  }
  await windowsBrokerRequest("sendText", {
    sessionName,
    text: "broker key alias",
    submit: false,
    leaseId: firstLease,
    expectedGenerationId: activeGenerationId,
  });
  await windowsBrokerRequest("sendKey", {
    sessionName,
    key: "KPEnter",
    leaseId: firstLease,
    expectedGenerationId: activeGenerationId,
  });
  assert.match(
    await waitForCapture(/ACK:broker key alias/),
    /ACK:broker key alias/
  );
  await assert.rejects(
    windowsBrokerRequest("sendKey", {
      sessionName,
      key: "UnsupportedKey",
      leaseId: firstLease,
      expectedGenerationId: activeGenerationId,
    }),
    (error) => error?.code === "EINVAL"
  );
  const boundedDelayStartedAt = Date.now();
  await windowsBrokerRequest("sendText", {
    sessionName,
    text: "bounded broker delay",
    submit: true,
    chunkDelayMs: Number.MAX_SAFE_INTEGER,
    submitSettleMs: Number.MAX_SAFE_INTEGER,
    leaseId: firstLease,
    expectedGenerationId: activeGenerationId,
  });
  assert.ok(Date.now() - boundedDelayStartedAt < 3000);
  assert.match(await waitForCapture(/ACK:bounded broker delay/), /ACK:bounded broker delay/);
  await assert.rejects(
    windowsBrokerRequest("updateMetadata", {
      sessionName,
      resolvedSessionId: "55555555-5555-4555-8555-555555555555",
      expectedStartedAtMs: started.metadata.startedAtMs - 1,
      expectedGenerationId: "00000000-0000-4000-8000-000000000000",
      leaseId: firstLease,
    }),
    /generation changed/
  );
  const metadataUpdate = await windowsBrokerRequest("updateMetadata", {
    sessionName,
    resolvedSessionId: "55555555-5555-4555-8555-555555555555",
    expectedStartedAtMs: started.metadata.startedAtMs,
    expectedGenerationId: activeGenerationId,
    leaseId: firstLease,
  });
  assert.equal(metadataUpdate.status, "updated");
  await assert.rejects(
    windowsBrokerRequest("replace", {
      sessionName,
      command: process.execPath,
      args: [fixture, ...fixtureLedger.fixtureArgs],
      metadataCommand: process.execPath,
      metadataArgs: [fixture, ...fixtureLedger.fixtureArgs],
      cwd: repoRoot,
      canonicalCwd: canonicalRepoRoot,
      env: { ...process.env },
      resolvedSessionId: "44444444-4444-4444-8444-444444444444",
      graceful: true,
      force: true,
      leaseId: secondLease,
      expectedGenerationId: activeGenerationId,
    }),
    /leased by another MCP/
  );
  await assert.rejects(
    windowsBrokerRequest("replace", {
      sessionName,
      command: process.env.ComSpec,
      args: ["/d", "/c", "exit 0"],
      metadataCommand: process.env.ComSpec,
      metadataArgs: ["/d", "/c", "exit 0"],
      cwd: repoRoot,
      env: { ...process.env },
      graceful: true,
      force: true,
      leaseId: firstLease,
      expectedGenerationId: activeGenerationId,
    }),
    /does not match RAIL_CONNECTOR_CLAUDE_PATH/
  );
  assert.match(await waitForCapture(/Fake Claude TUI/), /Fake Claude TUI/);
  const vanishedReplacementCwd = path.join(
    stateDir,
    "vanished-replacement"
  );
  fs.mkdirSync(vanishedReplacementCwd);
  const vanishedReplacementCanonical =
    fs.realpathSync.native?.(vanishedReplacementCwd) ??
    fs.realpathSync(vanishedReplacementCwd);
  fs.rmdirSync(vanishedReplacementCwd);
  await assert.rejects(
    windowsBrokerRequest("replace", {
      sessionName,
      command: process.execPath,
      args: [fixture, ...fixtureLedger.fixtureArgs],
      metadataCommand: process.execPath,
      metadataArgs: [fixture, ...fixtureLedger.fixtureArgs],
      cwd: vanishedReplacementCwd,
      canonicalCwd: vanishedReplacementCanonical,
      env: { ...process.env },
      graceful: true,
      force: true,
      leaseId: firstLease,
      expectedGenerationId: activeGenerationId,
    }),
    (error) => error?.code === "ENOENT"
  );
  assert.match(await waitForCapture(/Fake Claude TUI/), /Fake Claude TUI/);
  const replacementPair = originalSessionPair;
  const replacementLease = await renewOriginalFixtureLease();
  const originalReplacementMetadata = (
    await windowsBrokerRequest("conditionalMetadata", {
      sessionName,
      ...replacementPair,
    })
  ).metadata;
  const invalidReplacementSessionId = "67676767-6767-4676-8676-676767676767";
  const invalidReplacementMetadata = [
    {
      name: "invalid launch environment shape",
      payload: { launchEnvironment: { ...launchEnvironment, evidenceScope: "untrusted" } },
      code: "ELAUNCHENV",
      message: /Invalid Claude child launch environment metadata/,
    },
    {
      name: "inconsistent launch environment",
      payload: { launchEnvironment: { ...launchEnvironment, status: "compatible" } },
      code: "ELAUNCHENV",
      message: /Inconsistent Claude child launch environment metadata/,
    },
    {
      name: "invalid fresh session UUID",
      payload: { freshSessionId: "not-a-uuid", resolvedSessionId: "not-a-uuid" },
      code: "ESESSIONIDENTITY",
      message: /must be the exact UUID/,
    },
    {
      name: "mismatched resolved session UUID",
      payload: {
        freshSessionId: invalidReplacementSessionId,
        resolvedSessionId: "78787878-7878-4787-8787-787878787878",
      },
      code: "ESESSIONIDENTITY",
      message: /must be the exact UUID/,
    },
    {
      name: "missing fresh session argument",
      payload: { freshSessionId: invalidReplacementSessionId, resolvedSessionId: invalidReplacementSessionId },
      code: "ESESSIONIDENTITY",
      message: /exactly one matching --session-id launch argument/,
    },
    {
      name: "mismatched fresh session argument",
      payload: { freshSessionId: invalidReplacementSessionId, resolvedSessionId: invalidReplacementSessionId },
      extraArgs: ["--session-id", "78787878-7878-4787-8787-787878787878"],
      code: "ESESSIONIDENTITY",
      message: /exactly one matching --session-id launch argument/,
    },
    {
      name: "duplicate fresh session arguments",
      payload: { freshSessionId: invalidReplacementSessionId, resolvedSessionId: invalidReplacementSessionId },
      extraArgs: ["--session-id", invalidReplacementSessionId, "--session-id", invalidReplacementSessionId],
      code: "ESESSIONIDENTITY",
      message: /exactly one matching --session-id launch argument/,
    },
    {
      name: "fresh session with continuation arguments",
      payload: { freshSessionId: invalidReplacementSessionId, resolvedSessionId: invalidReplacementSessionId },
      extraArgs: ["--session-id", invalidReplacementSessionId, "--resume", invalidReplacementSessionId],
      code: "ESESSIONIDENTITY",
      message: /cannot be combined with resume, continue, or fork arguments/,
    },
  ];
  for (const invalid of invalidReplacementMetadata) {
    const args = [fixture, ...fixtureLedger.fixtureArgs, ...(invalid.extraArgs ?? [])];
    await assert.rejects(
      windowsBrokerRequest("replace", {
        sessionName,
        command: process.execPath,
        args,
        metadataCommand: process.execPath,
        metadataArgs: args,
        cwd: repoRoot,
        canonicalCwd: canonicalRepoRoot,
        env: { ...process.env },
        requestedPosture: { permissionMode: "bypassPermissions" },
        resolvedPosture: { permissionMode: "bypassPermissions" },
        resolvedSessionId: invalidReplacementSessionId,
        graceful: true,
        force: true,
        leaseId: firstLease,
        ...replacementPair,
        ...invalid.payload,
      }),
      (error) => error?.code === invalid.code && invalid.message.test(error.message),
      `${invalid.name} must be rejected before stopping the original generation`
    );
    const metadata = (
      await windowsBrokerRequest("conditionalMetadata", {
        sessionName,
        ...replacementPair,
      })
    ).metadata;
    assert.deepEqual(metadata, originalReplacementMetadata, `${invalid.name} must preserve session state`);
    assert.doesNotThrow(() => process.kill(metadata.pid, 0), `${invalid.name} must leave the original process alive`);
    const competingLease = await windowsBrokerRequest("acquireLease", {
      sessionName,
      leaseId: secondLease,
      ttlMs: 10000,
      ...replacementPair,
    });
    assert.deepEqual(competingLease, {
      status: "busy",
      expiresAt: replacementLease.expiresAt,
      generationId: replacementPair.expectedGenerationId,
      startedAtMs: replacementPair.expectedStartedAtMs,
    }, `${invalid.name} must preserve the original mutation lease and its expiry`);
  }
  await windowsBrokerRequest("sendText", {
    sessionName,
    text: "original generation after rejected replacement",
    submit: true,
    chunkDelayMs: 0,
    submitSettleMs: 0,
    leaseId: firstLease,
    ...replacementPair,
  });
  assert.match(
    await waitForCapture(/ACK:original generation after rejected replacement/),
    /ACK:original generation after rejected replacement/
  );
  console.log("windows-broker: invalid replacement metadata preserves the original generation, state, process, and lease");
  const replaced = await windowsBrokerRequest("replace", {
    sessionName,
    command: process.execPath,
    args: [fixture, ...fixtureLedger.fixtureArgs],
    metadataCommand: process.execPath,
    metadataArgs: [fixture, ...fixtureLedger.fixtureArgs],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: { ...process.env },
    requestedPosture: { permissionMode: "bypassPermissions" },
    resolvedPosture: { permissionMode: "bypassPermissions" },
    resolvedSessionId: "44444444-4444-4444-8444-444444444444",
    graceful: true,
    force: true,
    leaseId: firstLease,
    expectedGenerationId: activeGenerationId,
  });
  assert.equal(replaced.status, "started");
  const priorGenerationId = activeGenerationId;
  activeGenerationId = replaced.metadata.generationId;
  assert.notEqual(activeGenerationId, priorGenerationId);
  await assert.rejects(
    windowsBrokerRequest("capture", {
      sessionName,
      requireExactPair: true,
      expectedGenerationId: priorGenerationId,
      expectedStartedAtMs: started.metadata.startedAtMs,
    }),
    (error) => error?.code === "ESTALE",
    "a strict capture must reject the original pair after same-name replacement"
  );
  assert.match(await waitForCapture(/Fake Claude TUI/), /Fake Claude TUI/);
  await assert.rejects(
    windowsBrokerRequest("acquireLease", {
      sessionName,
      leaseId: secondLease,
      ttlMs: 10000,
      expectedGenerationId: priorGenerationId,
    }),
    (error) => error?.code === "ESTALE"
  );
  for (const pair of [
    { expectedGenerationId: priorGenerationId, expectedStartedAtMs: replaced.metadata.startedAtMs },
    { expectedGenerationId: activeGenerationId, expectedStartedAtMs: replaced.metadata.startedAtMs - 1 },
  ]) {
    await assert.rejects(
      windowsBrokerRequest("releaseLease", { sessionName, leaseId: firstLease, ...pair }),
      (error) => error?.code === "ESTALE"
    );
  }
  await assert.rejects(
    windowsBrokerRequest("releaseLease", {
      sessionName, leaseId: firstLease, expectedGenerationId: activeGenerationId,
    }),
    (error) => error?.code === "EINVAL"
  );
  assert.equal((await windowsBrokerRequest("acquireLease", {
    sessionName, leaseId: secondLease, ttlMs: 10000,
    expectedGenerationId: activeGenerationId,
    expectedStartedAtMs: replaced.metadata.startedAtMs,
  })).status, "busy");
  assert.equal((await windowsBrokerRequest("releaseLease", {
    sessionName, leaseId: firstLease,
    expectedGenerationId: activeGenerationId,
    expectedStartedAtMs: replaced.metadata.startedAtMs,
  })).status, "released");
  await assert.rejects(
    windowsBrokerRequest("sendText", {
      sessionName,
      text: "unleased write",
      submit: true,
      expectedGenerationId: activeGenerationId,
    }),
    /requires an active broker lease/
  );
  await assert.rejects(
    windowsBrokerRequest("updateObservation", {
      sessionName,
      observedPosture: { permissionMode: "manual" },
      expectedStartedAtMs: replaced.metadata.startedAtMs - 1,
      expectedGenerationId: priorGenerationId,
    }),
    /generation changed/
  );
  const observationUpdate = await windowsBrokerRequest("updateObservation", {
    sessionName,
    observedPosture: { permissionMode: "bypassPermissions" },
    expectedStartedAtMs: replaced.metadata.startedAtMs,
    expectedGenerationId: activeGenerationId,
  });
  assert.equal(
    observationUpdate.metadata.observedPosture.permissionMode,
    "bypassPermissions"
  );

  const status = await probeWindowsBroker();
  assert.equal(status.compatible, true);
  assert.equal(status.launchPolicyCompatible, true);
  assert.equal(status.legacyPipe, false);
  assert.equal(status.managedSessions.some((session) => session.name === sessionName), true);
  assert.equal(
    status.managedSessions.find((session) => session.name === sessionName).resolvedSessionId,
    "44444444-4444-4444-8444-444444444444"
  );

  const exitLease = "exit-lease";
  assert.equal(
    (
      await windowsBrokerRequest("acquireLease", {
        sessionName,
        leaseId: exitLease,
        ttlMs: 10000,
      })
    ).status,
    "acquired"
  );
  await assert.rejects(windowsBrokerRequest("sendText", {
    sessionName,
    text: "/exit",
    submit: true,
    leaseId: exitLease,
    expectedGenerationId: activeGenerationId,
  }), /session has exited/, "a numeric exit during the final settle must not report sent");
  const exitDeadline = Date.now() + 5000;
  let exitedSession = null;
  while (!exitedSession?.exited && Date.now() < exitDeadline) {
    const exitStatus = await probeWindowsBroker();
    exitedSession = exitStatus?.managedSessions.find(
      (session) => session.name === sessionName
    );
    if (!exitedSession?.exited) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(exitedSession?.exited, true);
  const cleaned = await windowsBrokerRequest("stop", {
    sessionName,
    graceful: false,
    force: false,
    expectedGenerationId: activeGenerationId,
  });
  assert.equal(cleaned.status, "not_running");
  assert.equal(
    (await probeWindowsBroker()).managedSessions.some(
      (session) => session.name === sessionName
    ),
    false
  );
  const stubbornSession = `${sessionName}_stubborn`;
  const stubbornLease = "stubborn-lease";
  const stubbornStarted = await windowsBrokerRequest("start", {
    sessionName: stubbornSession,
    command: process.execPath,
    args: [fixture, ...fixtureLedger.fixtureArgs],
    metadataCommand: process.execPath,
    metadataArgs: [fixture, ...fixtureLedger.fixtureArgs],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: { ...process.env, RAIL_CONNECTOR_FAKE_CLAUDE_IGNORE_EXIT: "1" },
    leaseId: stubbornLease,
    leaseTtlMs: 10000,
  });
  assert.equal(stubbornStarted.status, "started");
  const missingStopMode = await windowsBrokerRequest("stop", {
    sessionName: stubbornSession,
    graceful: false,
    force: false,
    omitCapture: true,
    leaseId: stubbornLease,
    expectedGenerationId: stubbornStarted.metadata.generationId,
    expectedStartedAtMs: stubbornStarted.metadata.startedAtMs,
  });
  assert.equal(missingStopMode.status, "stop_blocked");
  assert.equal(missingStopMode.reason, "stop_mode_required");
  assert.equal(
    (await probeWindowsBroker()).managedSessions.find(
      (session) => session.name === stubbornSession
    )?.exited,
    false
  );
  const cleanupTimeout = await windowsBrokerRequest("stop", {
    sessionName: stubbornSession,
    graceful: true,
    force: false,
    omitCapture: true,
    leaseId: stubbornLease,
    expectedGenerationId: stubbornStarted.metadata.generationId,
    expectedStartedAtMs: stubbornStarted.metadata.startedAtMs,
  });
  assert.equal(cleanupTimeout.status, "graceful_stop_timeout");
  assert.equal(Object.hasOwn(cleanupTimeout, "capture"), false);
  const cleanupStop = await windowsBrokerRequest("stop", {
    sessionName: stubbornSession,
    graceful: false,
    force: true,
    omitCapture: true,
    leaseId: stubbornLease,
    expectedGenerationId: stubbornStarted.metadata.generationId,
    expectedStartedAtMs: stubbornStarted.metadata.startedAtMs,
  });
  assert.equal(cleanupStop.status, "stopped");
  assert.equal(Object.hasOwn(cleanupStop, "capture"), false);

  const compatibilitySession = `${sessionName}_compat_cleanup`;
  const compatibilityStartLease = "compatibility-start-lease";
  const compatibilityStarted = await windowsBrokerRequest("start", {
    sessionName: compatibilitySession,
    command: process.execPath,
    args: [fixture, ...fixtureLedger.fixtureArgs],
    metadataCommand: process.execPath,
    metadataArgs: [fixture, ...fixtureLedger.fixtureArgs],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: { ...process.env },
    leaseId: compatibilityStartLease,
    leaseTtlMs: 10000,
  });
  assert.equal(compatibilityStarted.status, "started");
  await windowsBrokerRequest("releaseLease", {
    sessionName: compatibilitySession,
    leaseId: compatibilityStartLease,
  });
  const incompatibleClientEnv = {
    ...process.env,
    RAIL_CONNECTOR_CLAUDE_PATH: path.join(
      stateDir,
      "different-claude.exe"
    ),
  };
  assert.equal(
    (await probeWindowsBroker(incompatibleClientEnv)).compatible,
    false
  );
  await assert.rejects(
    windowsBrokerCleanupRequest(
      "acquireCleanupLease",
      {
        sessionName: compatibilitySession,
        leaseId: "compatibility-cleanup-lease",
        ttlMs: 10000,
        expectedGenerationId:
          "00000000-0000-4000-8000-000000000000",
      },
      { env: incompatibleClientEnv }
    ),
    (error) => error?.code === "ESTALE"
  );
  const compatibilityCleanupLease =
    await windowsBrokerCleanupRequest(
      "acquireCleanupLease",
      {
        sessionName: compatibilitySession,
        leaseId: "compatibility-cleanup-lease",
        ttlMs: 10000,
        expectedGenerationId:
          compatibilityStarted.metadata.generationId,
      },
      { env: incompatibleClientEnv }
    );
  assert.equal(compatibilityCleanupLease.status, "acquired");
  await assert.rejects(
    windowsBrokerCleanupRequest("releaseCleanupLease", {
      sessionName: compatibilitySession,
      leaseId: "compatibility-cleanup-lease",
      expectedGenerationId: compatibilityStarted.metadata.generationId,
      expectedStartedAtMs: compatibilityStarted.metadata.startedAtMs - 1,
    }, { env: incompatibleClientEnv }),
    (error) => error?.code === "ESTALE"
  );
  const compatibilityCleanup = await windowsBrokerCleanupRequest(
    "cleanupStop",
    {
      sessionName: compatibilitySession,
      leaseId: "compatibility-cleanup-lease",
      expectedGenerationId:
        compatibilityStarted.metadata.generationId,
    },
    { timeoutMs: 20000, env: incompatibleClientEnv }
  );
  assert.equal(compatibilityCleanup.status, "stopped");
  assert.equal(Object.hasOwn(compatibilityCleanup, "capture"), false);

  const activeBrokerToken = fs
    .readFileSync(windowsBrokerPaths(process.env).tokenFile, "utf8")
    .trim();
  const idleSocket = net.createConnection(
    windowsBrokerPaths(process.env, activeBrokerToken).pipeName
  );
  await new Promise((resolve, reject) => {
    idleSocket.once("connect", resolve);
    idleSocket.once("error", reject);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Idle broker connection did not time out.")),
      5000
    );
    idleSocket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const raceSession = `${sessionName}_shutdown_race`;
  const raceLease = "shutdown-race-lease";
  const [raceStart, raceShutdown] = await Promise.allSettled([
    windowsBrokerRequest("start", {
      sessionName: raceSession,
      command: process.execPath,
      args: [fixture, ...fixtureLedger.fixtureArgs],
      metadataCommand: process.execPath,
      metadataArgs: [fixture, ...fixtureLedger.fixtureArgs],
      cwd: repoRoot,
      canonicalCwd: canonicalRepoRoot,
      env: { ...process.env },
      leaseId: raceLease,
      leaseTtlMs: 10000,
    }),
    windowsBrokerRequest("shutdown", {}, { startIfMissing: false }),
  ]);
  assert.equal(
    raceStart.status === "fulfilled" && raceShutdown.status === "fulfilled",
    false,
    "shutdown and a racing start must not both succeed"
  );
  let shutdown;
  if (raceStart.status === "fulfilled") {
    assert.equal(raceStart.value.status, "started");
    assert.equal(raceShutdown.status, "rejected");
    assert.match(
      raceShutdown.reason?.message ?? "",
      /sessions are running/
    );
    await windowsBrokerRequest("stop", {
      sessionName: raceSession,
      graceful: false,
      force: true,
      omitCapture: true,
      leaseId: raceLease,
      expectedGenerationId: raceStart.value.metadata.generationId,
    });
    shutdown = await windowsBrokerRequest(
      "shutdown",
      {},
      { startIfMissing: false }
    );
  } else {
    assert.equal(raceShutdown.status, "fulfilled");
    shutdown = raceShutdown.value;
  }
  assert.equal(shutdown.status, "shutting_down");
  const shutdownDeadline = Date.now() + 5000;
  while ((await probeWindowsBroker()) && Date.now() < shutdownDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await probeWindowsBroker(), null);
  await new Promise((resolve) => setTimeout(resolve, 300));
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  let cleanupError = null;
  const cleanupEnvironment = { ...process.env };
  // Never leave synthetic held callbacks armed when a failed assertion causes
  // the fixture ledger to terminate its owned children.
  try {
    const control = path.join(stateDir, "broker-error-control.json");
    if (fs.existsSync(control)) {
      const stat = fs.lstatSync(control);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
      fs.unlinkSync(control);
    }
    fs.writeFileSync(control, JSON.stringify({ id: "cleanup", kind: "disarm", stage: "setup" }), { flag: "wx" });
    try {
      await windowsBrokerRequest("ping", {}, { env: cleanupEnvironment, startIfMissing: false, timeoutMs: 2000 });
      const receipts = path.join(stateDir, "broker-error-receipts.jsonl");
      const deadline = Date.now() + 2000;
      let acknowledged = false;
      do {
        acknowledged = fs.existsSync(receipts) && fs.readFileSync(receipts, "utf8").split("\n").slice(0, -1)
          .filter(Boolean).map((line) => JSON.parse(line)).some((entry) => entry.id === "cleanup" && entry.kind === "disarm");
        if (acknowledged) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      assert.ok(acknowledged, "owned fault cleanup was not acknowledged");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  } catch (error) { cleanupError ??= error; }
  for (const ledger of fixtureLedgers) {
    try { await ledger.reap({ expectRecords: false, final: true }); }
    catch (error) { cleanupError ??= error; }
  }
  // The real output-socket destruction case can consume public onExit before
  // native exit. Only after retained-handle cleanup may the test-only preload
  // forward its independently captured numeric native exit to settle tracking.
  if (!cleanupError) try {
    const deadline = Date.now() + 2000;
    let index = 0;
    for (;;) {
      const status = await probeWindowsBroker(cleanupEnvironment);
      if (!status || status.managedSessions.every((session) => session.exited)) break;
      const control = path.join(stateDir, "broker-error-control.json");
      fs.writeFileSync(control, JSON.stringify({ id: `cleanup-native-${index++}`, kind: "cleanupNativeExits", stage: "setup" }), { flag: "wx" });
      await windowsBrokerRequest("ping", {}, { env: cleanupEnvironment, startIfMissing: false, timeoutMs: 2000 });
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } catch (error) { cleanupError ??= error; }
  try {
    const deadline = Date.now() + 5000;
    let status;
    do {
      status = await probeWindowsBroker(cleanupEnvironment);
      if (!status || status.managedSessions.every((session) => session.exited)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    if (status) {
      assert.ok(status.managedSessions.every((session) => session.exited), "dedicated broker still has a running test fixture");
      await windowsBrokerRequest("shutdown", {}, { env: cleanupEnvironment, startIfMissing: false, timeoutMs: 5000 });
      const shutdownDeadline = Date.now() + 5000;
      while ((await probeWindowsBroker(cleanupEnvironment)) && Date.now() < shutdownDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(await probeWindowsBroker(cleanupEnvironment), null, "dedicated broker must exit before cleanup");
    }
  } catch (error) { cleanupError ??= error; }
  if (!cleanupError) {
    for (const ledger of fixtureLedgers) {
      try { await ledger.reap({ expectRecords: false, graceMs: 0 }); }
      catch (error) { cleanupError ??= error; }
    }
  }
  if (olderVersionServer) {
    await new Promise((resolve) => olderVersionServer.close(resolve));
  }
  if (legacyServer) {
    await new Promise((resolve) => legacyServer.close(resolve));
  }
  if (previousStateDir === undefined) delete process.env.RAIL_CONNECTOR_STATE_DIR;
  else process.env.RAIL_CONNECTOR_STATE_DIR = previousStateDir;
  if (previousClaudePath === undefined) delete process.env.RAIL_CONNECTOR_CLAUDE_PATH;
  else process.env.RAIL_CONNECTOR_CLAUDE_PATH = previousClaudePath;
  for (const [key, value] of Object.entries(previousFixtureEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = previousNodeOptions;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousBrokerErrorDir === undefined) delete process.env.RAIL_TEST_BROKER_ERROR_DIR;
  else process.env.RAIL_TEST_BROKER_ERROR_DIR = previousBrokerErrorDir;
  if (!fakeTerminalSeesPasteMarkers) {
    delete process.env.RAIL_TEST_PTY_WRITE_RECEIPT;
  }
  if (!cleanupError && !primaryError) {
    try {
      const canonicalState = fs.realpathSync(stateDir);
      assert.equal(path.dirname(canonicalState).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
      assert.match(path.basename(canonicalState), /^rail-connector-broker-/);
      fs.rmSync(canonicalState, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (error) { cleanupError = error; }
  }
  if (primaryError) primaryError.message += `\nSynthetic broker diagnostics preserved at ${stateDir}`;
  if (cleanupError) {
    if (primaryError) primaryError.message += `\nFixture cleanup also failed: ${cleanupError.message}`;
    else throw cleanupError;
  }
}

console.log("windows-broker ok");
await import("./windows-broker-timeout.mjs");
