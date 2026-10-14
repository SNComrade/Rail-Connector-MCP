import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeWindowsBroker, windowsBrokerRequest } from "../src/windows-broker-client.js";

if (process.platform !== "win32") {
  console.log("windows-broker-timeout skipped on non-Windows");
  process.exit(0);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-connector-broker-timeout-"));
const loader = pathToFileURL(path.join(root, "test", "fixtures", "stubborn-pty-loader.mjs"));
const env = {
  ...process.env,
  RAIL_CONNECTOR_STATE_DIR: stateDir,
  RAIL_CONNECTOR_CLAUDE_PATH: process.execPath,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${loader.href}`].filter(Boolean).join(" "),
};
const sessionName = `broker_timeout_${process.pid}`;
const initialLease = "timeout-initial-lease";
let brokerStopped = false;
let startedPair = null;

async function request(operation, payload = {}, options = {}) {
  return windowsBrokerRequest(operation, payload, { env, ...options });
}
try {
  const started = await request("start", {
    sessionName,
    command: process.execPath,
    args: [path.join(root, "test", "fixtures", "fake-claude-tui.mjs")],
    metadataCommand: process.execPath,
    metadataArgs: [path.join(root, "test", "fixtures", "fake-claude-tui.mjs")],
    cwd: root,
    canonicalCwd: fs.realpathSync.native(root),
    env,
    leaseId: initialLease,
    leaseTtlMs: 30000,
  });
  assert.equal(started.status, "started");
  const pair = {
    expectedGenerationId: started.metadata.generationId,
    expectedStartedAtMs: started.metadata.startedAtMs,
  };
  startedPair = pair;
  const timedOut = await request("stop", {
    sessionName,
    graceful: false,
    force: true,
    omitCapture: true,
    leaseId: initialLease,
    ...pair,
  });
  assert.equal(timedOut.status, "stop_timeout");
  assert.equal(timedOut.recoveryOnly, true);
  assert.equal(timedOut.expectedGenerationId, pair.expectedGenerationId, "stop_timeout must return the recovery pair");
  assert.equal(timedOut.expectedStartedAtMs, pair.expectedStartedAtMs, "stop_timeout must return the recovery pair");
  const timedOutStatus = (await probeWindowsBroker(env)).managedSessions.find((session) => session.name === sessionName);
  assert.equal(timedOutStatus?.exited, false);
  assert.equal(timedOutStatus?.recoveryOnly, true, "status must show the recovery-only state");

  for (const operation of ["acquireLease", "acquireCleanupLease", "stop", "cleanupStop"]) {
    await assert.rejects(
      request(operation, {
        sessionName,
        leaseId: "name-only-recovery",
        graceful: false,
        force: true,
      }),
      (error) => error?.code === "EINVAL",
      `${operation} must reject name-only recovery`
    );
  }
  await assert.rejects(
    request("acquireLease", {
      sessionName,
      leaseId: "mismatched-recovery",
      expectedGenerationId: "other-generation",
      expectedStartedAtMs: pair.expectedStartedAtMs,
    }),
    (error) => error?.code === "ESTALE"
  );
  for (const operation of ["sendText", "sendKey"]) {
    await assert.rejects(
      request(operation, {
        sessionName,
        leaseId: initialLease,
        ...pair,
        text: "unwanted",
        key: "Enter",
      }),
      (error) => error?.code === "ERECOVERY"
    );
  }

  const acquired = await request("acquireLease", {
    sessionName,
    leaseId: "exact-recovery",
    ttlMs: 10000,
    ...pair,
  });
  assert.equal(acquired.status, "acquired");
  const stopped = await request("stop", {
    sessionName,
    leaseId: "exact-recovery",
    graceful: false,
    force: true,
    omitCapture: true,
    ...pair,
  });
  assert.equal(stopped.status, "stopped");
  assert.equal((await request("shutdown", {}, { startIfMissing: false })).status, "shutting_down");
  brokerStopped = true;
  const deadline = Date.now() + 5000;
  while ((await probeWindowsBroker(env)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await probeWindowsBroker(env), null);
} finally {
  if (!brokerStopped) {
    try {
      const status = await probeWindowsBroker(env);
      const owned = status?.managedSessions.find((session) => session.name === sessionName);
      if (owned && startedPair && owned.generationId === startedPair.expectedGenerationId &&
          owned.startedAtMs === startedPair.expectedStartedAtMs) {
        const lease = await request("acquireLease", {
          sessionName,
          leaseId: "timeout-test-recovery",
          ttlMs: 10000,
          ...startedPair,
        });
        if (lease.status === "acquired") {
          await request("stop", {
            sessionName,
            leaseId: "timeout-test-recovery",
            graceful: false,
            force: true,
            omitCapture: true,
            ...startedPair,
          });
        }
      }
      if ((await probeWindowsBroker(env))?.managedSessions.length === 0) {
        await request("shutdown", {}, { startIfMissing: false });
        brokerStopped = true;
      }
    } catch {
      // Preserve exact task-owned state for inspection if cleanup cannot bind.
    }
  }
  if (brokerStopped) {
    const deadline = Date.now() + 5000;
    while ((await probeWindowsBroker(env)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if ((await probeWindowsBroker(env)) === null) {
      const canonicalStateDir = fs.realpathSync.native(stateDir);
      const canonicalTempDir = fs.realpathSync.native(os.tmpdir());
      assert.equal(
        path.dirname(canonicalStateDir).toLowerCase(),
        canonicalTempDir.toLowerCase(),
        "test state must remain directly under the temp root"
      );
      assert.ok(path.basename(canonicalStateDir).startsWith("rail-connector-broker-timeout-"));
      fs.rmSync(canonicalStateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
}

console.log("windows-broker-timeout ok");
