import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  probeWindowsBroker,
  windowsBrokerPaths,
  windowsBrokerCleanupRequest,
  windowsBrokerRequest,
} from "../src/windows-broker-client.js";

if (process.platform !== "win32") {
  console.log("windows-broker skipped on non-Windows");
  process.exit(0);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const canonicalRepoRoot =
  fs.realpathSync.native?.(repoRoot) ?? fs.realpathSync(repoRoot);
const fixture = path.join(repoRoot, "test", "fixtures", "fake-claude-tui.mjs");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-connector-broker-"));
const previousStateDir = process.env.RAIL_CONNECTOR_STATE_DIR;
const previousClaudePath = process.env.RAIL_CONNECTOR_CLAUDE_PATH;
process.env.RAIL_CONNECTOR_STATE_DIR = stateDir;
process.env.RAIL_CONNECTOR_CLAUDE_PATH = process.execPath;
const sessionName = `broker_test_${process.pid}`;
const tokenA = "a".repeat(64);
const tokenB = "b".repeat(64);
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
try {
  const tokenPaths = windowsBrokerPaths(process.env);
  fs.writeFileSync(tokenPaths.tokenFile, "short\n", { mode: 0o600 });
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
  assert.equal(brokerToken.length, 64);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(legacyConnections, 0);
  assert.equal(legacyData.includes(brokerToken), false);
  await new Promise((resolve) => legacyServer.close(resolve));
  legacyServer = null;

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
      args: [fixture],
      metadataCommand: process.execPath,
      metadataArgs: [fixture],
      cwd: repoRoot,
      canonicalCwd: stateDir,
      env: { ...process.env },
      leaseId: "rejected-cwd-lease",
    }),
    (error) => error?.code === "ECWDPROVENANCE"
  );

  const started = await windowsBrokerRequest("start", {
    sessionName,
    command: process.execPath,
    args: [fixture],
    metadataCommand: process.execPath,
    metadataArgs: [fixture],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: { ...process.env },
    requestedPosture: { permissionMode: "default" },
    resolvedPosture: { permissionMode: "manual" },
    resolvedSessionId: "33333333-3333-4333-8333-333333333333",
    leaseId: "startup-lease",
    leaseTtlMs: 10000,
  });
  assert.equal(started.status, "started");
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
    ttlMs: 10000,
  });
  assert.equal(firstLeaseResult.status, "acquired");
  assert.equal(firstLeaseResult.generationId, activeGenerationId);
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
      args: [fixture],
      metadataCommand: process.execPath,
      metadataArgs: [fixture],
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
      args: [fixture],
      metadataCommand: process.execPath,
      metadataArgs: [fixture],
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
  const replaced = await windowsBrokerRequest("replace", {
    sessionName,
    command: process.execPath,
    args: [fixture],
    metadataCommand: process.execPath,
    metadataArgs: [fixture],
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
  await windowsBrokerRequest("releaseLease", { sessionName, leaseId: firstLease });
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
  await windowsBrokerRequest("sendText", {
    sessionName,
    text: "/exit",
    submit: true,
    leaseId: exitLease,
    expectedGenerationId: activeGenerationId,
  });
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
    args: [fixture],
    metadataCommand: process.execPath,
    metadataArgs: [fixture],
    cwd: repoRoot,
    canonicalCwd: canonicalRepoRoot,
    env: { ...process.env, RAIL_CONNECTOR_FAKE_CLAUDE_IGNORE_EXIT: "1" },
    leaseId: stubbornLease,
    leaseTtlMs: 10000,
  });
  assert.equal(stubbornStarted.status, "started");
  const cleanupTimeout = await windowsBrokerRequest("stop", {
    sessionName: stubbornSession,
    graceful: true,
    force: false,
    omitCapture: true,
    leaseId: stubbornLease,
    expectedGenerationId: stubbornStarted.metadata.generationId,
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
  });
  assert.equal(cleanupStop.status, "stopped");
  assert.equal(Object.hasOwn(cleanupStop, "capture"), false);

  const compatibilitySession = `${sessionName}_compat_cleanup`;
  const compatibilityStartLease = "compatibility-start-lease";
  const compatibilityStarted = await windowsBrokerRequest("start", {
    sessionName: compatibilitySession,
    command: process.execPath,
    args: [fixture],
    metadataCommand: process.execPath,
    metadataArgs: [fixture],
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
      args: [fixture],
      metadataCommand: process.execPath,
      metadataArgs: [fixture],
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
} finally {
  if (legacyServer) {
    await new Promise((resolve) => legacyServer.close(resolve));
  }
  if (previousStateDir === undefined) delete process.env.RAIL_CONNECTOR_STATE_DIR;
  else process.env.RAIL_CONNECTOR_STATE_DIR = previousStateDir;
  if (previousClaudePath === undefined) delete process.env.RAIL_CONNECTOR_CLAUDE_PATH;
  else process.env.RAIL_CONNECTOR_CLAUDE_PATH = previousClaudePath;
  fs.rmSync(stateDir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

console.log("windows-broker ok");
