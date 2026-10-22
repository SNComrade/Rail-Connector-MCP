import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { windowsBrokerRequest, windowsBrokerPaths, windowsBrokerLaunchPolicyFingerprint,
  WINDOWS_BROKER_VERSION } from "../src/windows-broker-client.js";
import { createFixtureProcessLedger } from "./fixtures/fixture-process-ledger.mjs";
import {
  createPortableWaitCursor,
  expectedManagedGeneration,
  expectedStopIdentity,
  expectedStopGeneration,
  parsePortableWaitCursor,
  withManagedMutationLock, withRequestSignal, runSubmitPrompt,
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


async function cancellationMutationCoverage() {
  const controller = new AbortController();
  let textCalls = 0;
  let keyCalls = 0;
  let captures = 0;
  await assert.rejects(withRequestSignal(controller.signal, () => runSubmitPrompt({
    managedSession: "synthetic-cancel-submit", text: "synthetic inert prompt", submitRetries: 2,
  }, {
    isNativeWindows: true,
    capture: async () => { captures++; return "> "; },
    runtimeObservation: async () => ({ workflowActivity: {} }),
    sendText: async () => { textCalls++; controller.abort(); return { bracketedPasteUsed: true }; },
    sendKey: async () => { keyCalls++; },
    promptAcknowledged: async () => false,
  })), (error) => error.code === "ECANCELLED");
  assert.equal(textCalls, 1);
  assert.equal(captures, 1, "cancellation after delivery must not begin acknowledgement/retry work");
  assert.equal(keyCalls, 0, "cancellation after delivery must not submit a later Enter");
  console.log("stop-generation cancellation after delivery prevents later Enter/retry ok (inert injected backend)");
  if (process.platform !== "win32") return;

  for (const mode of ["delayed-grant", "lost-grant-known", "lost-grant-unknown", "lost-release", "read-abort", "busy-cancel", "undispatched-fallback",
    "upgrade-lost-grant-known", "upgrade-lost-grant-unknown", "upgrade-lost-grant-stale", "send-lost-ack", "send-lost-ack-mcp"]) {
    const upgrading = mode.startsWith("upgrade-");
    const unknownPair = mode === "lost-grant-unknown" || mode === "upgrade-lost-grant-unknown";
    const fixtureState = path.join(root, "cancel-" + mode);
    fs.mkdirSync(fixtureState, { recursive: true });
    const token = randomUUID().replaceAll("-", "").repeat(2);
    const env = { ...process.env, RAIL_CONNECTOR_STATE_DIR: fixtureState,
      ...(mode === "send-lost-ack-mcp" ? { CLAUDE_CONFIG_DIR: path.join(fixtureState, "config"),
        RAIL_CONNECTOR_ALLOWED_ROOTS: repoRoot, RAIL_CONNECTOR_CLAUDE_PATH: wrapper } : {}) };
    const paths = windowsBrokerPaths(env, token);
    fs.writeFileSync(paths.tokenFile, token, { flag: "wx" });
    const pair = { expectedGenerationId: "00000000-0000-4000-8000-000000000000", expectedStartedAtMs: 12345 };
    const records = [];
    const sockets = new Set();
    let grant;
    let release;
    let productCalls = 0;
    let acquireCalls = 0;
    let submitCaptures = 0;
    let submitKeys = 0;
    let submitAcknowledgements = 0;
    const promptMarker = "owned synthetic lost-ack prompt";
    let heldRead;
    const broker = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        records.push({ operation: request.operation, payload: request.payload });
        const reply = (result) => socket.end(JSON.stringify({ ok: true, result }) + "\n");
        if (request.operation === "ping") reply({
          version: WINDOWS_BROKER_VERSION, launchPolicyFingerprint: windowsBrokerLaunchPolicyFingerprint(env),
        });
        else if (request.operation === "acquireLease") {
          acquireCalls++;
          if (upgrading && acquireCalls === 1) socket.end(JSON.stringify({ ok: false, code: "EBROKERUPGRADE", error: "synthetic acquire upgrade" }) + "\n");
          else if (mode === "busy-cancel") reply({ status: "busy", generationId: pair.expectedGenerationId, startedAtMs: pair.expectedStartedAtMs });
          else if (mode.includes("lost-grant")) socket.destroy();
          else if (mode === "delayed-grant") grant = () => reply({
            status: "acquired", generationId: pair.expectedGenerationId, startedAtMs: pair.expectedStartedAtMs,
          });
          else reply({ status: "acquired", generationId: pair.expectedGenerationId, startedAtMs: pair.expectedStartedAtMs });
        } else if (request.operation === "releaseLease") {
          if (mode === "lost-release") socket.destroy();
          else if (mode === "upgrade-lost-grant-stale") socket.end(JSON.stringify({ ok: false, code: "ESTALE", error: "synthetic generation changed" }) + "\n");
          else if (mode === "delayed-grant") release = () => reply({ status: "released" });
          else reply({ status: "released" });
        } else if (request.operation === "status" && mode.startsWith("send-lost-ack")) {
          reply({ version: WINDOWS_BROKER_VERSION, launchPolicyFingerprint: windowsBrokerLaunchPolicyFingerprint(env),
            managedSessions: [{ name: "synthetic-cancellation-lease", cwd: repoRoot, canonicalCwd: canonicalWorkspace,
              generationId: pair.expectedGenerationId, startedAtMs: pair.expectedStartedAtMs, exited: false }] });
        } else if (request.operation === "sendText" && mode.startsWith("send-lost-ack")) {
          socket.destroy();
        } else if (request.operation === "capture") {
          if (mode === "send-lost-ack-mcp") reply({ capture: "> " });
          else if (request.payload.lines === 21) reply({ capture: "synthetic peer" });
          else heldRead = socket;
        } else assert.fail("unexpected fake operation " + request.operation);
      });
    });
    if (mode !== "undispatched-fallback") {
      await new Promise((resolve, reject) => { broker.once("error", reject); broker.listen(paths.pipeName, resolve); });
    }
    const priorState = process.env.RAIL_CONNECTOR_STATE_DIR;
    process.env.RAIL_CONNECTOR_STATE_DIR = fixtureState;
    const cancelled = new AbortController();
    let pending;
    let outcomeClient;
    let outcomeTransport;
    try {
      if (mode === "read-abort") {
        pending = windowsBrokerRequest("capture", { lines: 20 }, {
          env, startIfMissing: false, signal: cancelled.signal,
        }).then((value) => ({ value }), (error) => ({ error }));
        await waitCancellationFixture(() => heldRead, "read must dispatch before cancellation");
        const peer = windowsBrokerRequest("capture", { lines: 21 }, { env, startIfMissing: false });
        const at = performance.now();
        cancelled.abort();
        const outcome = await pending;
        assert.equal(outcome.error?.code, "ECANCELLED");
        assert.equal(outcome.error.brokerRequestDispatched, true);
        assert.ok(performance.now() - at < 1000);
        assert.equal((await peer).capture, "synthetic peer");
      } else {
        if (mode === "send-lost-ack-mcp") {
          outcomeTransport = new StdioClientTransport({ command: process.execPath, args: ["src/index.js"],
            cwd: repoRoot, env, stderr: "pipe" });
          outcomeClient = new Client({ name: "owned-cancellation-outcome", version: "1.0.0" }, { capabilities: {} });
          await outcomeClient.connect(outcomeTransport);
          pending = outcomeClient.callTool({ name: "send_text", arguments: {
            managedSession: "synthetic-cancellation-lease", text: promptMarker, submit: true,
          } }).then((value) => ({ value }), (error) => ({ error }));
        } else pending = withRequestSignal(cancelled.signal, () => withManagedMutationLock(
          "synthetic-cancellation-lease", async () => {
            productCalls++;
            if (mode !== "send-lost-ack") return { synthetic: true };
            // Keep the actual index backendSendText/windowsBrokerRequest chain.
            // Only observation/ack fixtures are inert; no real session exists.
            return runSubmitPrompt({ managedSession: "synthetic-cancellation-lease", text: promptMarker, submitRetries: 2 }, {
              capture: async () => { submitCaptures++; return "> "; },
              runtimeObservation: async () => ({ workflowActivity: {} }),
              sendKey: async () => { submitKeys++; },
              promptAcknowledged: async () => { submitAcknowledgements++; return false; },
            });
          },
          { ...(unknownPair || mode === "undispatched-fallback" ? {} : { expectedGeneration: pair }),
            ...(upgrading ? { allowMissingBackend: true } : {}) }
        )).then((value) => ({ value }), (error) => ({ error }));
        if (mode !== "undispatched-fallback") {
          await waitCancellationFixture(() => records.some((record) => record.operation === "acquireLease"), "acquire must dispatch");
        }
        if (mode === "busy-cancel") cancelled.abort();
        if (mode === "delayed-grant") {
          let settled = false;
          pending.then(() => { settled = true; });
          cancelled.abort();
          await new Promise((resolve) => setTimeout(resolve, 25));
          assert.equal(settled, false, "dispatched acquire must not be aborted/abandoned");
          grant();
          await waitCancellationFixture(() => release, "granted cancelled lease must release exact pair");
          assert.equal(settled, false, "release acknowledgement belongs to finally");
          release();
        }
        const outcome = await pending;
        if (mode === "undispatched-fallback") {
          assert.equal(outcome.error, undefined);
          assert.deepEqual(outcome.value, { synthetic: true });
        } else if (mode === "busy-cancel") {
          assert.equal(outcome.error?.code, "ECANCELLED");
          assert.equal(outcome.error.controlOutcome.lease, "not_acquired");
        } else if (mode === "delayed-grant") {
          assert.equal(outcome.error?.code, "ECANCELLED");
          assert.equal(outcome.error.controlOutcome.lease, "released");
        } else if (mode === "send-lost-ack") {
          assert.equal(outcome.error?.code, "EMUTATIONUNKNOWN", "actual index wrapper must classify lost mutation acknowledgement");
          assert.equal(outcome.error.controlOutcome.delivery, "possibly_delivered");
          assert.equal(outcome.error.controlOutcome.lease, "acquired", "direct error is a dispatch-time snapshot, not final cleanup evidence");
          const diagnostic = JSON.stringify({ code: outcome.error.code, message: outcome.error.message, controlOutcome: outcome.error.controlOutcome });
          for (const excluded of [promptMarker, "synthetic-cancellation-lease", token]) assert.equal(diagnostic.includes(excluded), false, "outcome diagnostic must omit input and identities");
          assert.equal(submitCaptures, 1, "lost delivery ack must stop before later capture/ack/retry work");
          assert.equal(submitKeys, 0, "lost delivery ack must not begin another Enter");
          assert.equal(submitAcknowledgements, 0);
          assert.equal(records.filter((record) => record.operation === "sendText").length, 1, "ambiguous sendText must never replay");
        } else if (mode === "send-lost-ack-mcp") {
          assert.equal(outcome.error, undefined);
          assert.equal(outcome.value.isError, true);
          assert.match(contentText(outcome.value), /Broker mutation outcome is unknown/);
          assert.deepEqual(outcome.value._meta?.["rail-connector/control-outcome"], {
            delivery: "possibly_delivered", lease: "released",
          }, "actual emitted MCP metadata must reflect completed exact lease cleanup");
          const diagnostic = JSON.stringify(outcome.value);
          for (const excluded of [promptMarker, "synthetic-cancellation-lease", token]) assert.equal(diagnostic.includes(excluded), false, "emitted outcome must omit input and identities");
          assert.equal(records.filter((record) => record.operation === "sendText").length, 1);
          assert.equal(records.filter((record) => record.operation === "capture").length, 1, "MCP lost ack must not begin later capture work");
          assert.equal(records.some((record) => /sendKey/i.test(record.operation)), false, "MCP lost ack must not send later Enter");
          console.log("stop-generation emitted lost-ack outcome " + JSON.stringify(outcome.value._meta["rail-connector/control-outcome"]));
        } else {
          assert.equal(outcome.error?.code, "ELEASEUNKNOWN");
          assert.equal(outcome.error.controlOutcome.lease,
            mode === "upgrade-lost-grant-stale" ? "generation_changed" : unknownPair || mode === "lost-release" ? "unknown" : "released");
        }
        assert.equal(productCalls, ["lost-release", "undispatched-fallback", "send-lost-ack"].includes(mode) ? 1 : 0);
        const acquisitions = records.filter((record) => record.operation === "acquireLease");
        const releases = records.filter((record) => record.operation === "releaseLease");
        assert.equal(acquisitions.length, mode === "undispatched-fallback" ? 0 : upgrading ? 2 : 1, "possible delivery never authorizes another acquisition");
        assert.equal(releases.length, unknownPair || ["busy-cancel", "undispatched-fallback"].includes(mode) ? 0 : 1);
        for (const record of releases) {
          assert.equal(record.payload.leaseId, acquisitions[0].payload.leaseId);
          assert.equal(record.payload.expectedGenerationId, pair.expectedGenerationId);
          assert.equal(record.payload.expectedStartedAtMs, pair.expectedStartedAtMs);
        }
      }
    } finally {
      grant?.(); release?.();
      await outcomeClient?.close();
      await outcomeTransport?.close();
      const closed = [...sockets].map((socket) => new Promise((resolve) => {
        socket.once("close", resolve);
        socket.destroy();
      }));
      if (priorState === undefined) delete process.env.RAIL_CONNECTOR_STATE_DIR;
      else process.env.RAIL_CONNECTOR_STATE_DIR = priorState;
      if (pending) await pending;
      await Promise.all(closed);
      if (broker.listening) await new Promise((resolve) => broker.close(resolve));
      assert.equal(sockets.size, 0, "all exact-owned fake pipe connections must close");
    }
    console.log("stop-generation " + mode + " exact-owned native pipe contract ok (fake broker)");
  }
  await authoritativeLeaseRefusalCoverage();
  await incompatibleCleanupCancellationCoverage();
  await uncertainSubmissionAnchorCoverage();
  await uncertainStartLeaseCoverage();
}

async function authoritativeLeaseRefusalCoverage() {
  for (const mode of ["stale", "invalid", "upgrade", "upgrade-then-undispatched", "cancelled-refusal"]) {
    const fixtureState = path.join(root, "negative-acquire-" + mode);
    fs.mkdirSync(fixtureState, { recursive: true });
    const env = { ...process.env, RAIL_CONNECTOR_STATE_DIR: fixtureState,
      CLAUDE_CONFIG_DIR: path.join(fixtureState, "config"), RAIL_CONNECTOR_ALLOWED_ROOTS: repoRoot,
      RAIL_CONNECTOR_CLAUDE_PATH: wrapper };
    const noSpawn = path.join(fixtureState, "no-subprocess.mjs");
    fs.writeFileSync(noSpawn, [
      'import childProcess from "node:child_process";',
      'import { syncBuiltinESMExports } from "node:module";',
      'for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {',
      '  childProcess[key] = () => { throw new Error("Owned refusal fixture forbids all subprocess launches"); };',
      '}',
      'syncBuiltinESMExports();',
    ].join("\n"));
    const token = randomUUID().replaceAll("-", "").repeat(2);
    const paths = windowsBrokerPaths(env, token);
    fs.writeFileSync(paths.tokenFile, token, { flag: "wx" });
    const records = [];
    const sockets = new Set();
    let sendRefusal;
    let refusalSent = false;
    let brokerClosing;
    const code = mode.startsWith("upgrade") ? "EBROKERUPGRADE" : mode === "invalid" ? "EINVAL" : "ESTALE";
    const broker = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        records.push(request.operation);
        if (request.operation === "ping") {
          socket.end(JSON.stringify({ ok: true, result: { version: WINDOWS_BROKER_VERSION,
            launchPolicyFingerprint: windowsBrokerLaunchPolicyFingerprint(env) } }) + "\n");
        } else if (request.operation === "acquireLease") {
          const refuse = () => {
            if (refusalSent) return;
            refusalSent = true;
            socket.end(JSON.stringify({ ok: false, code, error: "synthetic authoritative refusal" }) + "\n");
            if (mode === "upgrade-then-undispatched") {
              // Readiness remains freshly cached. Stop only this exact-owned
              // fake listener so retry fails before write, without a startup.
              brokerClosing = new Promise((resolve) => broker.close(resolve));
            }
          };
          if (mode === "cancelled-refusal") sendRefusal = refuse;
          else refuse();
        } else assert.fail("refused lease must not dispatch " + request.operation);
      });
    });
    await new Promise((resolve, reject) => { broker.once("error", reject); broker.listen(paths.pipeName, resolve); });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", pathToFileURL(noSpawn).href, "src/index.js"], cwd: repoRoot, env, stderr: "pipe" });
    const client = new Client({ name: "owned-authoritative-refusal", version: "1.0.0" }, { capabilities: {} });
    let stderr = "";
    transport.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-16384); });
    const send = transport.send.bind(transport);
    let toolId;
    transport.send = (message, options) => {
      if (message.method === "tools/call") toolId = message.id;
      return send(message, options);
    };
    let pending;
    try {
      await client.connect(transport);
      // The upgrade fallback's operation rejects these incompatible selectors
      // before any CLI, transcript lookup, start or other product action.
      pending = client.callTool(mode === "upgrade-then-undispatched"
        ? { name: "start_remote_control", arguments: { managedSession: "synthetic-refused-start", cwd: repoRoot,
          sessionId: "11111111-1111-4111-8111-111111111111", continueLatest: true } }
        : { name: "send_text", arguments: { managedSession: "synthetic-refused-mutation", text: "owned inert input" } })
        .then((value) => ({ value }), (error) => ({ error }));
      if (mode === "cancelled-refusal") {
        await waitCancellationFixture(() => sendRefusal, "acquire must be in flight before cancellation");
        await client.notification({ method: "notifications/cancelled", params: { requestId: toolId } });
        // Public FIFO protocol barrier proves cancellation was processed before
        // the authoritative negative acquisition reply is released.
        await client.listTools();
        sendRefusal();
        await client.close();
        await transport.close();
        assert.equal((await pending).value, undefined, "cancelled request must not emit a late response");
        assert.equal(stderr.includes("cancelled_request_cleanup"), false,
          "a refused acquire must not emit a spurious unknown-lease cleanup diagnostic");
      } else {
        const outcome = await pending;
        assert.equal(outcome.error, undefined);
        assert.equal(outcome.value.isError, true);
        assert.match(contentText(outcome.value), mode === "upgrade-then-undispatched" ? /mutually exclusive/ : /synthetic authoritative refusal/);
        assert.equal(outcome.value._meta?.["rail-connector/control-outcome"], undefined,
          "authoritative refusal plus undispatched delivery must leave no acquired/unknown outcome metadata");
      }
      assert.equal(records.filter((operation) => operation === "acquireLease").length, 1);
      assert.equal(records.some((operation) => operation !== "ping" && operation !== "acquireLease"), false,
        "no mutation/release follows an authoritative refusal");
    } finally {
      sendRefusal?.();
      await client.close();
      await transport.close();
      if (pending) await pending;
      const closing = [...sockets].map((socket) => new Promise((resolve) => { socket.once("close", resolve); socket.destroy(); }));
      await Promise.all(closing);
      if (broker.listening) await new Promise((resolve) => broker.close(resolve));
      await brokerClosing;
      assert.equal(sockets.size, 0);
    }
    console.log("stop-generation authoritative acquire " + mode + " final disposition ok (actual MCP/fake broker)");
  }
}

async function incompatibleCleanupCancellationCoverage() {
  for (const mode of ["before-acquire-cancel", "busy-cancel", "delayed-grant-cancel", "success",
    "lost-acquire-ack", "lost-stop-ack", "lost-release-ack"]) {
    const fixtureState = path.join(root, "incompatible-cleanup-" + mode);
    fs.mkdirSync(fixtureState, { recursive: true });
    const env = { ...process.env, RAIL_CONNECTOR_STATE_DIR: fixtureState,
      CLAUDE_CONFIG_DIR: path.join(fixtureState, "config"), RAIL_CONNECTOR_ALLOWED_ROOTS: repoRoot,
      RAIL_CONNECTOR_CLAUDE_PATH: wrapper };
    const noSpawn = path.join(fixtureState, "no-subprocess.mjs");
    fs.writeFileSync(noSpawn, [
      'import childProcess from "node:child_process";',
      'import { syncBuiltinESMExports } from "node:module";',
      'for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {',
      '  childProcess[key] = () => { throw new Error("Owned compatibility fixture forbids subprocess launches"); };',
      '}',
      'syncBuiltinESMExports();',
    ].join("\n"));
    const token = randomUUID().replaceAll("-", "").repeat(2);
    const paths = windowsBrokerPaths(env, token);
    fs.writeFileSync(paths.tokenFile, token, { flag: "wx" });
    const sessionName = "synthetic-incompatible-cleanup";
    const pair = { expectedGenerationId: "00000000-0000-4000-8000-000000000000",
      expectedStartedAtMs: Date.now() - 10_000 };
    const records = [];
    const sockets = new Set();
    let gate;
    let fixtureError;
    const broker = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      let buffer = "";
      let handled = false;
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (handled || !buffer.includes("\n")) return;
        handled = true;
        try {
          const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          assert.equal(request.token, token);
          records.push({ operation: request.operation, payload: request.payload });
          const reply = (result) => {
            if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, result }) + "\n");
          };
          if (request.operation === "status") {
            const status = () => reply({ protocol: 1, version: "synthetic-incompatible-broker",
              launchPolicyFingerprint: windowsBrokerLaunchPolicyFingerprint(env), pid: process.pid,
              managedSessions: [{ name: sessionName, cwd: repoRoot, canonicalCwd: canonicalWorkspace,
                generationId: pair.expectedGenerationId, startedAtMs: pair.expectedStartedAtMs,
                exited: false, args: [] }] });
            if (mode === "before-acquire-cancel") gate = status;
            else status();
          } else if (request.operation === "acquireCleanupLease") {
            const grant = () => reply({ status: mode === "busy-cancel" ? "busy" : "acquired" });
            if (mode === "lost-acquire-ack") socket.destroy();
            else if (mode === "busy-cancel" || mode === "delayed-grant-cancel") gate = grant;
            else grant();
          } else if (request.operation === "cleanupStop") {
            if (mode === "lost-stop-ack") socket.destroy();
            else reply({ status: "stopped", exitCode: 0 }); // Synthetic receipt, not native exit proof.
          } else if (request.operation === "releaseCleanupLease") {
            if (mode === "lost-release-ack") socket.destroy();
            else reply({ status: "released" });
          } else assert.fail("unexpected compatibility operation " + request.operation);
        } catch (error) {
          fixtureError ??= error;
          socket.destroy();
        }
      });
    });
    await new Promise((resolve, reject) => { broker.once("error", reject); broker.listen(paths.pipeName, resolve); });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", pathToFileURL(noSpawn).href, "src/index.js"], cwd: repoRoot, env, stderr: "pipe" });
    const client = new Client({ name: "owned-incompatible-cleanup", version: "1.0.0" }, { capabilities: {} });
    let stderr = "";
    transport.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-16384); });
    const send = transport.send.bind(transport);
    let toolId;
    transport.send = (message, options) => {
      if (message.method === "tools/call") toolId = message.id;
      return send(message, options);
    };
    let pending;
    let responses = 0;
    try {
      await client.connect(transport);
      const onmessage = transport.onmessage;
      transport.onmessage = (message, extra) => {
        if (message.id === toolId && (message.result || message.error)) responses++;
        onmessage?.(message, extra);
      };
      pending = client.callTool({ name: "stop_remote_control", arguments: {
        managedSession: sessionName, graceful: false, force: true,
      } }, undefined, { timeout: 15000 }).then((value) => ({ value }), (error) => ({ error }));
      if (mode.endsWith("-cancel")) {
        await waitCancellationFixture(() => gate, "compatibility request must reach its gated boundary");
        await client.notification({ method: "notifications/cancelled", params: { requestId: toolId } });
        await client.listTools(); // Public FIFO barrier before the status/acquire reply is released.
        gate(); gate = undefined;
        if (mode === "delayed-grant-cancel") {
          await waitCancellationFixture(() => records.some((r) => r.operation === "releaseCleanupLease"),
            "a grant received after cancellation must still release its exact original lease");
        }
        await client.close();
        await transport.close();
        assert.equal((await pending).value, undefined, "cancelled compatibility request must suppress its response");
        assert.equal(responses, 0);
        assert.equal(stderr.includes("cancelled_request_cleanup"), false,
          "known refusal/release after cancellation must not claim unknown cleanup");
      } else {
        const outcome = await pending;
        assert.equal(outcome.error, undefined);
        const failed = mode.startsWith("lost-");
        assert.equal(outcome.value.isError === true, failed, contentText(outcome.value));
        const expected = mode === "lost-acquire-ack" ? { delivery: "not_dispatched", lease: "released" }
          : mode === "lost-stop-ack" ? { delivery: "possibly_delivered", lease: "released" }
          : mode === "lost-release-ack" ? { delivery: "acknowledged", lease: "unknown" }
          : { delivery: "acknowledged", lease: "released" };
        assert.deepEqual(outcome.value._meta?.["rail-connector/control-outcome"], expected,
          "emitted metadata must reflect final release disposition, not a dispatch-time snapshot");
        if (mode === "lost-acquire-ack") assert.match(contentText(outcome.value), /lease outcome is unknown.*no stop was run/i);
        if (mode === "lost-stop-ack") assert.match(contentText(outcome.value), /stop outcome is unknown.*do not replay/i);
        if (mode === "lost-release-ack") assert.match(contentText(outcome.value), /lease release acknowledgement is unknown.*TTL is not proof/i);
        if (!failed) {
          const result = JSON.parse(contentText(outcome.value));
          assert.equal(result.status, "stopped");
          assert.equal(result.compatibilityCleanup, true);
          assert.equal(result.terminalCaptureRead, false);
        }
        const diagnostic = JSON.stringify(outcome.value);
        for (const excluded of [token, sessionName, pair.expectedGenerationId]) {
          assert.equal(diagnostic.includes(excluded), false,
            "uncertain compatibility outcomes must not disclose token/session identity");
        }
      }
      assert.equal(fixtureError, undefined);
      const acquire = records.filter((r) => r.operation === "acquireCleanupLease");
      const stop = records.filter((r) => r.operation === "cleanupStop");
      const release = records.filter((r) => r.operation === "releaseCleanupLease");
      assert.equal(acquire.length, mode === "before-acquire-cancel" ? 0 : 1, "cancel/unknown never authorizes a retry");
      assert.equal(stop.length, ["success", "lost-stop-ack", "lost-release-ack"].includes(mode) ? 1 : 0);
      assert.equal(release.length, ["before-acquire-cancel", "busy-cancel"].includes(mode) ? 0 : 1);
      for (const record of [...acquire, ...stop, ...release]) {
        assert.equal(record.payload.sessionName, sessionName);
        assert.equal(record.payload.expectedGenerationId, pair.expectedGenerationId);
        assert.equal(record.payload.expectedStartedAtMs, pair.expectedStartedAtMs);
        assert.equal(record.payload.leaseId, acquire[0].payload.leaseId);
        assert.equal(typeof record.payload.leaseId, "string");
      }
      assert.equal(records.some((r) => !["status", "acquireCleanupLease", "cleanupStop", "releaseCleanupLease"].includes(r.operation)), false,
        "compatibility cleanup must not capture, send input, Enter, start, upgrade or use unbound normal leases");
    } finally {
      gate?.();
      await client.close();
      await transport.close();
      if (pending) await pending;
      const closed = [...sockets].map((socket) => new Promise((resolve) => { socket.once("close", resolve); socket.destroy(); }));
      await Promise.all(closed);
      if (broker.listening) await new Promise((resolve) => broker.close(resolve));
      assert.equal(sockets.size, 0);
    }
    console.log("stop-generation incompatible cleanup " + mode + " exact outcome ok (actual MCP/fake broker)");
  }
}

async function uncertainSubmissionAnchorCoverage() {
  for (const mode of ["lost-ack", "preflight-blocked"]) {
    const fixtureState = path.join(root, "submission-anchor-" + mode);
    const fixtureConfig = path.join(fixtureState, "config");
    fs.mkdirSync(fixtureState, { recursive: true });
    const env = { ...process.env, RAIL_CONNECTOR_STATE_DIR: fixtureState, CLAUDE_CONFIG_DIR: fixtureConfig,
      RAIL_CONNECTOR_ALLOWED_ROOTS: repoRoot, RAIL_CONNECTOR_CLAUDE_PATH: wrapper };
    const token = randomUUID().replaceAll("-", "").repeat(2);
    const paths = windowsBrokerPaths(env, token);
    fs.writeFileSync(paths.tokenFile, token, { flag: "wx" });
    const sessionName = "synthetic-submission-anchor";
    const sessionId = "67676767-6767-4676-8676-676767676767";
    const pair = { expectedGenerationId: "00000000-0000-4000-8000-000000000000", expectedStartedAtMs: Date.now() - 10_000 };
    const metadata = { name: sessionName, cwd: repoRoot, canonicalCwd: canonicalWorkspace,
      generationId: pair.expectedGenerationId, startedAtMs: pair.expectedStartedAtMs, resolvedSessionId: sessionId,
      args: [], exited: false, requestedPosture: { permissionMode: "default" }, resolvedPosture: { permissionMode: "default" } };
    const logFile = path.join(fixtureConfig, "projects", canonicalWorkspace.replace(/[^A-Za-z0-9]/g, "-"), sessionId + ".jsonl");
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const append = (record) => fs.appendFileSync(logFile, JSON.stringify({
      uuid: randomUUID(), sessionId, timestamp: new Date().toISOString(), ...record,
    }) + "\n");
    append({ type: "user", message: { role: "user", content: "synthetic baseline before first submission" } });
    let phase = "first";
    let sends = 0;
    const records = [];
    const sockets = new Set();
    const broker = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        records.push({ operation: request.operation, payload: request.payload });
        const reply = (result) => socket.end(JSON.stringify({ ok: true, result }) + "\n");
        if (request.operation === "ping") reply({ version: WINDOWS_BROKER_VERSION, launchPolicyFingerprint: windowsBrokerLaunchPolicyFingerprint(env) });
        else if (request.operation === "status") reply({ version: WINDOWS_BROKER_VERSION,
          launchPolicyFingerprint: windowsBrokerLaunchPolicyFingerprint(env), managedSessions: [metadata] });
        else if (request.operation === "conditionalMetadata") {
          assert.equal(request.payload.expectedGenerationId, pair.expectedGenerationId);
          assert.equal(request.payload.expectedStartedAtMs, pair.expectedStartedAtMs);
          reply({ metadata });
        } else if (request.operation === "acquireLease") reply({ status: "acquired", generationId: pair.expectedGenerationId, startedAtMs: pair.expectedStartedAtMs });
        else if (request.operation === "releaseLease") reply({ status: "released" });
        else if (request.operation === "capture") {
          const idle = phase === "first" || phase === "second-ready";
          reply({ capture: idle ? "> " : "ctrl-c to cancel" });
        } else if (request.operation === "sendText") {
          sends++;
          assert.equal(request.payload.expectedGenerationId, pair.expectedGenerationId);
          assert.equal(request.payload.expectedStartedAtMs, pair.expectedStartedAtMs);
          if (sends === 1) {
            append({ type: "user", message: { role: "user", content: request.payload.text } });
            phase = "first-sent";
            reply({ status: "sent", bracketedPasteUsed: true });
          } else {
            assert.equal(mode, "lost-ack", "preflight refusal must not begin another delivery");
            phase = "waiting";
            socket.destroy();
          }
        } else assert.fail("unexpected anchor fixture operation " + request.operation);
      });
    });
    await new Promise((resolve, reject) => { broker.once("error", reject); broker.listen(paths.pipeName, resolve); });
    const transport = new StdioClientTransport({ command: process.execPath, args: ["src/index.js"], cwd: repoRoot, env, stderr: "pipe" });
    const client = new Client({ name: "owned-submission-anchor", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const submit = (text) => client.callTool({ name: "submit_prompt", arguments: {
        managedSession: sessionName, text, submitRetries: 0, ...pair,
      } });
      const first = await submit("synthetic first anchored prompt");
      assert.equal(first.isError, undefined, contentText(first));
      const firstResult = JSON.parse(contentText(first));
      assert.equal(firstResult.status, "submitted");
      const cursor = parsePortableWaitCursor(firstResult.waitAfterCursor);
      assert.equal(cursor.generationId, pair.expectedGenerationId);
      assert.equal(cursor.startedAtMs, pair.expectedStartedAtMs);
      assert.equal(cursor.resolvedSessionId, sessionId);
      append({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn",
        content: [{ type: "text", text: "synthetic completed first turn" }] } });
      const completionLogHash = createHash("sha256").update(fs.readFileSync(logFile)).digest("hex");
      phase = mode === "lost-ack" ? "second-ready" : "blocked";
      const second = await submit("synthetic second uncertain prompt");
      if (mode === "lost-ack") {
        assert.equal(second.isError, true);
        assert.match(contentText(second), /Broker mutation outcome is unknown/);
        assert.equal(sends, 2, "the second prompt must reach its one uncertain sendText");
      } else {
        assert.equal(second.isError, undefined, contentText(second));
        assert.equal(JSON.parse(contentText(second)).status, "preflight_blocked");
        assert.equal(sends, 1, "preflight-blocked submission must not clear the anchor by delivering");
      }
      assert.equal(createHash("sha256").update(fs.readFileSync(logFile)).digest("hex"), completionLogHash,
        "the synthetic old completion must be the last log record throughout the second attempt");
      phase = "waiting";
      const waited = await client.callTool({ name: "wait_for_claude_turn", arguments: {
        managedSession: sessionName, timeoutSeconds: 1, pollIntervalMs: 250, lines: 20,
      } }); // Deliberately no cursor or pair: exercise the actual remembered anchor.
      assert.equal(waited.isError, undefined, contentText(waited));
      const result = JSON.parse(contentText(waited));
      console.log("stop-generation submission anchor " + mode + " " + JSON.stringify({ status: result.status,
        completionEvidence: result.completionEvidence ?? null, sends }));
      assert.equal(result.signals.state, "busy", "neutral non-idle terminal must avoid latest_settled_turn fallback");
      assert.equal(result.status, mode === "lost-ack" ? "timeout" : "completed",
        "a new possible delivery invalidates the old anchor; a preflight refusal preserves it");
      if (mode === "preflight-blocked") assert.equal(result.completionEvidence, "after_cursor_changed");
      else assert.notEqual(result.completionEvidence, "after_cursor_changed");
      const acquired = records.filter((record) => record.operation === "acquireLease");
      const released = records.filter((record) => record.operation === "releaseLease");
      assert.equal(acquired.length, 2);
      assert.equal(released.length, 2);
      for (let index = 0; index < released.length; index++) {
        assert.equal(released[index].payload.leaseId, acquired[index].payload.leaseId);
        assert.equal(released[index].payload.expectedGenerationId, pair.expectedGenerationId);
        assert.equal(released[index].payload.expectedStartedAtMs, pair.expectedStartedAtMs);
      }
    } finally {
      await client.close();
      await transport.close();
      const closing = [...sockets].map((socket) => new Promise((resolve) => { socket.once("close", resolve); socket.destroy(); }));
      await Promise.all(closing);
      if (broker.listening) await new Promise((resolve) => broker.close(resolve));
      assert.equal(sockets.size, 0);
    }
  }
}

async function uncertainStartLeaseCoverage() {
  for (const mode of ["lost-reply"]) {
    const fixtureState = path.join(root, "start-reserved-lease-" + mode);
    fs.mkdirSync(fixtureState, { recursive: true });
    const env = { ...process.env, RAIL_CONNECTOR_STATE_DIR: fixtureState,
      CLAUDE_CONFIG_DIR: path.join(fixtureState, "config"), RAIL_CONNECTOR_ALLOWED_ROOTS: repoRoot,
      RAIL_CONNECTOR_CLAUDE_PATH: process.execPath };
    const probeAudit = path.join(fixtureState, "inert-probes.jsonl");
    const preload = path.join(fixtureState, "inert-capabilities-no-spawn.mjs");
    fs.writeFileSync(preload, [
      'import fs from "node:fs";',
      'import childProcess from "node:child_process";',
      'import { syncBuiltinESMExports } from "node:module";',
      'import { promisify } from "node:util";',
      `const audit = ${JSON.stringify(probeAudit)};`,
      `const executable = ${JSON.stringify(process.execPath)};`,
      'const record = (kind) => fs.appendFileSync(audit, JSON.stringify({ kind }) + "\\n");',
      'const deny = () => { record("denied-subprocess"); throw new Error("Owned start fixture forbids subprocess launches"); };',
      'for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFileSync", "fork"]) childProcess[key] = deny;',
      'const inspect = (file, args) => {',
      '  if (fs.realpathSync.native(file).toLowerCase() !== fs.realpathSync.native(executable).toLowerCase()) return deny();',
      '  const key = JSON.stringify(args);',
      '  if (![\'["--version"]\', \'["--help"]\', \'["--effort=ultracode","--version"]\', \'["--effort=rail-invalid-probe","--version"]\'].includes(key)) return deny();',
      '  record(key);',
      '  if (args[0] === "--effort=rail-invalid-probe") { const error = new Error("synthetic invalid effort"); error.code = 64; error.stderr = "Unknown effort"; throw error; }',
      '  return { stdout: args[0] === "--help" ? "Usage: claude [options]\\n --permission-mode <mode> (choices: default, dontAsk)\\n --remote-control [name]\\n" : "2.1.234 (inert start capability fixture)\\n", stderr: "" };',
      '};',
      'const inertExecFile = (file, args, options, callback) => {',
      '  if (typeof callback !== "function") return deny();',
      '  queueMicrotask(() => { try { const result = inspect(file, args); callback(null, result.stdout, result.stderr); } catch (error) { callback(error); } });',
      '};',
      'inertExecFile[promisify.custom] = async (file, args) => inspect(file, args);',
      'childProcess.execFile = inertExecFile;',
      'syncBuiltinESMExports();',
    ].join("\n"));
    const token = randomUUID().replaceAll("-", "").repeat(2);
    const paths = windowsBrokerPaths(env, token);
    fs.writeFileSync(paths.tokenFile, token, { flag: "wx" });
    const records = [];
    const sockets = new Set();
    const broker = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        // Never retain the launch payload's environment/argv as evidence.
        records.push({ operation: request.operation, leaseId: request.payload?.leaseId ?? null });
        const reply = (result) => socket.end(JSON.stringify({ ok: true, result }) + "\n");
        if (request.operation === "ping") reply({ version: WINDOWS_BROKER_VERSION,
          launchPolicyFingerprint: windowsBrokerLaunchPolicyFingerprint(env) });
        else if (request.operation === "acquireLease") reply({ status: "not_running" });
        else if (request.operation === "status") reply({ version: WINDOWS_BROKER_VERSION,
          launchPolicyFingerprint: windowsBrokerLaunchPolicyFingerprint(env), managedSessions: [] });
        else if (request.operation === "start") {
          assert.equal(typeof request.payload.leaseId, "string");
          assert.ok(request.payload.leaseId.length > 0, "start must carry the reserved lease identity");
          socket.destroy();
        } else assert.fail("uncertain start must not dispatch " + request.operation);
      });
    });
    await new Promise((resolve, reject) => { broker.once("error", reject); broker.listen(paths.pipeName, resolve); });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--import", pathToFileURL(preload).href, "src/index.js"], cwd: repoRoot, env, stderr: "pipe" });
    const client = new Client({ name: "owned-uncertain-start-lease", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const outcome = await client.callTool({ name: "start_remote_control", arguments: {
        managedSession: "synthetic-uncertain-start-lease", cwd: repoRoot,
      } });
      assert.equal(outcome.isError, true);
      assert.match(contentText(outcome), /Broker mutation outcome is unknown/);
      const control = outcome._meta?.["rail-connector/control-outcome"];
      console.log("stop-generation reserved start lease " + mode + " " + JSON.stringify(control));
      assert.deepEqual(control, { delivery: "possibly_delivered", lease: "unknown" },
        "a lost reserved-start reply cannot prove absence of a broker-owned lease");
      const acquisitions = records.filter(({ operation }) => operation === "acquireLease");
      const starts = records.filter(({ operation }) => operation === "start");
      assert.equal(acquisitions.length, 1);
      assert.equal(starts.length, 1, "an uncertain launch must not be retried");
      assert.equal(starts[0].leaseId, acquisitions[0].leaseId);
      assert.equal(records.some(({ operation }) => ["releaseLease", "releaseCleanupLease", "stop", "cleanupStop", "replace"].includes(operation)), false,
        "no generation reply means no guessed exact release or recovery mutation");
      const probes = fs.readFileSync(probeAudit, "utf8").trim().split("\n").map((line) => JSON.parse(line).kind);
      assert.equal(probes.length, 4);
      assert.equal(probes.includes("denied-subprocess"), false, "capability callbacks must remain inert and no process launch may be attempted");
    } finally {
      await client.close();
      await transport.close();
      const closing = [...sockets].map((socket) => new Promise((resolve) => { socket.once("close", resolve); socket.destroy(); }));
      await Promise.all(closing);
      if (broker.listening) await new Promise((resolve) => broker.close(resolve));
      assert.equal(sockets.size, 0);
    }
  }
}

async function waitCancellationFixture(predicate, message) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}


async function defaultStopGenerationCoverage() {
  await cancellationMutationCoverage();
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
  assert.equal(initialExitDiagnostic.before.readable, true);
  assert.equal(initialExitDiagnostic.before.present, true);
  assert.equal(initialExitDiagnostic.before.exited, false);
  assert.equal(initialExitDiagnostic.before.generationMatchesInitial, true);
  const expectedExitTuple = initialExitDiagnostic.before.syntheticTuple;
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
  // The broker rechecks sendability after its final pacing wait. A prompt
  // that deliberately exits this fixture can therefore be refused as exited
  // instead of being acknowledged as sent. Accept only that exact clean exit;
  // any other error, missing identity, drift or abnormal exit still fails.
  if (initialExit.isError === true) {
    assert.equal(contentText(initialExit), `Managed native Windows Claude session has exited: ${managedSession}`);
    assert.equal(initialExitDiagnostic.after.readable, true);
    assert.equal(initialExitDiagnostic.after.present, true);
    assert.equal(initialExitDiagnostic.after.exited, true);
    assert.equal(initialExitDiagnostic.after.exitCode, 0);
    assert.deepEqual(initialExitDiagnostic.after.syntheticTuple, expectedExitTuple);
  } else {
    assert.equal(initialExit.isError, undefined, contentText(initialExit));
  }
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
  assert.equal(exited?.exitCode, 0);
  assert.deepEqual({
    pid: exited.pid, generationId: exited.generationId,
    startedAtMs: exited.startedAtMs, resolvedSessionId: exited.resolvedSessionId,
  }, expectedExitTuple);

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
const focusedCancellation = process.argv.includes("--cancellation-contract-only");
const focusedIncompatibleCleanup = process.argv.includes("--incompatible-cleanup-contract-only");
let primaryError = null;
try {
  if (focusedIncompatibleCleanup) {
    await incompatibleCleanupCancellationCoverage();
  } else if (focusedCancellation) {
    await cancellationMutationCoverage();
  } else if (focusedCaptureTerminal) {
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
