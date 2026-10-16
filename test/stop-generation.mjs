import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { windowsBrokerRequest } from "../src/windows-broker-client.js";
import { createFixtureProcessLedger } from "./fixtures/fixture-process-ledger.mjs";
import {
  createPortableWaitCursor,
  expectedManagedGeneration,
  expectedStopIdentity,
  expectedStopGeneration,
  parsePortableWaitCursor,
} from "../src/index.js";

assert.equal(expectedStopGeneration({}), null);
assert.throws(
  () => expectedStopGeneration({ expectedGenerationId: "00000000-0000-4000-8000-000000000000" }),
  (error) => error?.code === "EINVAL"
);
assert.throws(
  () => expectedStopGeneration({ expectedStartedAtMs: 1 }),
  (error) => error?.code === "EINVAL"
);
assert.throws(
  () => expectedStopGeneration({
    expectedGenerationId: "not-a-generation",
    expectedStartedAtMs: 1,
  }),
  (error) => error?.code === "EINVAL"
);
assert.deepEqual(
  expectedStopGeneration({
    expectedGenerationId: "00000000-0000-4000-8000-000000000000",
    expectedStartedAtMs: 1,
  }),
  {
    expectedGenerationId: "00000000-0000-4000-8000-000000000000",
    expectedStartedAtMs: 1,
  }
);
assert.throws(
  () => expectedStopIdentity({
    expectedGenerationId: "00000000-0000-4000-8000-000000000000",
    expectedStartedAtMs: 1,
    expectedResolvedSessionId: "11111111-1111-4111-8111-111111111111",
  }),
  (error) => error?.code === "EINVAL"
);
const expectedIdentityCwd = path.resolve("identity-workspace");
assert.deepEqual(
  expectedStopIdentity({
    expectedGenerationId: "00000000-0000-4000-8000-000000000000",
    expectedStartedAtMs: 1,
    expectedResolvedSessionId: "11111111-1111-4111-8111-111111111111",
    expectedCanonicalCwd: expectedIdentityCwd,
  }),
  {
    expectedGenerationId: "00000000-0000-4000-8000-000000000000",
    expectedStartedAtMs: 1,
    expectedResolvedSessionId: "11111111-1111-4111-8111-111111111111",
    expectedCanonicalCwd:
      process.platform === "win32" ? expectedIdentityCwd.toLowerCase() : expectedIdentityCwd,
  }
);
assert.deepEqual(
  expectedManagedGeneration({
    expectedGenerationId: "00000000-0000-4000-8000-000000000000",
    expectedStartedAtMs: 1,
  }),
  {
    expectedGenerationId: "00000000-0000-4000-8000-000000000000",
    expectedStartedAtMs: 1,
  }
);

if (process.platform !== "win32") {
  console.log("stop-generation skipped on non-Windows");
  process.exit(0);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-stop-generation-"));
const workspace = repoRoot;
const canonicalWorkspace = fs.realpathSync.native?.(workspace) ?? fs.realpathSync(workspace);
const stateDir = path.join(root, "state");
const boundaryHookDir = path.join(stateDir, "test-boundary-hooks");
const configDir = path.join(root, "config");
const fixture = path.join(repoRoot, "test", "fixtures", "fake-claude-tui.mjs");
const fixtureLedger = await createFixtureProcessLedger({ directory: path.join(root, "fixture-processes"), fixturePath: fixture });
const fixtureLedgers = new Set([fixtureLedger]);
const wrapper = path.join(root, "fake-claude.cmd");
const managedSession = `stop_generation_${process.pid}`;
fs.writeFileSync(
  wrapper,
  [
    "@echo off",
    `\"${process.execPath}\" \"${fixture}\" ${fixtureLedger.fixtureArgs.join(" ")} %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n")
);
fs.mkdirSync(boundaryHookDir, { recursive: true });

const environment = {
  ...process.env,
  ...fixtureLedger.environment,
  NODE_ENV: "test",
  RAIL_CONNECTOR_CLAUDE_PATH: wrapper,
  RAIL_CONNECTOR_STATE_DIR: stateDir,
  RAIL_TEST_PAIRED_BOUNDARY_HOOK_DIR: boundaryHookDir,
  CLAUDE_CONFIG_DIR: configDir,
  RAIL_CONNECTOR_ALLOWED_ROOTS: [root, workspace].join(path.delimiter),
  RAIL_FAKE_CLAUDE_WIRE_RECEIPT: path.join(root, "fixture-wire.jsonl"),
  RAIL_FAKE_CLAUDE_EXIT_TRACE: path.join(root, "fixture-exit-trace.jsonl"),
};
const cleanupEnvironments = [environment];
const publicationProbePath = path.join(root, "boundary-publication-probe.mjs");
fs.writeFileSync(publicationProbePath, [
  'import fs from "node:fs";',
  'import path from "node:path";',
  "(" + installBoundaryPublicationProbe.toString() + ")(" + JSON.stringify(boundaryHookDir) + ");",
  "",
].join("\n"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", pathToFileURL(publicationProbePath).href, "src/index.js"],
  cwd: repoRoot,
  env: environment,
  stderr: "pipe",
});
const client = new Client(
  { name: "rail-connector-stop-generation", version: "1.0.0" },
  { capabilities: {} }
);

function contentText(result) {
  return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

function safeStartupFailureDetails(start) {
  const capture = typeof start?.capture === "string" ? start.capture : "";
  return JSON.stringify({
    status: typeof start?.status === "string" ? start.status : null,
    exitCode: Number.isInteger(start?.exitCode) ? start.exitCode : null,
    captureCharacters: capture.length,
    captureSha256: createHash("sha256").update(capture).digest("hex"),
    hasFixtureBanner: capture.includes("Fake Claude TUI"),
    hasFixtureGoodbye: capture.includes("Goodbye"),
    hasFixtureStartupExit: capture.includes("fixture exited before Remote Control became ready"),
    signalState: typeof start?.signals?.state === "string" ? start.signals.state : null,
  });
}

async function callTool(name, args) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
}

async function brokerStatus() {
  return windowsBrokerRequest("status", {}, {
    env: environment,
    startIfMissing: false,
    timeoutMs: 5000,
  });
}

function brokerGenerationPair(metadata) {
  return {
    expectedGenerationId: metadata.generationId,
    expectedStartedAtMs: metadata.startedAtMs,
  };
}

function directFixtureLaunch(sessionName, leaseId, {
  sessionId = null,
  wireReceipt = "",
  banner = "",
  launchEnvironment = environment,
} = {}) {
  const metadataArgs = sessionId ? ["--session-id", sessionId] : [];
  const commandProcessor = process.env.ComSpec || path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "cmd.exe"
  );
  const quoteCommandLineValue = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const innerCommandLine = [
    quoteCommandLineValue(wrapper),
    ...metadataArgs.map(quoteCommandLineValue),
  ].join(" ");
  const canonicalWorkspace =
    fs.realpathSync.native?.(workspace) ?? fs.realpathSync(workspace);
  return {
    sessionName,
    command: commandProcessor,
    args: [],
    metadataCommand: wrapper,
    metadataArgs,
    commandLine: `/d /s /v:off /c "${innerCommandLine}"`,
    cwd: workspace,
    canonicalCwd: canonicalWorkspace,
    env: {
      ...launchEnvironment,
      ...(wireReceipt ? { RAIL_FAKE_CLAUDE_WIRE_RECEIPT: wireReceipt } : {}),
      ...(banner ? { RAIL_FAKE_CLAUDE_BANNER: banner } : {}),
    },
    ...(sessionId
      ? { freshSessionId: sessionId, resolvedSessionId: sessionId }
      : {}),
    leaseId,
    leaseTtlMs: 10000,
  };
}

async function waitForDirectFixtureReady(sessionName, metadata, banner, launchEnvironment = environment) {
  const expected = brokerGenerationPair(metadata);
  const deadline = performance.now() + 5000;
  do {
    const captured = await windowsBrokerRequest("capture", {
      sessionName,
      ...expected,
      lines: 40,
    }, { env: launchEnvironment, startIfMissing: false });
    if (captured.capture.includes(banner)) return;
    if (performance.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (true);
  assert.fail(`fixture ${sessionName} did not become ready with banner ${banner}`);
}

async function releaseDirectFixtureLease(sessionName, leaseId, metadata) {
  const released = await windowsBrokerRequest("releaseLease", {
    sessionName,
    leaseId,
    ...brokerGenerationPair(metadata),
  }, { env: environment, startIfMissing: false });
  assert.equal(released.status, "released");
}

async function acquireDirectFixtureLease(sessionName, leaseId, metadata) {
  const acquired = await windowsBrokerRequest("acquireLease", {
    sessionName,
    leaseId,
    ttlMs: 10000,
    ...brokerGenerationPair(metadata),
  }, { env: environment, startIfMissing: false });
  assert.equal(acquired.status, "acquired");
}

async function stopDirectFixture(sessionName, leaseId, metadata) {
  const stopped = await windowsBrokerRequest("stop", {
    sessionName,
    graceful: false,
    force: true,
    omitCapture: true,
    leaseId,
    ...brokerGenerationPair(metadata),
  }, { env: environment, startIfMissing: false, timeoutMs: 30000 });
  assert.equal(stopped.status, "stopped");
}

function appendCleanupFailure(primaryError, cleanupError) {
  if (!primaryError) throw cleanupError;
  primaryError.message += `\nFixture cleanup also failed: ${cleanupError.message}`;
}

async function forceStopExactDirectFixture(sessionName, expected, tracked) {
  const status = await windowsBrokerRequest("status", {}, {
    env: environment,
    startIfMissing: false,
    timeoutMs: 5000,
  });
  const matches = status.managedSessions.filter((session) => session.name === sessionName);
  if (matches.length === 0) return;
  assert.equal(matches.length, 1, "direct fixture cleanup requires one exact managed-session name");
  const active = matches[0];
  if (active.exited) return;
  assert.equal(active.resolvedSessionId, expected.resolvedSessionId);
  assert.equal(active.canonicalCwd, expected.canonicalCwd);
  if (tracked.metadata) {
    assert.deepEqual(
      brokerGenerationPair(active),
      brokerGenerationPair(tracked.metadata),
      "direct fixture cleanup must retain the tracked generation"
    );
  }
  let leaseId = tracked.leaseId;
  if (!leaseId) {
    leaseId = `${sessionName}_cleanup_lease`;
    await acquireDirectFixtureLease(sessionName, leaseId, active);
    tracked.leaseId = leaseId;
  }
  const stopped = await windowsBrokerRequest("stop", {
    sessionName,
    ...brokerGenerationPair(active),
    expectedResolvedSessionId: expected.resolvedSessionId,
    expectedCanonicalCwd: expected.canonicalCwd,
    leaseId,
    requireExactPair: true,
    graceful: false,
    force: true,
    omitCapture: true,
  }, { env: environment, startIfMissing: false, timeoutMs: 30000 });
  assert.equal(stopped.status, "stopped");
  assert.equal(
    (await windowsBrokerRequest("status", {}, {
      env: environment,
      startIfMissing: false,
      timeoutMs: 5000,
    })).managedSessions.some((session) => session.name === sessionName),
    false,
    "direct fixture cleanup must leave no managed session"
  );
}

async function exactStopIdentityCoverage() {
  const sessionName = "exact_stop_identity_" + process.pid;
  const startLease = "exact-identity-start";
  const mutationLease = "exact-identity-mutation";
  const firstSessionId = "11111111-1111-4111-8111-111111111111";
  const secondSessionId = "22222222-2222-4222-8222-222222222222";
  const expected = { resolvedSessionId: firstSessionId, canonicalCwd: canonicalWorkspace };
  const tracked = { metadata: null, leaseId: startLease };
  let primaryError = null;
  try {
    const started = await windowsBrokerRequest(
      "start",
      directFixtureLaunch(sessionName, startLease, { sessionId: firstSessionId }),
      { env: environment, startIfMissing: false }
    );
    const metadata = started.metadata;
    tracked.metadata = metadata;
    await waitForDirectFixtureReady(sessionName, metadata, "Fake Claude TUI");
    const canonicalCwd = canonicalWorkspace;
    await releaseDirectFixtureLease(sessionName, startLease, metadata);
    tracked.leaseId = null;
    await acquireDirectFixtureLease(sessionName, mutationLease, metadata);
    tracked.leaseId = mutationLease;
    const pair = brokerGenerationPair(metadata);
    const exact = {
      ...pair,
      expectedResolvedSessionId: firstSessionId,
      expectedCanonicalCwd: canonicalCwd,
      leaseId: mutationLease,
      requireExactPair: true,
    };
    const initial = await windowsBrokerRequest(
    "conditionalStopMetadata",
    { sessionName, ...exact },
    { env: environment, startIfMissing: false }
    );
    assert.deepEqual(initial.boundIdentity, {
      generationId: metadata.generationId,
      startedAtMs: metadata.startedAtMs,
      resolvedSessionId: firstSessionId,
      canonicalCwd,
    });
    const blocked = await windowsBrokerRequest(
    "stop",
    {
      sessionName,
      ...exact,
      graceful: false,
      force: false,
      omitCapture: true,
    },
    { env: environment, startIfMissing: false }
    );
    assert.equal(blocked.status, "stop_blocked");
    assert.equal(
    Object.hasOwn(blocked, "boundIdentity"),
    false,
    "a blocked stop must not echo an exact identity"
    );

    await windowsBrokerRequest(
    "updateMetadata",
    { sessionName, ...pair, leaseId: mutationLease, resolvedSessionId: secondSessionId },
    { env: environment, startIfMissing: false }
    );
    expected.resolvedSessionId = secondSessionId;
    await assert.rejects(
    windowsBrokerRequest(
      "stop",
      {
        sessionName,
        ...exact,
        graceful: true,
        force: false,
        omitCapture: true,
      },
      { env: environment, startIfMissing: false }
    ),
    (error) => {
      assert.equal(Object.hasOwn(error ?? {}, "boundIdentity"), false);
      return error?.code === "ESTALE";
    },
    "same generation with a changed conversation UUID must refuse the direct exact stop"
    );
    const stillRunningAfterStaleUuid = await windowsBrokerRequest(
    "conditionalStopMetadata",
    {
      sessionName,
      ...pair,
      expectedResolvedSessionId: secondSessionId,
      expectedCanonicalCwd: canonicalCwd,
      leaseId: mutationLease,
      requireExactPair: true,
    },
    { env: environment, startIfMissing: false }
    );
    assert.equal(stillRunningAfterStaleUuid.metadata.exited, false);
    await assert.rejects(
    windowsBrokerRequest(
      "stop",
      {
        sessionName,
        ...exact,
        expectedResolvedSessionId: secondSessionId,
        expectedCanonicalCwd: path.join(canonicalCwd, "wrong-cwd"),
        graceful: true,
        force: false,
        omitCapture: true,
      },
      { env: environment, startIfMissing: false }
    ),
    (error) => {
      assert.equal(Object.hasOwn(error ?? {}, "boundIdentity"), false);
      return error?.code === "ESTALE";
    },
    "same generation with a changed canonical cwd expectation must refuse the direct exact stop"
    );
    const stillRunningAfterStaleCwd = await windowsBrokerRequest(
    "conditionalStopMetadata",
    {
      sessionName,
      ...pair,
      expectedResolvedSessionId: secondSessionId,
      expectedCanonicalCwd: canonicalCwd,
      leaseId: mutationLease,
      requireExactPair: true,
    },
    { env: environment, startIfMissing: false }
    );
    assert.equal(stillRunningAfterStaleCwd.metadata.exited, false);
    const stopped = await windowsBrokerRequest(
    "stop",
    {
      sessionName,
      ...pair,
      expectedResolvedSessionId: secondSessionId,
      expectedCanonicalCwd: canonicalCwd,
      leaseId: mutationLease,
      requireExactPair: true,
      graceful: true,
      force: false,
      omitCapture: true,
    },
    { env: environment, startIfMissing: false, timeoutMs: 30000 }
    );
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.graceful, true);
    assert.deepEqual(stopped.boundIdentity, {
      generationId: metadata.generationId,
      startedAtMs: metadata.startedAtMs,
      resolvedSessionId: secondSessionId,
      canonicalCwd,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await forceStopExactDirectFixture(sessionName, expected, tracked);
    } catch (cleanupError) {
      appendCleanupFailure(primaryError, cleanupError);
    }
  }
}

function exactPublicStopArguments(sessionName, metadata, { graceful, force }) {
  return {
    managedSession: sessionName,
    graceful,
    force,
    ...brokerGenerationPair(metadata),
    expectedResolvedSessionId: metadata.resolvedSessionId,
    expectedCanonicalCwd: metadata.canonicalCwd,
  };
}

async function forceStopOwnedPublicFixture(call, status, owned) {
  const matches = (await status()).managedSessions.filter((session) => session.name === owned.sessionName);
  if (matches.length === 0) return;
  assert.equal(matches.length, 1, "public fixture cleanup requires one exact managed-session name");
  const active = matches[0];
  if (active.exited) return;
  assert.deepEqual(
    brokerGenerationPair(active),
    owned.expectedGeneration,
    "cleanup must retain the original fixture-owned managed generation"
  );
  assert.deepEqual(
    { resolvedSessionId: active.resolvedSessionId, canonicalCwd: active.canonicalCwd },
    {
      resolvedSessionId: owned.expectedResolvedSessionId,
      canonicalCwd: owned.expectedCanonicalCwd,
    },
    "cleanup must bind the exact fixture-owned session identity"
  );
  const stopped = await call(
    "stop_remote_control",
    exactPublicStopArguments(owned.sessionName, active, { graceful: false, force: true })
  );
  assert.equal(stopped.isError, undefined, contentText(stopped));
  const result = JSON.parse(contentText(stopped));
  assert.equal(result.status, "stopped");
  assert.equal(result.graceful, false);
  assert.equal(Object.hasOwn(result, "boundIdentity"), false);
  assert.equal(
    (await status()).managedSessions.some((session) => session.name === owned.sessionName),
    false,
    "fixture-owned cleanup must leave no managed session"
  );
}

async function publicStopIdentityCoverage() {
  const original = {
    sessionName: "synthetic_cleanup_generation",
    expectedResolvedSessionId: randomUUID(), expectedCanonicalCwd: canonicalWorkspace,
    expectedGeneration: { expectedGenerationId: randomUUID(), expectedStartedAtMs: 1 },
  };
  let replacementStopCalled = false;
  await assert.rejects(forceStopOwnedPublicFixture(
    async () => { replacementStopCalled = true; },
    async () => ({ managedSessions: [{ name: original.sessionName, exited: false,
      resolvedSessionId: original.expectedResolvedSessionId, canonicalCwd: original.expectedCanonicalCwd,
      generationId: randomUUID(), startedAtMs: 2 }] }),
    original
  ), /original fixture-owned managed generation/);
  assert.equal(replacementStopCalled, false, "cleanup must never dispatch a stop for a replacement generation");
  const owned = new Map();
  const gracefulFixture = {
    sessionName: `public_exact_graceful_${process.pid}`,
    expectedResolvedSessionId: randomUUID(),
    expectedCanonicalCwd: canonicalWorkspace,
  };
  const forcedFixture = {
    sessionName: `public_exact_forced_${process.pid}`,
    expectedResolvedSessionId: randomUUID(),
    expectedCanonicalCwd: canonicalWorkspace,
  };
  let primaryError = null;
  async function startPublicFixture(fixture) {
    owned.set(fixture.sessionName, fixture);
    const started = await callTool("start_remote_control", {
      cwd: workspace,
      managedSession: fixture.sessionName,
      newSessionId: fixture.expectedResolvedSessionId,
      permissionMode: "plan",
      trustWorkspace: false,
    });
    assert.equal(started.isError, undefined, contentText(started));
    const startResult = JSON.parse(contentText(started));
    const metadata = (await brokerStatus()).managedSessions.find(
      (session) => session.name === fixture.sessionName
    );
    assert.ok(metadata?.generationId);
    assert.ok(Number.isSafeInteger(metadata?.startedAtMs));
    assert.equal(metadata?.resolvedSessionId, fixture.expectedResolvedSessionId);
    assert.equal(metadata?.canonicalCwd, fixture.expectedCanonicalCwd);
    assert.deepEqual(startResult.sessionBinding, {
      generationId: metadata.generationId,
      startedAtMs: metadata.startedAtMs,
    });
    fixture.expectedGeneration = brokerGenerationPair(metadata);
    return metadata;
  }

  try {
    const gracefulMetadata = await startPublicFixture(gracefulFixture);
    const graceful = await callTool(
      "stop_remote_control",
      exactPublicStopArguments(gracefulFixture.sessionName, gracefulMetadata, { graceful: true, force: false })
    );
    assert.equal(graceful.isError, undefined, contentText(graceful));
    const gracefulResult = JSON.parse(contentText(graceful));
    assert.equal(gracefulResult.status, "stopped");
    assert.equal(gracefulResult.graceful, true);
    assert.deepEqual(gracefulResult.boundIdentity, {
      generationId: gracefulMetadata.generationId,
      startedAtMs: gracefulMetadata.startedAtMs,
      resolvedSessionId: gracefulMetadata.resolvedSessionId,
      canonicalCwd: gracefulMetadata.canonicalCwd,
    });

    const forcedMetadata = await startPublicFixture(forcedFixture);
    const forced = await callTool(
      "stop_remote_control",
      exactPublicStopArguments(forcedFixture.sessionName, forcedMetadata, { graceful: false, force: true })
    );
    assert.equal(forced.isError, undefined, contentText(forced));
    const forcedResult = JSON.parse(contentText(forced));
    assert.equal(forcedResult.status, "stopped");
    assert.equal(forcedResult.graceful, false);
    assert.equal(
      Object.hasOwn(forcedResult, "boundIdentity"),
      false,
      "a non-graceful public stop must not echo an exact identity"
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError = null;
    for (const fixture of owned.values()) {
      try {
        await forceStopOwnedPublicFixture(callTool, brokerStatus, fixture);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) appendCleanupFailure(primaryError, cleanupError);
  }
}

async function publicGracefulTimeoutIdentityCoverage() {
  const timeoutStateDir = path.join(root, "timeout-stop-state");
  const timeoutConfigDir = path.join(root, "timeout-stop-config");
  const timeoutEnvironment = {
    ...environment,
    RAIL_CONNECTOR_STATE_DIR: timeoutStateDir,
    CLAUDE_CONFIG_DIR: timeoutConfigDir,
    RAIL_CONNECTOR_FAKE_CLAUDE_IGNORE_EXIT: "1",
  };
  cleanupEnvironments.push(timeoutEnvironment);
  const timeoutTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.js"],
    cwd: repoRoot,
    env: timeoutEnvironment,
    stderr: "pipe",
  });
  const timeoutClient = new Client(
    { name: "rail-connector-stop-identity-timeout", version: "1.0.0" },
    { capabilities: {} }
  );
  const owned = {
    sessionName: `public_exact_timeout_${process.pid}`,
    expectedResolvedSessionId: randomUUID(),
    expectedCanonicalCwd: canonicalWorkspace,
  };
  let timeoutBrokerPid = null;
  let primaryError = null;
  try {
    await timeoutClient.connect(timeoutTransport, { timeout: 30000 });
    const started = await timeoutClient.callTool(
      {
        name: "start_remote_control",
        arguments: {
          cwd: workspace,
          managedSession: owned.sessionName,
          newSessionId: owned.expectedResolvedSessionId,
          permissionMode: "plan",
          trustWorkspace: false,
        },
      },
      undefined,
      { timeout: 45000 }
    );
    assert.equal(started.isError, undefined, contentText(started));
    const timeoutStatus = await windowsBrokerRequest("status", {}, {
      env: timeoutEnvironment,
      startIfMissing: false,
      timeoutMs: 5000,
    });
    timeoutBrokerPid = timeoutStatus.pid ?? null;
    const metadata = timeoutStatus.managedSessions.find((session) => session.name === owned.sessionName);
    assert.ok(metadata?.generationId);
    owned.expectedGeneration = brokerGenerationPair(metadata);
    assert.equal(metadata?.resolvedSessionId, owned.expectedResolvedSessionId);
    assert.equal(metadata?.canonicalCwd, owned.expectedCanonicalCwd);
    const exact = {
      managedSession: owned.sessionName,
      ...brokerGenerationPair(metadata),
      expectedResolvedSessionId: metadata.resolvedSessionId,
      expectedCanonicalCwd: metadata.canonicalCwd,
    };
    const timedOut = await timeoutClient.callTool(
      {
        name: "stop_remote_control",
        arguments: { ...exact, graceful: true, force: false },
      },
      undefined,
      { timeout: 45000 }
    );
    assert.equal(timedOut.isError, undefined, contentText(timedOut));
    const timedOutResult = JSON.parse(contentText(timedOut));
    assert.equal(timedOutResult.status, "graceful_stop_timeout");
    assert.equal(
      Object.hasOwn(timedOutResult, "boundIdentity"),
      false,
      "a graceful timeout must not echo an exact identity"
    );
    const forced = await timeoutClient.callTool(
      {
        name: "stop_remote_control",
        arguments: { ...exact, graceful: false, force: true },
      },
      undefined,
      { timeout: 45000 }
    );
    assert.equal(forced.isError, undefined, contentText(forced));
    const forcedResult = JSON.parse(contentText(forced));
    assert.equal(forcedResult.status, "stopped");
    assert.equal(forcedResult.graceful, false);
    assert.equal(Object.hasOwn(forcedResult, "boundIdentity"), false);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError = null;
    const timeoutStatus = async () => windowsBrokerRequest("status", {}, {
      env: timeoutEnvironment,
      startIfMissing: false,
      timeoutMs: 5000,
    });
    const timeoutCallTool = (name, args) => timeoutClient.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 45000 }
    );
    try {
      await forceStopOwnedPublicFixture(timeoutCallTool, timeoutStatus, owned);
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      const statusAfterCleanup = await timeoutStatus();
      timeoutBrokerPid ??= statusAfterCleanup.pid ?? null;
      assert.equal(
        statusAfterCleanup.managedSessions.length,
        0,
        "dedicated timeout broker must be empty before shutdown"
      );
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await timeoutClient.close();
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await windowsBrokerRequest("shutdown", {}, {
        env: timeoutEnvironment,
        startIfMissing: false,
        timeoutMs: 5000,
      });
    } catch (error) {
      cleanupError ??= error;
    }
    if (Number.isInteger(timeoutBrokerPid)) {
      let exited = false;
      for (let index = 0; index < 50; index += 1) {
        try {
          process.kill(timeoutBrokerPid, 0);
        } catch (error) {
          if (error?.code === "ESRCH") {
            exited = true;
            break;
          }
          cleanupError ??= error;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      try {
        assert.equal(exited, true, "dedicated timeout test broker must exit before cleanup");
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) appendCleanupFailure(primaryError, cleanupError);
  }
}

function installBoundaryPublicationProbe(hookDir) {
  const entryPath = path.join(hookDir, "capture_after_metadata.entered.json");
  const armPath = path.join(hookDir, "publication-probe.arm.json");
  const observedPath = path.join(hookDir, "publication-probe.observed.json");
  const pausedPath = path.join(hookDir, "publication-probe.paused");
  const resumePath = path.join(hookDir, "publication-probe.resume");
  const original = { open: fs.openSync, write: fs.writeFileSync, writeBytes: fs.writeSync,
    link: fs.linkSync, rename: fs.renameSync, close: fs.closeSync };
  let probe = null;
  const fds = new Map();
  function observe(data) {
    original.write(observedPath, JSON.stringify(data), { flag: "wx" });
    original.write(pausedPath, "", { flag: "wx" });
  }
  fs.openSync = (file, flags, ...rest) => {
    const target = typeof file === "string" ? file : "";
    const eligible = target === entryPath || (
      path.dirname(target) === hookDir &&
      path.basename(target).startsWith("capture_after_metadata.entered.") && target.endsWith(".tmp")
    );
    if (eligible && flags === "wx" && fs.existsSync(armPath)) {
      const control = JSON.parse(fs.readFileSync(armPath, "utf8"));
      if (control.entryPath !== entryPath) throw new Error("foreign publication probe arm");
      original.rename(armPath, armPath + ".claimed");
      probe = { ...control, target };
      if (probe.mode === "staging-collision" && target !== entryPath) {
        original.write(target, "synthetic preexisting staging sentinel", { flag: "wx" });
        observe({ mode: probe.mode, target, entryExists: fs.existsSync(entryPath) });
      }
    }
    const fd = original.open(file, flags, ...rest);
    if (probe?.target === target) fds.set(fd, probe);
    return fd;
  };
  fs.closeSync = (fd) => {
    try { return original.close(fd); } finally { fds.delete(fd); }
  };
  fs.writeFileSync = (file, data, ...rest) => {
    if (file === entryPath && fs.existsSync(armPath)) {
      const fd = fs.openSync(file, rest[0]?.flag ?? "w", rest[0]?.mode);
      try { return fs.writeFileSync(fd, data, ...rest); } finally { fs.closeSync(fd); }
    }
    const current = typeof file === "number" ? fds.get(file) : null;
    if (current?.mode !== "partial") return original.write(file, data, ...rest);
    const bytes = Buffer.from(data);
    const split = Math.floor(bytes.length / 2);
    original.writeBytes(file, bytes.subarray(0, split));
    observe({ mode: current.mode, target: current.target,
      partialBytes: fs.statSync(current.target).size, entryExists: fs.existsSync(entryPath) });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(resumePath)) {
      if (Date.now() > deadline) throw new Error("publication probe was not released within its existing readiness budget");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    original.writeBytes(file, bytes.subarray(split));
  };
  fs.linkSync = (source, target) => {
    if (probe?.mode === "link-failure" && source === probe.target && target === entryPath) {
      const error = new Error("synthetic publication link failure");
      error.code = "EIO";
      throw error;
    }
    return original.link(source, target);
  };
}

async function pairedBoundaryPublicationCoverage() {
  const stage = "capture_after_metadata";
  const sessionName = "boundary_publication_" + process.pid;
  const sessionId = "67676767-6767-4676-8676-676767676767";
  const startLease = "boundary-publication-start";
  const tracked = { metadata: null, leaseId: startLease };
  const failures = [];
  let primaryError = null;
  try {
    const started = await windowsBrokerRequest("start", directFixtureLaunch(sessionName, startLease, { sessionId }),
      { env: environment, startIfMissing: false });
    assert.equal(started.status, "started");
    tracked.metadata = started.metadata;
    const pair = brokerGenerationPair(started.metadata);
    await waitForDirectFixtureReady(sessionName, started.metadata, "Fake Claude TUI");
    await releaseDirectFixtureLease(sessionName, startLease, started.metadata);
    tracked.leaseId = null;
    for (const mode of ["partial", "preexisting-entry", "link-failure", "staging-collision"]) {
      const observedPath = path.join(boundaryHookDir, "publication-probe.observed.json");
      const pausedPath = path.join(boundaryHookDir, "publication-probe.paused");
      const resumePath = path.join(boundaryHookDir, "publication-probe.resume");
      const entryPath = boundaryPath(stage, "entered");
      let capturing = null;
      let settled = false;
      let observation = null;
      let caseError = null;
      try {
        for (const suffix of ["arm.json", "arm.json.claimed", "observed.json", "paused", "resume"]) {
          fs.rmSync(path.join(boundaryHookDir, "publication-probe." + suffix), { force: true });
        }
        armPairedBoundary(stage, sessionName, pair);
        const sentinel = JSON.stringify({ synthetic: "preexisting entered marker" });
        if (mode === "preexisting-entry") fs.writeFileSync(entryPath, sentinel, { flag: "wx" });
        fs.writeFileSync(path.join(boundaryHookDir, "publication-probe.arm.json"),
          JSON.stringify({ mode, entryPath }), { flag: "wx" });
        capturing = callTool("capture_remote_control", { managedSession: sessionName, ...pair });
        capturing.catch(() => {});
        if (mode === "partial") {
          for (let attempt = 0; attempt < 200 && !fs.existsSync(pausedPath); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.ok(fs.existsSync(pausedPath), "the actual publisher must enter the controlled partial write");
          observation = JSON.parse(fs.readFileSync(observedPath, "utf8"));
          assert.ok(observation.partialBytes > 0);
          assert.equal(observation.entryExists, false, "the actual publisher exposed its final marker before completing the write");
          assert.equal(fs.existsSync(entryPath), false);
          fs.writeFileSync(resumePath, "", { flag: "wx" });
          const entered = await waitForPairedBoundary(stage);
          assert.equal(entered.sessionName, sessionName);
          assert.equal(entered.expectedGenerationId, pair.expectedGenerationId);
          assert.equal(entered.expectedStartedAtMs, pair.expectedStartedAtMs);
          assert.ok(entered.token);
          releasePairedBoundary(stage, entered.token);
        }
        const result = await capturing;
        settled = true;
        if (mode === "partial") {
          assert.equal(result.isError, undefined, contentText(result));
          assert.equal(JSON.parse(fs.readFileSync(entryPath, "utf8")).sessionName, sessionName);
        } else {
          assert.equal(result.isError, true, mode + " unexpectedly published an entry");
          assert.match(contentText(result), mode === "link-failure" ? /synthetic publication link failure/ : /EEXIST/);
          if (mode === "preexisting-entry") assert.equal(fs.readFileSync(entryPath, "utf8"), sentinel);
          else assert.equal(fs.existsSync(entryPath), false);
        }
        const staging = fs.readdirSync(boundaryHookDir).filter((name) =>
          name.startsWith("capture_after_metadata.entered.") && name.endsWith(".tmp"));
        if (mode === "staging-collision") {
          observation = JSON.parse(fs.readFileSync(observedPath, "utf8"));
          assert.deepEqual(staging, [path.basename(observation.target)]);
          const sentinelPath = path.join(boundaryHookDir, staging[0]);
          assert.equal(path.resolve(observation.target), path.resolve(sentinelPath));
          assert.equal(fs.readFileSync(sentinelPath, "utf8"), "synthetic preexisting staging sentinel");
          fs.unlinkSync(sentinelPath); // The probe owns this sentinel; the publisher did not create it.
        } else assert.deepEqual(staging, [], mode + " left owned staging behind");
        console.log("boundary-publication evidence " + JSON.stringify({ mode, status: "passed", finalHiddenDuringPartial: observation?.entryExists === false }));
      } catch (error) {
        caseError = error;
        failures.push(error);
      } finally {
        const cleanupErrors = [];
        if (capturing && !settled) {
          try {
            if (mode === "partial") {
              if (!fs.existsSync(resumePath)) fs.writeFileSync(resumePath, "", { flag: "wx" });
              const entered = await waitForPairedBoundary(stage);
              releasePairedBoundary(stage, entered.token);
            }
          } catch (error) { cleanupErrors.push(error); }
          try { await capturing; } catch (error) { cleanupErrors.push(error); }
        }
        if (cleanupErrors.length) {
          if (caseError) for (const error of cleanupErrors) appendCleanupFailure(caseError, error);
          else failures.push(new AggregateError(cleanupErrors, "publication probe cleanup failed"));
          break;
        }
      }
    }
    if (failures.length) throw new AggregateError(failures, "paired boundary publication failed", { cause: failures[0] });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (tracked.metadata) await forceStopExactDirectFixture(sessionName,
        { resolvedSessionId: sessionId, canonicalCwd: canonicalWorkspace }, tracked);
    } catch (error) {
      if (primaryError) appendCleanupFailure(primaryError, error);
      else throw error;
    }
  }
}

function boundaryPath(stage, suffix) {
  return path.join(boundaryHookDir, `${stage}.${suffix}.json`);
}

function armPairedBoundary(stage, sessionName, pair) {
  const armPath = boundaryPath(stage, "arm");
  for (const suffix of ["arm", "claimed", "entered", "release"]) {
    fs.rmSync(boundaryPath(stage, suffix), { force: true });
  }
  fs.writeFileSync(
    armPath,
    `${JSON.stringify({ sessionName, ...pair })}\n`,
    { flag: "wx" }
  );
}

async function waitForPairedBoundary(stage) {
  const enteredPath = boundaryPath(stage, "entered");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(enteredPath)) {
      return JSON.parse(fs.readFileSync(enteredPath, "utf8"));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for paired test boundary ${stage}`);
}

function releasePairedBoundary(stage, token) {
  fs.writeFileSync(
    boundaryPath(stage, "release"),
    `${JSON.stringify({ token })}\n`,
    { flag: "wx" }
  );
}

async function productionBoundaryHookIsInert() {
  const productionRoot = path.join(root, "production-boundary-hook");
  const productionStateDir = path.join(productionRoot, "state");
  const productionHookDir = path.join(productionStateDir, "test-boundary-hooks");
  const productionConfigDir = path.join(productionRoot, "config");
  const productionSession = `production_boundary_hook_${process.pid}`;
  const productionLease = "production-boundary-start";
  const cleanupLease = "production-boundary-cleanup";
  const productionEnvironment = {
    ...environment,
    NODE_ENV: "production",
    RAIL_CONNECTOR_STATE_DIR: productionStateDir,
    RAIL_TEST_PAIRED_BOUNDARY_HOOK_DIR: productionHookDir,
    CLAUDE_CONFIG_DIR: productionConfigDir,
  };
  cleanupEnvironments.push(productionEnvironment);
  const productionTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.js"],
    cwd: repoRoot,
    env: productionEnvironment,
    stderr: "pipe",
  });
  const productionClient = new Client(
    { name: "rail-connector-production-boundary", version: "1.0.0" },
    { capabilities: {} }
  );
  let metadata = null;
  let primaryError = null;
  try {
    fs.mkdirSync(productionHookDir, { recursive: true });
    await productionClient.connect(productionTransport, { timeout: 30000 });
    const started = await windowsBrokerRequest(
      "start",
      directFixtureLaunch(productionSession, productionLease, {
        banner: "Fake Claude TUI",
        launchEnvironment: productionEnvironment,
      }),
      { env: productionEnvironment, startIfMissing: true }
    );
    metadata = started.metadata;
    const pair = brokerGenerationPair(metadata);
    await waitForDirectFixtureReady(productionSession, metadata, "Fake Claude TUI", productionEnvironment);
    const released = await windowsBrokerRequest("releaseLease", {
      sessionName: productionSession,
      leaseId: productionLease,
      ...pair,
    }, { env: productionEnvironment, startIfMissing: false });
    assert.equal(released.status, "released");
    const captureStages = ["capture_after_metadata", "capture_after_capture", "capture_before_terminal_check"];
    for (const stage of captureStages) {
      fs.writeFileSync(path.join(productionHookDir, stage + ".arm.json"),
        JSON.stringify({ sessionName: productionSession, ...pair }) + "\n", { flag: "wx" });
    }
    const captured = await productionClient.callTool(
      { name: "capture_remote_control", arguments: { managedSession: productionSession, ...pair } },
      undefined,
      { timeout: 45000 }
    );
    assert.equal(captured.isError, undefined, contentText(captured));
    assert.match(contentText(captured), /Fake Claude TUI/);
    for (const stage of captureStages) {
      assert.equal(fs.existsSync(path.join(productionHookDir, stage + ".entered.json")), false,
        "the matching capture boundary must be ignored outside test mode");
      assert.equal(fs.existsSync(path.join(productionHookDir, stage + ".arm.json")), true);
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError = null;
    try {
      if (metadata) {
        const pair = brokerGenerationPair(metadata);
        const acquired = await windowsBrokerRequest("acquireLease", {
          sessionName: productionSession,
          leaseId: cleanupLease,
          ttlMs: 10000,
          ...pair,
        }, { env: productionEnvironment, startIfMissing: false });
        if (acquired.status === "acquired") {
          const stopped = await windowsBrokerRequest("stop", {
            sessionName: productionSession,
            leaseId: cleanupLease,
            graceful: false,
            force: true,
            omitCapture: true,
            ...pair,
          }, { env: productionEnvironment, startIfMissing: false, timeoutMs: 30000 });
          assert.equal(stopped.status, "stopped");
        }
      }
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await productionClient.close();
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await windowsBrokerRequest("shutdown", {}, {
        env: productionEnvironment,
        startIfMissing: false,
        timeoutMs: 5000,
      });
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) appendCleanupFailure(primaryError, cleanupError);
  }
}

async function assertPublicLeaseBlocksReplacement(
  sessionName,
  pair,
  replacementLease,
  options = {}
) {
  await assert.rejects(
    windowsBrokerRequest(
      "replace",
      {
        ...directFixtureLaunch(sessionName, replacementLease, options),
        graceful: false,
        force: true,
        ...pair,
      },
      { env: environment, startIfMissing: false }
    ),
    (error) => error?.code === "ELEASE",
    "the public paired operation must retain its exact broker lease at the injected boundary"
  );
}

async function removeOwnedTestRoot() {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const canonicalTemp = fs.realpathSync.native?.(os.tmpdir()) ?? fs.realpathSync(os.tmpdir());
      const canonicalRoot = fs.realpathSync.native?.(root) ?? fs.realpathSync(root);
      const comparable = (value) =>
        process.platform === "win32" ? value.toLowerCase() : value;
      assert.equal(
        comparable(path.dirname(canonicalRoot)),
        comparable(canonicalTemp),
        "the test cleanup root must remain a direct child of the system temp directory"
      );
      assert.match(
        path.basename(canonicalRoot),
        /^claude-stop-generation-[A-Za-z0-9_-]+$/,
        "the test cleanup root must retain its owned prefix"
      );
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EPERM" && error?.code !== "EBUSY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

async function conditionalStopRejectsWithoutBroker() {
  const noBrokerState = path.join(root, "no-broker-state");
  const noBrokerTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.js"],
    cwd: repoRoot,
    env: { ...environment, RAIL_CONNECTOR_STATE_DIR: noBrokerState },
    stderr: "pipe",
  });
  const noBrokerClient = new Client(
    { name: "rail-connector-stop-generation-no-broker", version: "1.0.0" },
    { capabilities: {} }
  );
  try {
    await noBrokerClient.connect(noBrokerTransport, { timeout: 30000 });
    const result = await noBrokerClient.callTool(
      {
        name: "stop_remote_control",
        arguments: {
          managedSession: `missing_${process.pid}`,
          expectedGenerationId: "00000000-0000-4000-8000-000000000000",
          expectedStartedAtMs: 1,
        },
      },
      undefined,
      { timeout: 30000 }
    );
    assert.equal(result.isError, true);
    assert.match(contentText(result), /No Windows broker token|broker/i);
    assert.equal(
      fs.existsSync(noBrokerState),
      false,
      "a conditional stop without a broker must not create broker state"
    );
  } finally {
    try {
      await noBrokerClient.close();
    } catch {
      // The local test MCP may already be closed.
    }
  }
}

async function pairedReviewOperationsRejectWithoutBroker() {
  const noBrokerState = path.join(root, "no-broker-review-state");
  const noBrokerTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.js"],
    cwd: repoRoot,
    env: { ...environment, RAIL_CONNECTOR_STATE_DIR: noBrokerState },
    stderr: "pipe",
  });
  const noBrokerClient = new Client(
    { name: "rail-connector-generation-review-no-broker", version: "1.0.0" },
    { capabilities: {} }
  );
  const pair = {
    expectedGenerationId: "00000000-0000-4000-8000-000000000000",
    expectedStartedAtMs: 1,
  };
  const afterCursor = createPortableWaitCursor(
    {},
    {
      generationId: pair.expectedGenerationId,
      startedAtMs: pair.expectedStartedAtMs,
      resolvedSessionId: "11111111-1111-4111-8111-111111111111",
    },
    Date.now()
  );
  try {
    await noBrokerClient.connect(noBrokerTransport, { timeout: 30000 });
    for (const [name, arguments_] of [
      ["capture_remote_control", { managedSession: `missing_capture_${process.pid}`, ...pair }],
      ["submit_prompt", { managedSession: `missing_submit_${process.pid}`, text: "synthetic", ...pair }],
      ["wait_for_claude_turn", { managedSession: `missing_wait_${process.pid}`, afterCursor, timeoutSeconds: 1, ...pair }],
      ["rename_claude_session", { managedSession: `missing_rename_${process.pid}`, title: "No broker rename", ...pair }],
    ]) {
      const result = await noBrokerClient.callTool(
        { name, arguments: arguments_ },
        undefined,
        { timeout: 30000 }
      );
      assert.equal(result.isError, true, `${name} should fail closed without a broker`);
      assert.match(contentText(result), /No Windows broker token|broker/i);
      assert.equal(
        fs.existsSync(noBrokerState),
        false,
        `${name} must not create broker state when its exact pair has no broker`
      );
    }
  } finally {
    try {
      await noBrokerClient.close();
    } catch {
      // The local test MCP may already be closed.
    }
  }
}

async function exitedStartupRetainsOriginalBinding() {
  const exitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-stop-generation-exit-"));
  const exitStateDir = path.join(exitRoot, "state");
  const exitConfigDir = path.join(exitRoot, "config");
  const exitBoundaryHookDir = path.join(exitStateDir, "test-boundary-hooks");
  const exitWrapper = path.join(exitRoot, "fake-claude.cmd");
  const exitLedger = await createFixtureProcessLedger({ directory: path.join(exitRoot, "fixture-processes"), fixturePath: fixture });
  fixtureLedgers.add(exitLedger);
  fs.writeFileSync(
    exitWrapper,
    [
      "@echo off",
      `\"${process.execPath}\" \"${fixture}\" ${exitLedger.fixtureArgs.join(" ")} %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n")
  );
  fs.mkdirSync(exitBoundaryHookDir, { recursive: true });
  const exitEnvironment = {
    ...process.env,
    ...exitLedger.environment,
    NODE_ENV: "test",
    RAIL_CONNECTOR_CLAUDE_PATH: exitWrapper,
    RAIL_CONNECTOR_STATE_DIR: exitStateDir,
    RAIL_TEST_PAIRED_BOUNDARY_HOOK_DIR: exitBoundaryHookDir,
    CLAUDE_CONFIG_DIR: exitConfigDir,
    RAIL_CONNECTOR_ALLOWED_ROOTS: [exitRoot, workspace].join(path.delimiter),
    RAIL_FAKE_CLAUDE_EXIT_ON_START: "1",
  };
  cleanupEnvironments.push(exitEnvironment);
  const exitTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.js"],
    cwd: repoRoot,
    env: exitEnvironment,
    stderr: "pipe",
  });
  const exitClient = new Client(
    { name: "rail-connector-generation-immediate-exit", version: "1.0.0" },
    { capabilities: {} }
  );
  const name = `immediate_exit_${process.pid}`;
  let exitBrokerPid = null;
  let primaryError = null;
  const exitBrokerStatus = () => windowsBrokerRequest("status", {}, {
    env: exitEnvironment,
    startIfMissing: false,
    timeoutMs: 5000,
  });
  try {
    await exitClient.connect(exitTransport, { timeout: 30000 });
    const result = await exitClient.callTool(
      {
        name: "start_remote_control",
        arguments: {
          cwd: workspace,
          managedSession: name,
          permissionMode: "plan",
          trustWorkspace: false,
        },
      },
      undefined,
      { timeout: 45000 }
    );
    assert.equal(result.isError, undefined, contentText(result));
    const started = JSON.parse(contentText(result));
    assert.equal(started.status, "exited_during_startup");
    assert.ok(started.sessionBinding?.generationId);
    assert.ok(Number.isSafeInteger(started.sessionBinding?.startedAtMs));
    const exitStatus = await exitBrokerStatus();
    exitBrokerPid = exitStatus.pid ?? null;
    const owned = exitStatus.managedSessions.find((session) => session.name === name);
    assert.deepEqual(started.sessionBinding, {
      generationId: owned?.generationId,
      startedAtMs: owned?.startedAtMs,
    });
    const stopped = await exitClient.callTool(
      {
        name: "stop_remote_control",
        arguments: {
          managedSession: name,
          graceful: true,
          force: false,
          expectedGenerationId: started.sessionBinding.generationId,
          expectedStartedAtMs: started.sessionBinding.startedAtMs,
        },
      },
      undefined,
      { timeout: 30000 }
    );
    assert.equal(stopped.isError, undefined, contentText(stopped));
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError = null;
    try {
      await exitClient.close();
    } catch (error) {
      // The task-local synthetic client may already be closed.
      cleanupError ??= error;
    }
    try {
      const status = await exitBrokerStatus();
      exitBrokerPid ??= status.pid ?? null;
      assert.equal(
        status.managedSessions.length,
        0,
        "the immediate-exit fixture broker must be empty before shutdown"
      );
    } catch (error) {
      if (error?.code !== "ENOENT") cleanupError ??= error;
    }
    try {
      const shutdown = await windowsBrokerRequest("shutdown", {}, {
        env: exitEnvironment,
        startIfMissing: false,
        timeoutMs: 5000,
      });
      exitBrokerPid ??= shutdown.pid ?? null;
    } catch (error) {
      if (error?.code !== "ENOENT") cleanupError ??= error;
    }
    if (Number.isInteger(exitBrokerPid)) {
      let brokerExited = false;
      for (let index = 0; index < 50; index += 1) {
        try {
          process.kill(exitBrokerPid, 0);
        } catch (error) {
          if (error?.code === "ESRCH") {
            brokerExited = true;
            break;
          }
          cleanupError ??= error;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!brokerExited) {
        cleanupError ??= new Error("the immediate-exit fixture broker must exit before cleanup");
      }
    }
    try { await exitLedger.reap({ expectRecords: false, final: true }); }
    catch (error) { cleanupError ??= error; }
    if (!cleanupError && !primaryError) {
      try {
      const canonicalTemp = fs.realpathSync.native?.(os.tmpdir()) ?? fs.realpathSync(os.tmpdir());
      const canonicalExitRoot = fs.realpathSync.native?.(exitRoot) ?? fs.realpathSync(exitRoot);
      const comparable = (value) => process.platform === "win32" ? value.toLowerCase() : value;
      assert.equal(
        comparable(path.dirname(canonicalExitRoot)),
        comparable(canonicalTemp),
        "the immediate-exit cleanup root must remain a direct child of the system temp directory"
      );
      assert.match(
        path.basename(canonicalExitRoot),
        /^claude-stop-generation-exit-[A-Za-z0-9_-]+$/,
        "the immediate-exit cleanup root must retain its owned prefix"
      );
      fs.rmSync(exitRoot, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
      fixtureLedgers.delete(exitLedger);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (primaryError) primaryError.message += `\nImmediate-exit fixture diagnostics preserved at ${exitRoot}`;
    if (cleanupError) {
      appendCleanupFailure(primaryError, cleanupError);
    }
  }
}

async function startRetainsOriginalBindingWhileLeaseBlocksReplacement() {
  const replacementSession = `start_binding_${process.pid}`;
  const originalStart = callTool("start_remote_control", {
    cwd: workspace,
    managedSession: replacementSession,
    permissionMode: "plan",
    trustWorkspace: false,
  });
  const deadline = Date.now() + 10000;
  let observed = null;
  while (Date.now() < deadline) {
    try {
      observed = (await brokerStatus()).managedSessions.find(
        (session) => session.name === replacementSession
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (observed && !observed.exited) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(observed && !observed.exited, "the original broker generation must exist before replacement");
  const leaseId = `start-binding-${process.pid}`;
  const canonicalWorkspace = fs.realpathSync.native?.(workspace) ?? fs.realpathSync(workspace);
  const commandProcessor = process.env.ComSpec || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  await assert.rejects(
    windowsBrokerRequest(
      "replace",
      {
        sessionName: replacementSession,
        command: commandProcessor,
        args: [],
        metadataCommand: wrapper,
        metadataArgs: [],
        commandLine: `/d /s /v:off /c "\"${wrapper}\""`,
        cols: 140,
        rows: 40,
        cwd: workspace,
        canonicalCwd: canonicalWorkspace,
        env: environment,
        launchEnvironment: null,
        expectedGenerationId: observed.generationId,
        expectedStartedAtMs: observed.startedAtMs,
        leaseId,
        leaseTtlMs: 30000,
        graceful: false,
        force: true,
      },
      { env: environment, startIfMissing: false, timeoutMs: 30000 }
    ),
    (error) => error?.code === "ELEASE",
    "a second writer cannot replace the original broker generation while start owns its lease"
  );
  const original = await originalStart;
  assert.equal(original.isError, undefined, contentText(original));
  const started = JSON.parse(contentText(original));
  assert.deepEqual(started.sessionBinding, {
    generationId: observed.generationId,
    startedAtMs: observed.startedAtMs,
  });

  const postStartLease = await windowsBrokerRequest("acquireLease", {
    sessionName: replacementSession,
    leaseId,
    ttlMs: 10000,
    expectedGenerationId: started.sessionBinding.generationId,
    expectedStartedAtMs: started.sessionBinding.startedAtMs,
  }, { env: environment, startIfMissing: false });
  assert.equal(postStartLease.status, "acquired", "start must release its exact broker lease");
  assert.equal((await windowsBrokerRequest("releaseLease", {
    sessionName: replacementSession,
    leaseId,
    expectedGenerationId: started.sessionBinding.generationId,
    expectedStartedAtMs: started.sessionBinding.startedAtMs,
  }, { env: environment, startIfMissing: false })).status, "released");

  const stopped = await callTool("stop_remote_control", {
    managedSession: replacementSession,
    graceful: true,
    force: true,
    expectedGenerationId: started.sessionBinding.generationId,
    expectedStartedAtMs: started.sessionBinding.startedAtMs,
  });
  assert.equal(stopped.isError, undefined, contentText(stopped));
}

async function exactPairReplacementInjectionCoverage() {
  // A replacement that already won the name must make a stale public paired
  // submission fail before it can deliver prompt bytes to the replacement.
  const preSubmitSession = `paired_pre_submit_${process.pid}`;
  const preSubmitStartLease = "paired-pre-submit-start";
  const preSubmitReplacementLease = "paired-pre-submit-replacement";
  const preSubmitWireReceipt = path.join(root, "paired-pre-submit-wire.jsonl");
  const preSubmitOriginal = await windowsBrokerRequest(
    "start",
    directFixtureLaunch(preSubmitSession, preSubmitStartLease),
    { env: environment, startIfMissing: false }
  );
  const preSubmitOriginalPair = brokerGenerationPair(preSubmitOriginal.metadata);
  await releaseDirectFixtureLease(
    preSubmitSession,
    preSubmitStartLease,
    preSubmitOriginal.metadata
  );
  await acquireDirectFixtureLease(
    preSubmitSession,
    preSubmitReplacementLease,
    preSubmitOriginal.metadata
  );
  const preSubmitReplacement = await windowsBrokerRequest(
    "replace",
    {
      ...directFixtureLaunch(preSubmitSession, preSubmitReplacementLease, {
        wireReceipt: preSubmitWireReceipt,
      }),
      graceful: false,
      force: true,
      ...preSubmitOriginalPair,
    },
    { env: environment, startIfMissing: false }
  );
  assert.equal(preSubmitReplacement.status, "started");
  await waitForDirectFixtureReady(preSubmitSession, preSubmitReplacement.metadata, "Fake Claude TUI");
  const staleSubmission = await callTool("submit_prompt", {
    managedSession: preSubmitSession,
    text: "stale paired submission must not reach replacement",
    submitRetries: 0,
    ...preSubmitOriginalPair,
  });
  assert.equal(staleSubmission.isError, true);
  assert.match(contentText(staleSubmission), /generation changed|stale/i);
  assert.equal(
    fs.existsSync(preSubmitWireReceipt) ? fs.readFileSync(preSubmitWireReceipt, "utf8") : "",
    "",
    "a replacement injected before paired submission must receive no prompt byte or Enter"
  );
  await stopDirectFixture(
    preSubmitSession,
    preSubmitReplacementLease,
    preSubmitReplacement.metadata
  );

  // Pause the real public submit after it acquired its own broker lease. A
  // competing same-name replacement must be rejected, then the prompt can
  // reach only the original fake TUI once the synthetic barrier is released.
  const submitSession = `paired_submit_boundary_${process.pid}`;
  const submitStartLease = "paired-submit-start";
  const submitReplacementLease = "paired-submit-replacement";
  const submitCleanupLease = "paired-submit-cleanup";
  const submitOriginalSessionId = "44444444-4444-4444-8444-444444444444";
  const submitOriginalWire = path.join(root, "paired-submit-original-wire.jsonl");
  const submitReplacementWire = path.join(root, "paired-submit-replacement-wire.jsonl");
  const submitOriginal = await windowsBrokerRequest(
    "start",
    directFixtureLaunch(submitSession, submitStartLease, {
      sessionId: submitOriginalSessionId,
      wireReceipt: submitOriginalWire,
    }),
    { env: environment, startIfMissing: false }
  );
  const submitPair = brokerGenerationPair(submitOriginal.metadata);
  await waitForDirectFixtureReady(submitSession, submitOriginal.metadata, "Fake Claude TUI");
  await releaseDirectFixtureLease(submitSession, submitStartLease, submitOriginal.metadata);
  armPairedBoundary("submit_after_lease", submitSession, submitPair);
  const submitted = callTool("submit_prompt", {
    managedSession: submitSession,
    text: "paired boundary prompt reaches only the original session",
    submitRetries: 0,
    ...submitPair,
  });
  const submitBoundary = await waitForPairedBoundary("submit_after_lease");
  assert.deepEqual(
    {
      sessionName: submitBoundary.sessionName,
      expectedGenerationId: submitBoundary.expectedGenerationId,
      expectedStartedAtMs: submitBoundary.expectedStartedAtMs,
    },
    { sessionName: submitSession, ...submitPair }
  );
  await assertPublicLeaseBlocksReplacement(
    submitSession,
    submitPair,
    submitReplacementLease,
    { sessionId: "55555555-5555-4555-8555-555555555555", wireReceipt: submitReplacementWire }
  );
  releasePairedBoundary("submit_after_lease", submitBoundary.token);
  const submittedResult = await submitted;
  assert.equal(submittedResult.isError, undefined, contentText(submittedResult));
  assert.match(fs.readFileSync(submitOriginalWire, "utf8"), /paired boundary prompt reaches only the original session/);
  assert.equal(
    fs.existsSync(submitReplacementWire) ? fs.readFileSync(submitReplacementWire, "utf8") : "",
    "",
    "the rejected replacement must not receive prompt bytes"
  );
  await acquireDirectFixtureLease(submitSession, submitCleanupLease, submitOriginal.metadata);
  await stopDirectFixture(submitSession, submitCleanupLease, submitOriginal.metadata);

  // Inject a completed replacement inside the actual public capture operation,
  // after its exact metadata read and before its generation-bound capture.
  const captureStartLease = "paired-capture-start";
  const captureReplacementLease = "paired-capture-replacement";
  const captureSession = `paired_capture_boundary_${process.pid}`;
  const captureOriginalBanner = "ORIGINAL_CAPTURE_READY";
  const captureReplacementBanner = "REPLACEMENT_CAPTURE_READY";
  const captureOriginal = await windowsBrokerRequest(
    "start",
    directFixtureLaunch(captureSession, captureStartLease, {
      banner: captureOriginalBanner,
    }),
    { env: environment, startIfMissing: false }
  );
  const captureOriginalPair = brokerGenerationPair(captureOriginal.metadata);
  await waitForDirectFixtureReady(
    captureSession,
    captureOriginal.metadata,
    captureOriginalBanner
  );
  await releaseDirectFixtureLease(captureSession, captureStartLease, captureOriginal.metadata);
  armPairedBoundary("capture_after_metadata", captureSession, captureOriginalPair);
  const capturePromise = callTool("capture_remote_control", {
    managedSession: captureSession,
    ...captureOriginalPair,
  });
  const captureBoundary = await waitForPairedBoundary("capture_after_metadata");
  await acquireDirectFixtureLease(
    captureSession,
    captureReplacementLease,
    captureOriginal.metadata
  );
  const captureReplacement = await windowsBrokerRequest("replace", {
    ...directFixtureLaunch(captureSession, captureReplacementLease, {
      banner: captureReplacementBanner,
    }),
    graceful: false,
    force: true,
    ...captureOriginalPair,
  }, { env: environment, startIfMissing: false });
  assert.equal(captureReplacement.status, "started");
  releasePairedBoundary("capture_after_metadata", captureBoundary.token);
  const staleCapture = await capturePromise;
  assert.equal(staleCapture.isError, true);
  assert.match(contentText(staleCapture), /generation changed|stale/i);
  assert.doesNotMatch(contentText(staleCapture), new RegExp(captureReplacementBanner));
  await waitForDirectFixtureReady(
    captureSession,
    captureReplacement.metadata,
    captureReplacementBanner
  );
  await stopDirectFixture(
    captureSession,
    captureReplacementLease,
    captureReplacement.metadata
  );

  // The wait hook pauses an actual polling iteration between its metadata read
  // and capture. The replacement must cause that same public wait to reject.
  const waitSession = `paired_wait_boundary_${process.pid}`;
  const waitStartLease = "paired-wait-start";
  const waitReplacementLease = "paired-wait-replacement";
  const waitOriginalSessionId = "22222222-2222-4222-8222-222222222222";
  const waitReplacementSessionId = "33333333-3333-4333-8333-333333333333";
  const waitOriginal = await windowsBrokerRequest(
    "start",
    directFixtureLaunch(waitSession, waitStartLease, {
      sessionId: waitOriginalSessionId,
    }),
    { env: environment, startIfMissing: false }
  );
  const waitOriginalPair = brokerGenerationPair(waitOriginal.metadata);
  await waitForDirectFixtureReady(
    waitSession,
    waitOriginal.metadata,
    "Fake Claude TUI"
  );
  await releaseDirectFixtureLease(waitSession, waitStartLease, waitOriginal.metadata);
  armPairedBoundary("wait_after_metadata", waitSession, waitOriginalPair);
  const waitPromise = callTool("wait_for_claude_turn", {
    managedSession: waitSession,
    afterCursor: createPortableWaitCursor(
      {},
      {
        generationId: waitOriginalPair.expectedGenerationId,
        startedAtMs: waitOriginalPair.expectedStartedAtMs,
        resolvedSessionId: waitOriginalSessionId,
      },
      Date.now()
    ),
    timeoutSeconds: 3,
    pollIntervalMs: 250,
    ...waitOriginalPair,
  });
  const waitBoundary = await waitForPairedBoundary("wait_after_metadata");
  await acquireDirectFixtureLease(
    waitSession,
    waitReplacementLease,
    waitOriginal.metadata
  );
  const waitReplacement = await windowsBrokerRequest(
    "replace",
    {
      ...directFixtureLaunch(waitSession, waitReplacementLease, {
        sessionId: waitReplacementSessionId,
      }),
      graceful: false,
      force: true,
      ...waitOriginalPair,
    },
    { env: environment, startIfMissing: false }
  );
  assert.equal(waitReplacement.status, "started");
  releasePairedBoundary("wait_after_metadata", waitBoundary.token);
  const waited = await waitPromise;
  assert.equal(waited.isError, true);
  assert.match(contentText(waited), /generation changed|stale/i);
  await stopDirectFixture(waitSession, waitReplacementLease, waitReplacement.metadata);

  // The public paired stop holds a mutation lease. A competing replacement at
  // the operation's own metadata-to-capture boundary cannot start, and the
  // public stop subsequently terminates only the original generation.
  const stopSession = `paired_stop_boundary_${process.pid}`;
  const stopStartLease = "paired-stop-start";
  const stopReplacementLease = "paired-stop-replacement";
  const stopOriginal = await windowsBrokerRequest(
    "start",
    directFixtureLaunch(stopSession, stopStartLease),
    { env: environment, startIfMissing: false }
  );
  const stopPair = brokerGenerationPair(stopOriginal.metadata);
  await waitForDirectFixtureReady(stopSession, stopOriginal.metadata, "Fake Claude TUI");
  await releaseDirectFixtureLease(stopSession, stopStartLease, stopOriginal.metadata);
  armPairedBoundary("stop_after_metadata", stopSession, stopPair);
  const stopping = callTool("stop_remote_control", {
    managedSession: stopSession,
    graceful: false,
    force: true,
    ...stopPair,
  });
  const stopBoundary = await waitForPairedBoundary("stop_after_metadata");
  await assertPublicLeaseBlocksReplacement(
    stopSession,
    stopPair,
    stopReplacementLease
  );
  releasePairedBoundary("stop_after_metadata", stopBoundary.token);
  const stopped = await stopping;
  assert.equal(stopped.isError, undefined, contentText(stopped));
  assert.equal(
    (await brokerStatus()).managedSessions.some((session) => session.name === stopSession),
    false,
    "the public paired stop must leave no original or replacement session behind"
  );
}


async function captureTerminalGenerationCoverage() {
  await windowsBrokerRequest("ping", {}, { env: environment });
  const cases = [
    { name: "after-capture-same-conversation", stage: "capture_after_capture", replace: true },
    { name: "after-posture-same-conversation", stage: "capture_before_terminal_check", replace: true },
    { name: "paired-capture-control", stage: "capture_after_capture" },
    { name: "paired-posture-control", stage: "capture_before_terminal_check" },
    { name: "legacy-unbound-control", stage: "capture_after_capture", unbound: true },
    { name: "partial-generation-control", partial: "generation" },
    { name: "partial-start-time-control", partial: "started" },
  ];
  const failures = [];
  for (const testCase of cases) {
    try { await captureTerminalGenerationCase(testCase); }
    catch (error) {
      failures.push(error);
      if (error.fixtureCleanupFailed) break;
    }
  }
  if (failures.length) {
    throw new AggregateError(failures,
      "terminal capture generation failures: " + failures.map((error) => error.message).join("; "),
      { cause: failures[0] });
  }
}

async function captureTerminalGenerationCase(testCase) {
  const sessionName = "capture_terminal_" + testCase.name + "_" + process.pid;
  const startLease = testCase.name + "-start";
  const replacementLease = testCase.name + "-replacement";
  const sessionId = "67676767-6767-4676-8676-676767676767";
  const expected = { resolvedSessionId: sessionId, canonicalCwd: canonicalWorkspace };
  const tracked = { metadata: null, leaseId: startLease };
  const logFile = path.join(configDir, "projects",
    canonicalWorkspace.replace(/[^A-Za-z0-9]/g, "-"), sessionId + ".jsonl");
  const originalBanner = "CAPTURE_ORIGINAL_READY_" + testCase.name;
  const replacementBanner = "CAPTURE_REPLACEMENT_READY_" + testCase.name;
  const assistantRecord = (marker) => ({
    type: "assistant", uuid: randomUUID(), sessionId, timestamp: new Date().toISOString(),
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: marker }] },
  });
  let boundary = null;
  let boundaryReleased = false;
  let capturePromise = null;
  let captureSettled = false;
  let primaryError = null;
  try {
    fs.rmSync(logFile, { force: true });
    const started = await windowsBrokerRequest("start",
      directFixtureLaunch(sessionName, startLease, { sessionId, banner: originalBanner }),
      { env: environment, startIfMissing: false });
    assert.equal(started.status, "started");
    tracked.metadata = started.metadata;
    const pair = brokerGenerationPair(started.metadata);
    await waitForDirectFixtureReady(sessionName, started.metadata, originalBanner);
    await releaseDirectFixtureLease(sessionName, startLease, started.metadata);
    tracked.leaseId = null;
    const originalMarker = "synthetic-capture-original-" + testCase.name + "-" + started.metadata.generationId;
    const userRecord = {
      type: "user", uuid: randomUUID(), sessionId, timestamp: new Date().toISOString(),
      message: { role: "user", content: "synthetic capture generation prompt" },
    };
    fs.appendFileSync(logFile, [userRecord, assistantRecord(originalMarker)]
      .map((record) => JSON.stringify(record)).join("\n") + "\n");
    if (testCase.stage) armPairedBoundary(testCase.stage, sessionName, pair);
    const suppliedPair = testCase.unbound ? {} : testCase.partial === "generation"
      ? { expectedGenerationId: pair.expectedGenerationId }
      : testCase.partial === "started" ? { expectedStartedAtMs: pair.expectedStartedAtMs } : pair;
    capturePromise = callTool("capture_remote_control", { managedSession: sessionName, ...suppliedPair });
    capturePromise.catch(() => {});
    let replacementMarker = null;
    if (testCase.stage && !testCase.unbound) {
      boundary = await waitForPairedBoundary(testCase.stage);
      if (testCase.replace) {
        await acquireDirectFixtureLease(sessionName, replacementLease, started.metadata);
        tracked.leaseId = replacementLease;
        const replacement = await windowsBrokerRequest("replace", {
          ...directFixtureLaunch(sessionName, replacementLease, { sessionId, banner: replacementBanner }),
          ...pair, graceful: false, force: true,
        }, { env: environment, startIfMissing: false });
        assert.equal(replacement.status, "started");
        tracked.metadata = replacement.metadata;
        assert.equal(replacement.metadata.resolvedSessionId, sessionId);
        assert.notEqual(replacement.metadata.generationId, started.metadata.generationId);
        await waitForDirectFixtureReady(sessionName, replacement.metadata, replacementBanner);
        replacementMarker = "synthetic-capture-replacement-" + testCase.name + "-" + replacement.metadata.generationId;
        fs.appendFileSync(logFile, JSON.stringify(assistantRecord(replacementMarker)) + "\n");
      }
      releasePairedBoundary(testCase.stage, boundary.token);
      boundaryReleased = true;
    }
    const captured = await capturePromise;
    captureSettled = true;
    let result;
    try { result = JSON.parse(contentText(captured)); } catch { result = {}; }
    const surviving = (await brokerStatus()).managedSessions.find((session) => session.name === sessionName);
    assert.deepEqual(brokerGenerationPair(surviving), brokerGenerationPair(tracked.metadata),
      "capture must preserve the exact generation pair");
    assert.equal(surviving.pid, tracked.metadata.pid, "capture must preserve the exact fixture PID");
    assert.equal(surviving.canonicalCwd, canonicalWorkspace);
    assert.equal(surviving.resolvedSessionId, sessionId);
    assert.equal(surviving.exited, false, "capture must preserve the exact running generation");
    const returnedAssistant = result.transcript?.lastAssistant;
    const matchesMarker = (marker) => Boolean(marker && returnedAssistant?.text === marker &&
      returnedAssistant?.textSha256 === "sha256:" + createHash("sha256").update(marker).digest("hex"));
    const oldTerminalReturned = typeof result.capture === "string" && result.capture.includes(originalBanner) &&
      !result.capture.includes(replacementBanner);
    const returnedOriginalMarker = matchesMarker(originalMarker);
    const returnedReplacementMarker = matchesMarker(replacementMarker);
    const evidence = {
      case: testCase.name, isError: Boolean(captured.isError), stage: testCase.stage ?? null,
      originalGenerationId: started.metadata.generationId, survivingGenerationId: surviving.generationId,
      originalPair: pair, originalPid: started.metadata.pid,
      replacementPair: testCase.replace ? brokerGenerationPair(tracked.metadata) : null,
      replacementPid: testCase.replace ? tracked.metadata.pid : null,
      survivingPair: brokerGenerationPair(surviving), survivingPid: surviving.pid,
      sameConversation: surviving.resolvedSessionId === sessionId, replacementAlive: !surviving.exited,
      originalMarker, replacementMarker, returnedAssistant, oldTerminalReturned,
      returnedOriginalMarker, returnedReplacementMarker, rawResult: captured,
    };
    fs.writeFileSync(path.join(root, testCase.name + ".capture-evidence.json"), JSON.stringify(evidence) + "\n");
    console.log("capture-terminal evidence " + JSON.stringify({
      case: testCase.name, isError: evidence.isError, sameConversation: evidence.sameConversation,
      exactGenerationPreserved: true, oldTerminalReturned, returnedOriginalMarker, returnedReplacementMarker,
    }));
    if (testCase.replace) {
      // On the instrumented old runtime the assertion fails with raw proof:
      // after-capture combines old A terminal with new B transcript, whereas
      // after-posture wrongly accepts the already assembled A snapshot.
      if (!captured.isError) {
        assert.equal(oldTerminalReturned, true, "RED capture must retain the original generation's terminal");
        assert.equal(testCase.stage === "capture_after_capture"
          ? returnedReplacementMarker : returnedOriginalMarker, true,
        "RED capture must return the exact stage-specific assistant marker and tagged digest");
      }
      assert.equal(captured.isError, true, testCase.name + " accepted a stale capture response");
      assert.match(contentText(captured), /generation changed|stale|different managed session generation/i);
    } else if (testCase.partial) {
      assert.equal(captured.isError, true, "partial generation binding must remain rejected");
      assert.match(contentText(captured), /must be supplied together/i);
    } else {
      assert.equal(captured.isError, undefined, contentText(captured));
      assert.equal(oldTerminalReturned, true);
      assert.equal(returnedOriginalMarker, true, "valid capture must return the exact original transcript");
      if (testCase.unbound) {
        assert.equal(fs.existsSync(boundaryPath(testCase.stage, "entered")), false,
          "unbound capture must not enter a paired test hook");
        assert.equal(fs.existsSync(boundaryPath(testCase.stage, "arm")), true);
      }
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const cleanup of [
      async () => { if (boundary && !boundaryReleased) releasePairedBoundary(testCase.stage, boundary.token); },
      async () => { if (capturePromise && !captureSettled) await capturePromise; },
      async () => { if (tracked.metadata) await forceStopExactDirectFixture(sessionName, expected, tracked); },
    ]) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      const cleanupError = new AggregateError(cleanupErrors, "terminal capture fixture cleanup failed",
        { cause: cleanupErrors[0] });
      if (primaryError) {
        primaryError.fixtureCleanupFailed = true;
        appendCleanupFailure(primaryError, cleanupError);
      } else {
        cleanupError.fixtureCleanupFailed = true;
        throw cleanupError;
      }
    }
  }
}

async function waitTerminalGenerationCoverage() {
  await windowsBrokerRequest("ping", {}, { env: environment });
  await pairedBoundaryPublicationCoverage();
  const cases = [
    { name: "completed-after-capture", stage: "wait_after_capture", completion: "after_capture" },
    { name: "cursor-only-completed-after-capture", stage: "wait_after_capture", completion: "after_capture", explicitPair: false },
    { name: "completed-after-posture", stage: "wait_before_terminal_check", completion: "before_wait" },
    { name: "remembered-anchor-stale-retry", stage: "wait_before_terminal_check", completion: "before_wait", rememberedAnchor: true, retryWait: true },
    { name: "newer-remembered-anchor-control", stage: "wait_before_terminal_check", completion: "before_wait", rememberedAnchor: true, replace: false, resubmitAtBoundary: true, retryWait: true, retryExpectedStatus: "timeout", expectedStatus: "completed" },
    { name: "read-attention-after-posture", stage: "wait_before_terminal_check", nonRegularLog: true },
    { name: "decision-attention-after-posture", stage: "wait_before_terminal_check", approval: true },
    { name: "timeout-after-posture", stage: "wait_before_terminal_check" },
    { name: "zero-iteration-timeout", stage: "wait_before_poll", expireBeforePoll: true },
    { name: "zero-iteration-cursor-mismatch", stage: "wait_before_poll", expireBeforePoll: true, cursorMismatch: true, replace: false },
    { name: "cursor-only-completion-control", stage: "wait_after_capture", completion: "after_capture", explicitPair: false, replace: false, expectedStatus: "completed" },
    { name: "empty-conversation-cursor-control", stage: "wait_after_capture", completion: "after_capture", explicitPair: false, cursorSessionId: "", replace: false, expectedStatus: "completed" },
    { name: "partial-pair-cursor-control", completion: "before_wait", explicitPair: false, partialCursorPair: true, replace: false, expectedStatus: "completed" },
    { name: "invalid-generation-cursor-control", explicitPair: false, invalidCursorGeneration: true, replace: false },
    { name: "legacy-cursor-timeout-control", legacyCursor: true, replace: false, expectedStatus: "timeout" },
    { name: "unbound-timeout-control", unbound: true, replace: false, expectedStatus: "timeout" },
  ];
  const failures = [];
  for (const testCase of cases) {
    try {
      await waitTerminalGenerationCase(testCase);
    } catch (error) {
      failures.push(error);
      if (error.fixtureCleanupFailed) break;
    }
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      `terminal wait generation failures: ${failures.map((error) => error.message).join("; ")}`,
      { cause: failures[0] }
    );
  }
}

async function waitTerminalGenerationCase(testCase) {
  const sessionName = `wait_terminal_${testCase.name}_${process.pid}`;
  const startLease = `${testCase.name}-start`;
  const replacementLease = `${testCase.name}-replacement`;
  const sessionId = "67676767-6767-4676-8676-676767676767";
  const otherSessionId = "78787878-7878-4787-8787-787878787878";
  const expected = { resolvedSessionId: sessionId, canonicalCwd: canonicalWorkspace };
  const tracked = { metadata: null, leaseId: startLease };
  const logFile = path.join(
    configDir, "projects", canonicalWorkspace.replace(/[^A-Za-z0-9]/g, "-"),
    `${sessionId}.jsonl`
  );
  let nonRegularLog = false;
  let savedLog = null;
  let boundary = null;
  let boundaryReleased = false;
  let waitPromise = null;
  let waitSettled = false;
  let primaryError = null;
  let completionMarker = null;
  let completionGenerationId = null;
  const restoreLog = () => {
    if (!nonRegularLog) return;
    fs.rmdirSync(logFile);
    fs.writeFileSync(logFile, savedLog);
    nonRegularLog = false;
  };
  const appendCompletion = () => {
    completionGenerationId = tracked.metadata.generationId;
    completionMarker = `synthetic-terminal-${testCase.name}-${completionGenerationId}`;
    const records = [
      { type: "user", uuid: randomUUID(), sessionId, timestamp: new Date().toISOString(), message: { role: "user", content: "synthetic terminal wait prompt" } },
      { type: "assistant", uuid: randomUUID(), sessionId, timestamp: new Date().toISOString(), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: completionMarker }] } },
    ];
    fs.appendFileSync(logFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  };
  try {
    // Reusing the conversation is intentional: only the generation pair can
    // distinguish the replacement from the original cursor's local log.
    fs.rmSync(logFile, { force: true });
    const started = await windowsBrokerRequest("start", directFixtureLaunch(
      sessionName, startLease, {
        sessionId,
        banner: testCase.approval
          ? "Do you want to proceed?\nYes, and don't ask again\nNo, and tell Claude what to do differently"
          : "Fake Claude TUI",
      }
    ), { env: environment, startIfMissing: false });
    assert.equal(started.status, "started");
    tracked.metadata = started.metadata;
    const pair = brokerGenerationPair(started.metadata);
    await waitForDirectFixtureReady(sessionName, started.metadata,
      testCase.approval ? "Do you want to proceed?" : "Fake Claude TUI");
    await releaseDirectFixtureLease(sessionName, startLease, started.metadata);
    tracked.leaseId = null;
    const submitRememberedAnchor = async (label) => {
      const submitted = await callTool("submit_prompt", {
        managedSession: sessionName,
        text: `synthetic remembered-anchor ${testCase.name} ${label}`,
        submitRetries: 0, retryDelayMs: 250,
        ...brokerGenerationPair(tracked.metadata),
      });
      assert.equal(submitted.isError, undefined, contentText(submitted));
      const submittedResult = JSON.parse(contentText(submitted));
      assert.equal(submittedResult.status, "submitted", "the public submit must create a remembered turn anchor");
      const cursor = parsePortableWaitCursor(submittedResult.waitAfterCursor);
      assert.equal(cursor.generationId, tracked.metadata.generationId);
      assert.equal(cursor.startedAtMs, tracked.metadata.startedAtMs);
      assert.equal(cursor.resolvedSessionId, sessionId);
      return submittedResult.waitAfterCursor;
    };
    if (testCase.rememberedAnchor) await submitRememberedAnchor("original");
    // Omit both the cursor and explicit pair so the public wait must consume
    // the anchor created by the real submit, rather than a test-only map seam.
    const afterCursor = testCase.unbound || testCase.rememberedAnchor ? undefined : testCase.legacyCursor
      ? "legacy-terminal-wait-cursor"
      : createPortableWaitCursor({}, {
          ...started.metadata,
          resolvedSessionId: testCase.cursorMismatch
            ? otherSessionId : testCase.cursorSessionId ?? sessionId,
          generationId: testCase.invalidCursorGeneration
            ? "not-a-generation" : started.metadata.generationId,
          startedAtMs: testCase.partialCursorPair ? null : started.metadata.startedAtMs,
        }, Date.now());
    if (testCase.completion === "before_wait") appendCompletion();
    if (testCase.nonRegularLog) {
      savedLog = fs.readFileSync(logFile);
      fs.unlinkSync(logFile);
      fs.mkdirSync(logFile);
      nonRegularLog = true;
    }
    if (testCase.stage) armPairedBoundary(testCase.stage, sessionName, pair);
    waitPromise = callTool("wait_for_claude_turn", {
      managedSession: sessionName,
      afterCursor,
      timeoutSeconds: testCase.expireBeforePoll || !testCase.completion ? 1 : 3,
      pollIntervalMs: 250,
      ...(testCase.explicitPair !== false && !testCase.legacyCursor && !testCase.unbound && !testCase.rememberedAnchor ? pair : {}),
    });
    // Observe a possible transport rejection immediately; it is still awaited
    // and propagated below, so no rejection can escape the exact cleanup.
    waitPromise.catch(() => {});
    if (testCase.stage) {
      boundary = await waitForPairedBoundary(testCase.stage);
      if (testCase.expireBeforePoll) {
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
      restoreLog();
      if (testCase.replace !== false) {
        await acquireDirectFixtureLease(sessionName, replacementLease, started.metadata);
        tracked.leaseId = replacementLease;
        const replacement = await windowsBrokerRequest("replace", {
          ...directFixtureLaunch(sessionName, replacementLease, { sessionId }),
          ...pair,
          graceful: false,
          force: true,
        }, { env: environment, startIfMissing: false });
        assert.equal(replacement.status, "started");
        tracked.metadata = replacement.metadata;
        assert.equal(replacement.metadata.resolvedSessionId, sessionId);
        assert.notEqual(replacement.metadata.generationId, started.metadata.generationId);
        await waitForDirectFixtureReady(sessionName, replacement.metadata, "Fake Claude TUI");
      }
      if (testCase.completion === "after_capture") appendCompletion();
      if (testCase.resubmitAtBoundary) await submitRememberedAnchor("newer");
      releasePairedBoundary(testCase.stage, boundary.token);
      boundaryReleased = true;
    }
    const waited = await waitPromise;
    waitSettled = true;
    let result;
    try { result = JSON.parse(contentText(waited)); } catch { result = {}; }
    const surviving = (await brokerStatus()).managedSessions.find((session) => session.name === sessionName);
    assert.equal(surviving?.generationId, tracked.metadata.generationId);
    assert.equal(surviving?.resolvedSessionId, sessionId);
    assert.equal(surviving?.exited, false, "terminal waiting must preserve the exact running generation");
    const returnedAssistant = result.transcript?.lastAssistant;
    const returnedInjectedMarker = Boolean(
      completionMarker && returnedAssistant?.text === completionMarker &&
      returnedAssistant?.textSha256 === `sha256:${createHash("sha256").update(completionMarker).digest("hex")}`
    );
    fs.writeFileSync(path.join(root, `${testCase.name}.wait-evidence.json`), `${JSON.stringify({
      case: testCase.name, status: result.status ?? null, isError: Boolean(waited.isError),
      originalGenerationId: started.metadata.generationId,
      survivingGenerationId: surviving.generationId,
      completionGenerationId, completionMarker, returnedAssistant,
      sameConversation: surviving.resolvedSessionId === sessionId,
    })}\n`);
    console.log(`wait-terminal evidence ${JSON.stringify({
      case: testCase.name, status: result.status ?? null, isError: Boolean(waited.isError),
      exactGenerationPreserved: true,
      completionSource: completionGenerationId
        ? completionGenerationId === started.metadata.generationId ? "original" : "replacement"
        : null,
      returnedInjectedMarker,
    })}`);
    if (completionMarker && !waited.isError) {
      assert.equal(returnedInjectedMarker, true, "completion must return the exact injected generation-specific assistant marker");
    }
    if (testCase.expectedStatus) {
      assert.equal(waited.isError, undefined, contentText(waited));
      assert.equal(result.status, testCase.expectedStatus);
    } else {
      assert.equal(waited.isError, true,
        `${testCase.name} accepted stale terminal status ${result.status ?? "unknown"}`);
      assert.match(contentText(waited), /generation changed|stale|different managed session generation/i);
    }
    if (testCase.retryWait) {
      if (!testCase.resubmitAtBoundary) appendCompletion();
      const retried = await callTool("wait_for_claude_turn", {
        managedSession: sessionName, timeoutSeconds: 1, pollIntervalMs: 250,
      });
      let retryResult;
      try { retryResult = JSON.parse(contentText(retried)); } catch { retryResult = {}; }
      const retrySurviving = (await brokerStatus()).managedSessions.find((session) => session.name === sessionName);
      assert.equal(retrySurviving?.generationId, tracked.metadata.generationId);
      assert.equal(retrySurviving?.resolvedSessionId, sessionId);
      assert.equal(retrySurviving?.exited, false, "retry must preserve the exact running generation");
      const retryAssistant = retryResult.transcript?.lastAssistant;
      const retryReturnedMarker = Boolean(completionMarker &&
        retryAssistant?.text === completionMarker &&
        retryAssistant?.textSha256 === `sha256:${createHash("sha256").update(completionMarker).digest("hex")}`);
      fs.writeFileSync(path.join(root, `${testCase.name}.retry-evidence.json`), `${JSON.stringify({
        case: testCase.name, status: retryResult.status ?? null, isError: Boolean(retried.isError),
        originalGenerationId: started.metadata.generationId,
        survivingGenerationId: retrySurviving.generationId,
        sameConversation: retrySurviving.resolvedSessionId === sessionId,
        completionGenerationId, completionMarker, returnedAssistant: retryAssistant, retryReturnedMarker,
        omittedCursorAndPair: true,
      })}\n`);
      console.log(`wait-anchor retry evidence ${JSON.stringify({
        case: testCase.name, status: retryResult.status ?? null, isError: Boolean(retried.isError),
        exactGenerationPreserved: true, sameConversation: true, retryReturnedMarker,
        completionSource: completionGenerationId === started.metadata.generationId ? "original" : "replacement",
        omittedCursorAndPair: true,
      })}`);
      if (testCase.retryExpectedStatus) {
        assert.equal(retried.isError, undefined, contentText(retried));
        assert.equal(retryResult.status, testCase.retryExpectedStatus,
          "the original completed wait must preserve the newer remembered anchor");
      } else {
        assert.equal(retried.isError, true,
          `${testCase.name} retry accepted replacement terminal status ${retryResult.status ?? "unknown"}`);
        assert.match(contentText(retried), /generation changed|stale|different managed session generation/i);
      }
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const cleanup of [
      async () => {
      if (boundary && !boundaryReleased) releasePairedBoundary(testCase.stage, boundary.token);
      },
      async () => {
      if (waitPromise && !waitSettled) await waitPromise;
      },
      async () => restoreLog(),
      async () => {
      if (tracked.metadata) await forceStopExactDirectFixture(sessionName, expected, tracked);
      },
    ]) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      if (primaryError) {
        primaryError.fixtureCleanupFailed = true;
        for (const error of cleanupErrors) appendCleanupFailure(primaryError, error);
      } else {
        const error = new AggregateError(cleanupErrors, "terminal wait fixture cleanup failed");
        error.fixtureCleanupFailed = true;
        throw error;
      }
    }
  }
}

async function defaultStopGenerationCoverage() {
  await conditionalStopRejectsWithoutBroker();
  await pairedReviewOperationsRejectWithoutBroker();
  await client.connect(transport, { timeout: 30000 });
  await productionBoundaryHookIsInert();
  await exitedStartupRetainsOriginalBinding();
  await startRetainsOriginalBindingWhileLeaseBlocksReplacement();
  await exactPairReplacementInjectionCoverage();
  await waitTerminalGenerationCoverage();
  await captureTerminalGenerationCoverage();

  const unpaired = await callTool("stop_remote_control", {
    managedSession,
    expectedGenerationId: "00000000-0000-4000-8000-000000000000",
  });
  assert.equal(unpaired.isError, true);
  assert.match(contentText(unpaired), /must be supplied together/);

  const initial = await callTool("start_remote_control", {
    cwd: workspace,
    managedSession,
    permissionMode: "plan",
    trustWorkspace: false,
  });
  assert.equal(initial.isError, undefined, contentText(initial));
  const initialStart = JSON.parse(contentText(initial));
  assert.equal(
    initialStart.status,
    "started",
    `initial session unexpectedly ended during startup: ${safeStartupFailureDetails(initialStart)}`
  );
  assert.ok(initialStart.sessionBinding?.generationId);
  assert.ok(Number.isSafeInteger(initialStart.sessionBinding?.startedAtMs));
  const initialMetadata = (await brokerStatus()).managedSessions.find(
    (session) => session.name === managedSession
  );
  assert.ok(initialMetadata?.generationId);
  assert.ok(Number.isSafeInteger(initialMetadata?.startedAtMs));
  assert.deepEqual(initialStart.sessionBinding, {
    generationId: initialMetadata.generationId,
    startedAtMs: initialMetadata.startedAtMs,
  });
  const conditionalMetadata = await windowsBrokerRequest(
    "conditionalMetadata",
    {
      sessionName: managedSession,
      expectedGenerationId: initialMetadata.generationId,
      expectedStartedAtMs: initialMetadata.startedAtMs,
    },
    { env: environment, startIfMissing: false }
  );
  assert.equal(conditionalMetadata.metadata.generationId, initialMetadata.generationId);
  for (const badBinding of [
    { expectedGenerationId: initialMetadata.generationId },
    { expectedStartedAtMs: initialMetadata.startedAtMs },
    {
      expectedGenerationId: initialMetadata.generationId,
      expectedStartedAtMs: initialMetadata.startedAtMs + 1,
    },
  ]) {
    await assert.rejects(
      windowsBrokerRequest(
        "conditionalMetadata",
        { sessionName: managedSession, ...badBinding },
        { env: environment, startIfMissing: false }
      ),
      (error) => ["EINVAL", "ESTALE"].includes(error?.code)
    );
  }

  const initialPair = {
    expectedGenerationId: initialStart.sessionBinding.generationId,
    expectedStartedAtMs: initialStart.sessionBinding.startedAtMs,
  };
  const pairedCursor = createPortableWaitCursor(
    {},
    {
      generationId: initialPair.expectedGenerationId,
      startedAtMs: initialPair.expectedStartedAtMs,
    },
    Date.now()
  );
  const pairedOperations = [
    [
      "capture_remote_control",
      { managedSession },
    ],
    [
      "submit_prompt",
      {
        managedSession,
        text: "partial-pair submission must not reach Claude",
        submitRetries: 0,
      },
    ],
    [
      "wait_for_claude_turn",
      { managedSession, afterCursor: pairedCursor, timeoutSeconds: 1 },
    ],
    [
      "stop_remote_control",
      { managedSession, graceful: false, force: true },
    ],
  ];
  for (const [name, arguments_] of pairedOperations) {
    for (const partialPair of [
      { expectedGenerationId: initialPair.expectedGenerationId },
      { expectedStartedAtMs: initialPair.expectedStartedAtMs },
    ]) {
      const rejected = await callTool(name, { ...arguments_, ...partialPair });
      assert.equal(rejected.isError, true, `${name} must reject a partial pair`);
      assert.match(contentText(rejected), /must be supplied together|expected generation/i);
    }
  }

  const pairedCapture = await callTool("capture_remote_control", {
    managedSession,
    ...initialPair,
  });
  assert.equal(pairedCapture.isError, undefined, contentText(pairedCapture));
  const pairedSubmit = await callTool("submit_prompt", {
    managedSession,
    text: "paired generation synthetic prompt",
    submitRetries: 0,
    ...initialPair,
  });
  assert.equal(pairedSubmit.isError, undefined, contentText(pairedSubmit));
  const pairedSubmitResult = JSON.parse(contentText(pairedSubmit));
  assert.ok(pairedSubmitResult.waitAfterCursor);
  assert.match(
    parsePortableWaitCursor(pairedSubmitResult.waitAfterCursor).resolvedSessionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "a paired submission cursor must carry its resolved Claude session identity"
  );
  const pairedWait = await callTool("wait_for_claude_turn", {
    managedSession,
    afterCursor: pairedSubmitResult.waitAfterCursor,
    timeoutSeconds: 1,
    ...initialPair,
  });
  assert.equal(pairedWait.isError, undefined, contentText(pairedWait));
  const missingCursorIdentity = await callTool("wait_for_claude_turn", {
    managedSession,
    afterCursor: createPortableWaitCursor(
      {},
      {
        generationId: initialPair.expectedGenerationId,
        startedAtMs: initialPair.expectedStartedAtMs,
      },
      Date.now()
    ),
    timeoutSeconds: 1,
    ...initialPair,
  });
  assert.equal(
    missingCursorIdentity.isError,
    true,
    "a paired wait must reject a cursor without a resolved Claude session identity"
  );
  assert.match(contentText(missingCursorIdentity), /exact cursor|session identity/i);
  for (const [name, arguments_] of pairedOperations) {
    const wrongStartedAtMs = initialPair.expectedStartedAtMs + 1;
    const exactWrongStartArguments = name === "wait_for_claude_turn"
      ? {
          ...arguments_,
          afterCursor: createPortableWaitCursor(
            {},
            {
              generationId: initialPair.expectedGenerationId,
              startedAtMs: wrongStartedAtMs,
            },
            Date.now()
          ),
        }
      : arguments_;
    const rejected = await callTool(name, {
      ...exactWrongStartArguments,
      expectedGenerationId: initialPair.expectedGenerationId,
      expectedStartedAtMs: wrongStartedAtMs,
    });
    assert.equal(
      rejected.isError,
      true,
      `${name} must reject the same generation with a different start time`
    );
    assert.match(contentText(rejected), /exact cursor|generation changed|stale/i);
  }
  for (const afterCursor of [
    createPortableWaitCursor(
      {},
      {
        generationId: "00000000-0000-4000-8000-000000000000",
        startedAtMs: initialStart.sessionBinding.startedAtMs,
      },
      Date.now()
    ),
    createPortableWaitCursor(
      {},
      { generationId: initialStart.sessionBinding.generationId },
      Date.now()
    ),
  ]) {
    const rejected = await callTool("wait_for_claude_turn", {
      managedSession,
      afterCursor,
      timeoutSeconds: 1,
      expectedGenerationId: initialStart.sessionBinding.generationId,
      expectedStartedAtMs: initialStart.sessionBinding.startedAtMs,
    });
    assert.equal(rejected.isError, true, "a paired wait must reject a foreign or legacy cursor");
    assert.match(contentText(rejected), /exact cursor|generation|stale/i);
  }

  const initialExitSnapshot = async () => {
    try {
      const session = (await brokerStatus()).managedSessions.find((candidate) => candidate.name === managedSession);
      return {
        at: new Date().toISOString(), readable: true, present: Boolean(session), exited: session?.exited ?? null,
        exitCode: session?.exitCode ?? null,
        generationMatchesInitial: session?.generationId === initialMetadata.generationId && session?.startedAtMs === initialMetadata.startedAtMs,
        syntheticTuple: session ? { pid: session.pid, generationId: session.generationId, startedAtMs: session.startedAtMs, resolvedSessionId: session.resolvedSessionId } : null,
      };
    } catch { return { at: new Date().toISOString(), readable: false }; }
  };
  const initialExitDiagnostic = {
    before: await initialExitSnapshot(),
    expectedSyntheticTuple: { generationId: initialMetadata.generationId, startedAtMs: initialMetadata.startedAtMs, resolvedSessionId: initialMetadata.resolvedSessionId },
  };
  const initialExitDiagnosticFile = path.join(root, "initial-exit-status.json");
  fs.writeFileSync(initialExitDiagnosticFile, `${JSON.stringify(initialExitDiagnostic, null, 2)}\n`);
  const initialExit = await callTool("send_text", {
    managedSession,
    text: "/exit",
    submit: true,
  });
  initialExitDiagnostic.after = await initialExitSnapshot();
  initialExitDiagnostic.sendTextIsError = initialExit.isError === true;
  fs.writeFileSync(initialExitDiagnosticFile, `${JSON.stringify(initialExitDiagnostic, null, 2)}\n`);
  assert.equal(initialExit.isError, undefined, contentText(initialExit));
  let exited = null;
  const exitDeadline = Date.now() + 5000;
  while (!exited?.exited && Date.now() < exitDeadline) {
    exited = (await brokerStatus()).managedSessions.find(
      (session) => session.name === managedSession
    );
    if (!exited?.exited) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(exited?.generationId, initialMetadata.generationId);
  assert.equal(exited?.exited, true, "the original generation must exit before name reuse");

  const replacement = await callTool("start_remote_control", {
    cwd: workspace,
    managedSession,
    permissionMode: "plan",
    trustWorkspace: false,
    killExisting: true,
  });
  assert.equal(replacement.isError, undefined, contentText(replacement));
  const replacementStart = JSON.parse(contentText(replacement));
  assert.equal(
    replacementStart.status,
    "started",
    `replacement unexpectedly ended during startup: ${safeStartupFailureDetails(replacementStart)}`
  );
  const replacementMetadata = (await brokerStatus()).managedSessions.find(
    (session) => session.name === managedSession
  );
  assert.ok(replacementMetadata?.generationId);
  assert.notEqual(replacementMetadata.generationId, initialMetadata.generationId);
  assert.deepEqual(replacementStart.sessionBinding, {
    generationId: replacementMetadata.generationId,
    startedAtMs: replacementMetadata.startedAtMs,
  });
  await assert.rejects(
    windowsBrokerRequest(
      "conditionalMetadata",
      {
        sessionName: managedSession,
        expectedGenerationId: initialPair.expectedGenerationId,
        expectedStartedAtMs: initialPair.expectedStartedAtMs,
      },
      { env: environment, startIfMissing: false }
    ),
    (error) => error?.code === "ESTALE",
    "conditionalMetadata must reject the original pair after same-name replacement"
  );

  for (const [name, arguments_] of [
    [
      "capture_remote_control",
      {
        managedSession,
        expectedGenerationId: initialStart.sessionBinding.generationId,
        expectedStartedAtMs: initialStart.sessionBinding.startedAtMs,
      },
    ],
    [
      "submit_prompt",
      {
        managedSession,
        text: "replacement timing regression",
        expectedGenerationId: initialStart.sessionBinding.generationId,
        expectedStartedAtMs: initialStart.sessionBinding.startedAtMs,
      },
    ],
    [
      "wait_for_claude_turn",
      {
        managedSession,
        afterCursor: createPortableWaitCursor(
          {},
          {
            ...initialStart.sessionBinding,
            resolvedSessionId: initialMetadata.resolvedSessionId,
          },
          Date.now()
        ),
        timeoutSeconds: 1,
        expectedGenerationId: initialStart.sessionBinding.generationId,
        expectedStartedAtMs: initialStart.sessionBinding.startedAtMs,
      },
    ],
    [
      "rename_claude_session",
      {
        managedSession,
        title: "Stale rename forbidden",
        expectedGenerationId: initialStart.sessionBinding.generationId,
        expectedStartedAtMs: initialStart.sessionBinding.startedAtMs,
      },
    ],
  ]) {
    const stale = await callTool(name, arguments_);
    assert.equal(stale.isError, true, `${name} must reject the replaced generation`);
    assert.match(contentText(stale), /generation changed|stale/i);
  }
  const replacementStillRunning = (await brokerStatus()).managedSessions.find(
    (session) => session.name === managedSession
  );
  assert.equal(replacementStillRunning?.generationId, replacementMetadata.generationId);
  assert.equal(replacementStillRunning?.exited, false);
  const replacementCapture = await callTool("capture_remote_control", {
    managedSession,
    expectedGenerationId: replacementMetadata.generationId,
    expectedStartedAtMs: replacementMetadata.startedAtMs,
  });
  assert.equal(replacementCapture.isError, undefined, contentText(replacementCapture));
  assert.equal(
    contentText(replacementCapture).includes("Stale rename forbidden"),
    false,
    "a stale rename must not send title text to the replacement generation"
  );

  // The stale stop must be rejected by exact broker lease acquisition before
  // the handler can capture or stop the replacement generation.
  const staleStop = await callTool("stop_remote_control", {
    managedSession,
    graceful: false,
    force: true,
    expectedGenerationId: initialMetadata.generationId,
    expectedStartedAtMs: initialMetadata.startedAtMs,
  });
  assert.equal(staleStop.isError, true);
  assert.match(contentText(staleStop), /generation changed|stale/i);
  const surviving = (await brokerStatus()).managedSessions.find(
    (session) => session.name === managedSession
  );
  assert.equal(surviving?.generationId, replacementMetadata.generationId);
  assert.equal(surviving?.exited, false);

  const stopped = await callTool("stop_remote_control", {
    managedSession,
    graceful: true,
    force: true,
    expectedGenerationId: replacementMetadata.generationId,
    expectedStartedAtMs: replacementMetadata.startedAtMs,
  });
  assert.equal(stopped.isError, undefined, contentText(stopped));
  assert.equal(JSON.parse(contentText(stopped)).status, "stopped");
  await exactStopIdentityCoverage();
  await publicStopIdentityCoverage();
  await publicGracefulTimeoutIdentityCoverage();
}

const focusedWaitTerminal = process.argv.includes("--wait-terminal-generation-only");
const focusedCaptureTerminal = process.argv.includes("--capture-terminal-generation-only");
let primaryError = null;
try {
  if (focusedCaptureTerminal) {
    await client.connect(transport, { timeout: 30000 });
    await productionBoundaryHookIsInert();
    await captureTerminalGenerationCoverage();
  } else if (focusedWaitTerminal) {
    await client.connect(transport, { timeout: 30000 });
    await waitTerminalGenerationCoverage();
  } else {
    await defaultStopGenerationCoverage();
  }
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  let cleanupError = null;
  try {
    await client.close();
  } catch {
    // The client may have failed before connecting.
  }
  // No test calls can launch more children after its clients close. Reap only
  // exact ledger-owned children, including detached ConPTY grandchildren.
  for (const ledger of fixtureLedgers) {
    try { await ledger.reap({ expectRecords: false, final: true }); }
    catch (error) { cleanupError ??= error; }
  }
  for (const cleanupEnvironment of cleanupEnvironments) {
    try {
      let status;
      const settling = Date.now() + 5000;
      do {
        status = await windowsBrokerRequest("status", {}, { env: cleanupEnvironment, startIfMissing: false, timeoutMs: 5000 });
        if (status.managedSessions.every((session) => session.exited)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < settling);
      assert.ok(status.managedSessions.every((session) => session.exited), "test-owned broker still has a running fixture");
      const shutdown = await windowsBrokerRequest("shutdown", {}, { env: cleanupEnvironment, startIfMissing: false, timeoutMs: 5000 });
      const ownedBrokerPid = shutdown.pid ?? status.pid;
      assert.ok(Number.isSafeInteger(ownedBrokerPid) && ownedBrokerPid > 0, "dedicated test broker PID must be readable");
      let exited = false;
      const deadline = Date.now() + 5000;
      do {
        try { process.kill(ownedBrokerPid, 0); }
        catch (error) { if (error.code === "ESRCH") { exited = true; break; } throw error; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      assert.ok(exited, "dedicated test broker must exit before cleanup");
    } catch (error) {
      if (error.code !== "ENOENT") cleanupError ??= error;
    }
  }
  if (!cleanupError) {
    for (const ledger of fixtureLedgers) {
      try {
        await ledger.reap({ expectRecords: false, graceMs: 0 });
      } catch (error) { cleanupError ??= error; }
    }
  }
  if (!cleanupError && !primaryError) {
    try { await removeOwnedTestRoot(); }
    catch (error) { cleanupError = error; }
  }
  if (primaryError) {
    try {
      const diagnostic = JSON.parse(fs.readFileSync(path.join(root, "initial-exit-status.json"), "utf8"));
      const summary = (value = {}) => ({ readable: value.readable, present: value.present, exited: value.exited, exitCode: value.exitCode, generationMatchesInitial: value.generationMatchesInitial });
      console.error(`stop-generation fixture status: ${JSON.stringify({ before: summary(diagnostic.before), after: summary(diagnostic.after), sendTextIsError: diagnostic.sendTextIsError })}`);
    } catch { /* Earlier failures may precede this diagnostic checkpoint. */ }
    primaryError.message += `\nSynthetic fixture diagnostics preserved at ${root}`;
  }
  if (cleanupError) appendCleanupFailure(primaryError, cleanupError);
}
console.log("stop-generation ok");
