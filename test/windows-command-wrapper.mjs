import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import {
  probeWindowsBroker,
  windowsBrokerRequest,
} from "../src/windows-broker-client.js";

if (process.platform !== "win32") {
  console.log("windows-command-wrapper skipped outside Windows");
  process.exit(0);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-wrapper-"));
const claudeWrapper = path.join(root, "claude.cmd");
const fixture = path.join(repoRoot, "test", "fixtures", "fake-claude-tui.mjs");
const managedSession = `wrapper_${process.pid}`;
const compatibilityCleanupSession = `${managedSession}_prior_policy`;
const provenanceCleanupSession = `${managedSession}_provenance`;
const sessionWorkspace = path.join(root, "workspace");
const restrictedRoot = path.join(root, "restricted");
const provenanceTargetA = path.join(root, "provenance-a");
const provenanceTargetB = path.join(root, "provenance-b");
const provenanceJunction = path.join(root, "provenance-junction");
fs.mkdirSync(sessionWorkspace);
fs.mkdirSync(restrictedRoot);
fs.mkdirSync(provenanceTargetA);
fs.mkdirSync(provenanceTargetB);
fs.symlinkSync(provenanceTargetA, provenanceJunction, "junction");
fs.writeFileSync(
  claudeWrapper,
  [
    "@echo off",
    `cd /d "${root}"`,
    `"${process.execPath}" "${fixture}" %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n")
);

const mcpEnv = {
  ...process.env,
  RAIL_CONNECTOR_CLAUDE_PATH: claudeWrapper,
  RAIL_CONNECTOR_STATE_DIR: path.join(root, "state"),
  CLAUDE_CONFIG_DIR: path.join(root, "claude-config"),
  RAIL_CONNECTOR_ALLOWED_ROOTS: root,
};
const staleBrokerEnv = {
  ...mcpEnv,
  RAIL_CONNECTOR_CLAUDE_PATH: process.execPath,
};
await windowsBrokerRequest("ping", {}, { env: staleBrokerEnv });
const compatibilityStartLease = `compat-start-${process.pid}`;
const compatibilityStarted = await windowsBrokerRequest(
  "start",
  {
    sessionName: compatibilityCleanupSession,
    command: process.execPath,
    args: [fixture],
    metadataCommand: process.execPath,
    metadataArgs: [fixture],
    cwd: sessionWorkspace,
    canonicalCwd:
      fs.realpathSync.native?.(sessionWorkspace) ??
      fs.realpathSync(sessionWorkspace),
    env: { ...process.env },
    leaseId: compatibilityStartLease,
    leaseTtlMs: 10000,
  },
  { env: staleBrokerEnv }
);
assert.equal(compatibilityStarted.status, "started");
await windowsBrokerRequest(
  "releaseLease",
  {
    sessionName: compatibilityCleanupSession,
    leaseId: compatibilityStartLease,
  },
  { startIfMissing: false, env: staleBrokerEnv }
);
const staleBrokerStatus = await probeWindowsBroker(staleBrokerEnv);
assert.equal(staleBrokerStatus.compatible, true);
assert.equal(
  staleBrokerStatus.managedSessions.some(
    (session) => session.name === compatibilityCleanupSession
  ),
  true
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/index.js"],
  cwd: repoRoot,
  env: mcpEnv,
  stderr: "pipe",
});
const client = new Client({ name: "claude-wrapper-test", version: "1.0.0" }, { capabilities: {} });

await client.connect(transport, { timeout: 30000 });
try {
  const incompatibleStatusResult = await client.callTool(
    { name: "status", arguments: {} },
    undefined,
    { timeout: 30000 }
  );
  const incompatibleStatus = JSON.parse(
    incompatibleStatusResult.content?.[0]?.text ?? "{}"
  );
  assert.equal(incompatibleStatus.broker.compatible, false);
  const unknownCompatibilityStop = await client.callTool(
    {
      name: "stop_remote_control",
      arguments: {
        managedSession: `${managedSession}_unknown`,
        graceful: true,
        force: false,
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(unknownCompatibilityStop.isError, undefined);
  assert.equal(
    JSON.parse(unknownCompatibilityStop.content?.[0]?.text ?? "{}").status,
    "not_running"
  );
  const blockedCompatibilityStop = await client.callTool(
    {
      name: "stop_remote_control",
      arguments: {
        managedSession: compatibilityCleanupSession,
        graceful: true,
        force: false,
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(
    blockedCompatibilityStop.isError,
    undefined,
    blockedCompatibilityStop.content?.[0]?.text
  );
  const blockedCompatibilityPayload = JSON.parse(
    blockedCompatibilityStop.content?.[0]?.text ?? "{}"
  );
  assert.equal(blockedCompatibilityPayload.status, "stop_blocked");
  assert.equal(
    blockedCompatibilityPayload.reason,
    "broker_upgrade_required"
  );
  const compatibilityStopped = await client.callTool(
    {
      name: "stop_remote_control",
      arguments: {
        managedSession: compatibilityCleanupSession,
        graceful: false,
        force: true,
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(
    compatibilityStopped.isError,
    undefined,
    compatibilityStopped.content?.[0]?.text
  );
  const compatibilityStoppedPayload = JSON.parse(
    compatibilityStopped.content?.[0]?.text ?? "{}"
  );
  assert.equal(compatibilityStoppedPayload.status, "stopped");
  assert.equal(compatibilityStoppedPayload.compatibilityCleanup, true);
  assert.equal(compatibilityStoppedPayload.terminalCaptureRead, false);
  assert.equal(compatibilityStoppedPayload.graceful, false);
  assert.equal(
    Object.hasOwn(compatibilityStoppedPayload, "capture"),
    false
  );

  const result = await client.callTool(
    { name: "get_claude_capabilities", arguments: {} },
    undefined,
    { timeout: 30000 }
  );
  const payload = JSON.parse(result.content[0].text);
  const canonicalWrapper =
    fs.realpathSync.native?.(claudeWrapper) ?? fs.realpathSync(claudeWrapper);
  assert.equal(payload.available, true, JSON.stringify(payload));
  assert.equal(payload.command.toLowerCase(), canonicalWrapper.toLowerCase());
  assert.match(payload.version, /^2\.1\.234/);
  const started = await client.callTool(
    {
      name: "start_remote_control",
      arguments: {
        cwd: sessionWorkspace,
        managedSession,
        remoteName: "Wrapper Test",
        permissionMode: "plan",
      },
    },
    undefined,
    { timeout: 45000 }
  );
  assert.equal(started.isError, undefined, started.content?.[0]?.text);
  const startPayload = JSON.parse(started.content[0].text);
  assert.equal(startPayload.status, "started", JSON.stringify(startPayload));
  assert.match(startPayload.claudeCliVersion, /^2\.1\.234\b/);
  assert.match(startPayload.capture, /Fake Claude TUI/);
  const upgradedBrokerStatus = await probeWindowsBroker(mcpEnv);
  assert.equal(upgradedBrokerStatus.compatible, true);
  assert.notEqual(upgradedBrokerStatus.pid, staleBrokerStatus.pid);
  assert.equal(
    upgradedBrokerStatus.managedSessions[0].canonicalCwd.toLowerCase(),
    (
      fs.realpathSync.native?.(sessionWorkspace) ??
      fs.realpathSync(sessionWorkspace)
    ).toLowerCase()
  );
  const activeStartedAtMs =
    upgradedBrokerStatus.managedSessions[0].startedAtMs;
  await assert.rejects(
    windowsBrokerRequest(
      "capture",
      {
        sessionName: managedSession,
        lines: 20,
        expectedStartedAtMs: activeStartedAtMs + 1,
      },
      { startIfMissing: false, env: mcpEnv }
    ),
    (error) => error?.code === "ESTALE"
  );
  const staleLeaseId = `stale-generation-${process.pid}`;
  assert.equal(
    (
      await windowsBrokerRequest(
        "acquireLease",
        {
          sessionName: managedSession,
          leaseId: staleLeaseId,
          ttlMs: 10000,
        },
        { startIfMissing: false, env: mcpEnv }
      )
    ).status,
    "acquired"
  );
  try {
    await assert.rejects(
      windowsBrokerRequest(
        "sendText",
        {
          sessionName: managedSession,
          text: "must not be sent",
          submit: false,
          leaseId: staleLeaseId,
          expectedStartedAtMs: activeStartedAtMs + 1,
        },
        { startIfMissing: false, env: mcpEnv }
      ),
      (error) => error?.code === "ESTALE"
    );
  } finally {
    await windowsBrokerRequest(
      "releaseLease",
      { sessionName: managedSession, leaseId: staleLeaseId },
      { startIfMissing: false, env: mcpEnv }
    );
  }

  const workflowStarted = await client.callTool(
    {
      name: "send_text",
      arguments: {
        managedSession,
        text: "/workflow-test",
        submit: true,
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(workflowStarted.isError, undefined, workflowStarted.content?.[0]?.text);
  const workflowStartedPayload = JSON.parse(
    workflowStarted.content?.[0]?.text ?? "{}"
  );
  assert.equal(workflowStartedPayload.signals.workflowPending, true);
  assert.equal(workflowStartedPayload.signals.workflowPendingCount, 1);
  assert.equal(
    workflowStartedPayload.signals.workflowPendingEvidence,
    "terminal_heuristic"
  );

  for (const request of [
    {
      name: "submit_prompt",
      arguments: { managedSession, text: "must not submit", force: false },
      expectedStatus: "preflight_blocked",
    },
    {
      name: "send_text",
      arguments: { managedSession, text: "must not type", submit: false },
      expectedStatus: "send_blocked",
    },
    {
      name: "send_key",
      arguments: { managedSession, key: "Enter" },
      expectedStatus: "send_blocked",
    },
    {
      name: "send_key",
      arguments: { managedSession, key: "C-m" },
      expectedStatus: "send_blocked",
    },
    {
      name: "send_key",
      arguments: { managedSession, key: "KPEnter" },
      expectedStatus: "send_blocked",
    },
    {
      name: "rename_claude_session",
      arguments: { managedSession, title: "Must Not Rename" },
      expectedStatus: "rename_blocked",
    },
  ]) {
    const blockedResult = await client.callTool(
      { name: request.name, arguments: request.arguments },
      undefined,
      { timeout: 30000 }
    );
    assert.equal(blockedResult.isError, undefined, blockedResult.content?.[0]?.text);
    const blockedPayload = JSON.parse(blockedResult.content?.[0]?.text ?? "{}");
    assert.equal(blockedPayload.status, request.expectedStatus);
    assert.equal(blockedPayload.reason, "workflow_pending");
  }

  const blockedReplacement = await client.callTool(
    {
      name: "start_remote_control",
      arguments: {
        cwd: sessionWorkspace,
        managedSession,
        remoteName: "Wrapper Test",
        permissionMode: "plan",
        killExisting: true,
        forceKillExisting: false,
      },
    },
    undefined,
    { timeout: 45000 }
  );
  assert.equal(blockedReplacement.isError, true);
  assert.match(
    blockedReplacement.content?.[0]?.text ?? "",
    /workflow_pending/
  );

  const pendingWait = await client.callTool(
    {
      name: "wait_for_claude_turn",
      arguments: {
        managedSession,
        timeoutSeconds: 1,
        pollIntervalMs: 250,
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(pendingWait.isError, undefined, pendingWait.content?.[0]?.text);
  const pendingWaitPayload = JSON.parse(pendingWait.content?.[0]?.text ?? "{}");
  assert.equal(pendingWaitPayload.status, "timeout");
  assert.equal(pendingWaitPayload.signals.workflowPending, true);

  const blockedWorkflowStop = await client.callTool(
    {
      name: "stop_remote_control",
      arguments: { managedSession, graceful: true, force: false },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(
    blockedWorkflowStop.isError,
    undefined,
    blockedWorkflowStop.content?.[0]?.text
  );
  const blockedWorkflowStopPayload = JSON.parse(
    blockedWorkflowStop.content?.[0]?.text ?? "{}"
  );
  assert.equal(blockedWorkflowStopPayload.status, "stop_blocked");
  assert.equal(blockedWorkflowStopPayload.reason, "workflow_pending");

  const workflowCleared = await client.callTool(
    {
      name: "send_text",
      arguments: {
        managedSession,
        text: "/workflow-clear",
        submit: true,
        force: true,
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(workflowCleared.isError, undefined, workflowCleared.content?.[0]?.text);
  const workflowClearedPayload = JSON.parse(
    workflowCleared.content?.[0]?.text ?? "{}"
  );
  assert.equal(workflowClearedPayload.status, "sent");
  assert.equal(workflowClearedPayload.forceUsed, true);
  assert.equal(workflowClearedPayload.signals.workflowPending, false);

  const restrictedEnv = {
    ...mcpEnv,
    RAIL_CONNECTOR_ALLOWED_ROOTS: restrictedRoot,
  };
  const restrictedTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.js"],
    cwd: repoRoot,
    env: restrictedEnv,
    stderr: "pipe",
  });
  const restrictedClient = new Client(
    { name: "claude-wrapper-restricted-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await restrictedClient.connect(restrictedTransport, { timeout: 30000 });
  try {
    const restrictedStatusResult = await restrictedClient.callTool(
      {
        name: "status",
        arguments: {},
      },
      undefined,
      { timeout: 30000 }
    );
    assert.equal(restrictedStatusResult.isError, undefined);
    const restrictedStatus = JSON.parse(
      restrictedStatusResult.content?.[0]?.text ?? "{}"
    );
    assert.equal(
      restrictedStatus.managedSessions.some(
        (session) => session.name === managedSession
      ),
      false
    );
    assert.equal(restrictedStatus.inaccessibleManagedSessionCount, 1);
    assert.doesNotMatch(
      restrictedStatus.claudeProcesses,
      new RegExp(String(startPayload.pid ?? upgradedBrokerStatus.managedSessions[0]?.pid))
    );
    const deniedCapture = await restrictedClient.callTool(
      {
        name: "capture_remote_control",
        arguments: { managedSession },
      },
      undefined,
      { timeout: 30000 }
    );
    assert.equal(deniedCapture.isError, true);
    assert.match(
      deniedCapture.content?.[0]?.text ?? "",
      /outside this MCP process's allowed workspace scope/
    );
    assert.equal(
      (deniedCapture.content?.[0]?.text ?? "").includes(sessionWorkspace),
      false
    );
    const deniedStop = await restrictedClient.callTool(
      {
        name: "stop_remote_control",
        arguments: { managedSession, graceful: false, force: true },
      },
      undefined,
      { timeout: 30000 }
    );
    assert.equal(deniedStop.isError, true);
    assert.match(
      deniedStop.content?.[0]?.text ?? "",
      /outside this MCP process's allowed workspace scope/
    );
    assert.equal(
      (deniedStop.content?.[0]?.text ?? "").includes(sessionWorkspace),
      false
    );
  } finally {
    await restrictedClient.close();
  }
  fs.rmSync(sessionWorkspace, { recursive: true, force: true });
  const cleanupStatusResult = await client.callTool(
    { name: "status", arguments: {} },
    undefined,
    { timeout: 30000 }
  );
  const cleanupStatus = JSON.parse(
    cleanupStatusResult.content?.[0]?.text ?? "{}"
  );
  assert.equal(
    cleanupStatus.managedSessions.some(
      (session) => session.name === managedSession
    ),
    false
  );
  assert.equal(
    cleanupStatus.cleanupEligibleSessions.some(
      (session) =>
        session.name === managedSession &&
        session.state === "cleanup_only"
    ),
    true
  );
  const blockedMissingCwdStop = await client.callTool(
    {
      name: "stop_remote_control",
      arguments: { managedSession, graceful: true, force: false },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(blockedMissingCwdStop.isError, undefined);
  const blockedMissingCwdPayload = JSON.parse(
    blockedMissingCwdStop.content?.[0]?.text ?? "{}"
  );
  assert.equal(blockedMissingCwdPayload.status, "stop_blocked");
  assert.equal(blockedMissingCwdPayload.reason, "cwd_unavailable");
  assert.equal(Object.hasOwn(blockedMissingCwdPayload, "capture"), false);
  const stopped = await client.callTool(
    {
      name: "stop_remote_control",
      arguments: { managedSession, graceful: false, force: true },
    },
    undefined,
    { timeout: 30000 }
  );
  const stoppedPayload = JSON.parse(stopped.content[0].text);
  assert.equal(stoppedPayload.status, "stopped");
  assert.equal(Object.hasOwn(stoppedPayload, "capture"), false);

  const provenanceStarted = await client.callTool(
    {
      name: "start_remote_control",
      arguments: {
        cwd: provenanceJunction,
        managedSession: provenanceCleanupSession,
        remoteName: "Provenance Cleanup Test",
        permissionMode: "plan",
      },
    },
    undefined,
    { timeout: 45000 }
  );
  assert.equal(
    provenanceStarted.isError,
    undefined,
    provenanceStarted.content?.[0]?.text
  );
  assert.equal(
    JSON.parse(provenanceStarted.content[0].text).status,
    "started"
  );
  fs.unlinkSync(provenanceJunction);
  fs.symlinkSync(provenanceTargetB, provenanceJunction, "junction");

  const provenanceStatusResult = await client.callTool(
    { name: "status", arguments: {} },
    undefined,
    { timeout: 30000 }
  );
  const provenanceStatus = JSON.parse(
    provenanceStatusResult.content?.[0]?.text ?? "{}"
  );
  assert.equal(
    provenanceStatus.managedSessions.some(
      (session) => session.name === provenanceCleanupSession
    ),
    false
  );
  assert.equal(
    provenanceStatus.cleanupEligibleSessions.some(
      (session) =>
        session.name === provenanceCleanupSession &&
        session.state === "provenance_changed"
    ),
    true
  );
  const blockedProvenanceStop = await client.callTool(
    {
      name: "stop_remote_control",
      arguments: {
        managedSession: provenanceCleanupSession,
        graceful: true,
        force: false,
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(blockedProvenanceStop.isError, undefined);
  const blockedProvenancePayload = JSON.parse(
    blockedProvenanceStop.content?.[0]?.text ?? "{}"
  );
  assert.equal(blockedProvenancePayload.status, "stop_blocked");
  assert.equal(
    blockedProvenancePayload.reason,
    "cwd_provenance_changed"
  );
  assert.equal(
    Object.hasOwn(blockedProvenancePayload, "capture"),
    false
  );
  const provenanceStopped = await client.callTool(
    {
      name: "stop_remote_control",
      arguments: {
        managedSession: provenanceCleanupSession,
        graceful: false,
        force: true,
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(
    provenanceStopped.isError,
    undefined,
    provenanceStopped.content?.[0]?.text
  );
  const provenanceStoppedPayload = JSON.parse(
    provenanceStopped.content?.[0]?.text ?? "{}"
  );
  assert.equal(provenanceStoppedPayload.status, "stopped");
  assert.equal(
    Object.hasOwn(provenanceStoppedPayload, "capture"),
    false
  );
  console.log("windows-command-wrapper ok");
} finally {
  await client.close();
  for (const sessionName of [managedSession, provenanceCleanupSession]) {
    try {
      const leaseId = `cleanup-${process.pid}-${sessionName}`;
      const lease = await windowsBrokerRequest(
        "acquireLease",
        { sessionName, leaseId, ttlMs: 10000 },
        { startIfMissing: false, env: mcpEnv, timeoutMs: 10000 }
      );
      await windowsBrokerRequest(
        "stop",
        {
          sessionName,
          graceful: false,
          force: true,
          omitCapture: true,
          leaseId: lease.status === "acquired" ? leaseId : undefined,
        },
        { startIfMissing: false, env: mcpEnv, timeoutMs: 10000 }
      );
    } catch {
      // The test may already have stopped the session.
    }
  }
  try {
    const compatibilityLeaseId =
      `cleanup-${process.pid}-${compatibilityCleanupSession}`;
    const lease = await windowsBrokerRequest(
      "acquireLease",
      {
        sessionName: compatibilityCleanupSession,
        leaseId: compatibilityLeaseId,
        ttlMs: 10000,
      },
      { startIfMissing: false, env: staleBrokerEnv, timeoutMs: 10000 }
    );
    await windowsBrokerRequest(
      "stop",
      {
        sessionName: compatibilityCleanupSession,
        graceful: false,
        force: true,
        leaseId:
          lease.status === "acquired" ? compatibilityLeaseId : undefined,
      },
      { startIfMissing: false, env: staleBrokerEnv, timeoutMs: 10000 }
    );
  } catch {
    // Compatibility cleanup may already have removed the session and broker.
  }
  for (const brokerEnv of [mcpEnv, staleBrokerEnv]) {
    try {
      await windowsBrokerRequest(
        "shutdown",
        {},
        { startIfMissing: false, env: brokerEnv }
      );
      const deadline = Date.now() + 5000;
      while ((await probeWindowsBroker(brokerEnv)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {
      // The isolated broker may already be gone or use the other launch policy.
    }
  }
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
