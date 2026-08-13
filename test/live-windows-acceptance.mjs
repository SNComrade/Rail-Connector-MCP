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

if (process.env.RAIL_CONNECTOR_LIVE_ACCEPTANCE !== "1") {
  console.log("live-windows-acceptance skipped; set RAIL_CONNECTOR_LIVE_ACCEPTANCE=1");
  process.exit(0);
}
if (process.platform !== "win32") throw new Error("Live Windows acceptance requires native Windows.");

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "Rail-Connector-Live-"));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "Rail-Connector-State-"));
const managedSession = `live_acceptance_${process.pid}`;
const resumedManagedSession = `${managedSession}_resume`;
const continuedManagedSession = `${managedSession}_continue`;
const forkedManagedSession = `${managedSession}_fork`;
const initialTitle = `Rail Live ${process.pid}`;
const renamedTitle = `Rail Verified ${process.pid}`;
const proofFile = path.join(workspace, "bypass-ultracode-proof.txt");
const proofText = `BYPASS_ULTRACODE_OK_${process.pid}`;
const lowLevelTextProof = `LOW_LEVEL_TEXT_OK_${process.pid}`;
const lowLevelKeyProof = `LOW_LEVEL_KEY_OK_${process.pid}`;
const resumeProof = `RESUME_OK_${process.pid}`;
const continueProof = `CONTINUE_OK_${process.pid}`;
const forkProof = `FORK_OK_${process.pid}`;
const claudeConfigDir = path.resolve(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
);
const claudeProjectDir = path.join(
  claudeConfigDir,
  "projects",
  workspace.replace(/[^A-Za-z0-9]/g, "-")
);
const claudeProjectDirExisted = fs.existsSync(claudeProjectDir);
const mcpEnv = {
  ...process.env,
  RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS:
    "I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS",
  RAIL_CONNECTOR_STATE_DIR: stateDir,
};
process.env.RAIL_CONNECTOR_STATE_DIR = stateDir;

function resultText(result) {
  return (result.content || []).map((item) => item.text || "").join("\n");
}

async function connectClient(name, env = mcpEnv) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.js"],
    cwd: repoRoot,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (data) => process.stderr.write(data.toString()));
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport, { timeout: 30000 });
  return { client, transport };
}

async function call(client, name, args, timeout = 30000) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
  if (result.isError) throw new Error(`${name}: ${resultText(result)}`);
  return JSON.parse(resultText(result));
}

async function completeProofTurn(client, sessionName, proof) {
  const submitted = await call(
    client,
    "submit_prompt",
    {
      managedSession: sessionName,
      text: `Reply with exactly: ${proof}`,
      submitRetries: 1,
      lines: 120,
    },
    30000
  );
  assert.equal(submitted.status, "submitted");
  assert.ok(submitted.waitAfterCursor);
  const completed = await call(
    client,
    "wait_for_claude_turn",
    {
      managedSession: sessionName,
      afterCursor: submitted.waitAfterCursor,
      timeoutSeconds: 240,
      pollIntervalMs: 1000,
      lines: 120,
    },
    270000
  );
  assert.equal(completed.status, "completed");
  assert.match(
    completed.transcript.lastAssistant.text,
    new RegExp(proof)
  );
  return completed;
}

let firstClient;
let secondClient;
let resolvedSessionId = "";
try {
  firstClient = await connectClient("rail-live-first");
  const capabilities = await call(firstClient.client, "get_claude_capabilities", {});
  assert.equal(capabilities.mcp.bypassPermissionsEnabled, true);
  assert.equal(capabilities.mcp.bypassPermissionsPolicyMode, "local_host_acknowledged");
  assert.equal(capabilities.ultracode.launchMechanism, "effort_flag");

  const started = await call(
    firstClient.client,
    "start_remote_control",
    {
      cwd: workspace,
      managedSession,
      remoteName: "Rail Live Acceptance",
      sessionTitle: initialTitle,
      permissionMode: "bypassPermissions",
      confirmBypassPermissions: true,
      ultracode: true,
      confirmUltracode: true,
      trustWorkspace: true,
      killExisting: false,
    },
    45000
  );
  assert.equal(started.status, "started");
  assert.equal(started.permissionModeRequested, "bypassPermissions");
  assert.equal(started.permissionModeResolved, "bypassPermissions");
  assert.equal(started.ultracodeMechanism, "effort");
  assert.equal(started.logBindingStatus, "resolved");
  assert.ok(started.resolvedSessionId);
  resolvedSessionId = started.resolvedSessionId;

  const submitted = await call(
    firstClient.client,
    "submit_prompt",
    {
      managedSession,
      text:
        `Create the file bypass-ultracode-proof.txt in the current directory with exactly this one line: ${proofText}\n` +
        `Do not ask for confirmation. After verifying the file, reply with exactly: ${proofText}`,
      submitRetries: 1,
      lines: 160,
    },
    30000
  );
  assert.equal(submitted.status, "submitted");
  assert.equal(typeof submitted.waitAfterCursor, "string");
  assert.ok(submitted.waitAfterCursor);

  await firstClient.client.close();
  firstClient = null;
  secondClient = await connectClient("rail-live-wait-refreshed");
  const completed = await call(
    secondClient.client,
    "wait_for_claude_turn",
    {
      managedSession,
      afterCursor: submitted.waitAfterCursor,
      timeoutSeconds: 240,
      pollIntervalMs: 1000,
      lines: 120,
    },
    270000
  );
  assert.equal(completed.status, "completed");
  assert.match(completed.transcript.lastAssistant.text, new RegExp(proofText));
  assert.equal(fs.readFileSync(proofFile, "utf8").trim(), proofText);
  assert.equal(completed.posture.observed.permissionMode, "bypassPermissions");
  assert.equal(completed.posture.observed.ultracode, true);

  const lowLevelText = await call(secondClient.client, "send_text", {
    managedSession,
    text: `Reply with exactly: ${lowLevelTextProof}`,
    submit: true,
  });
  assert.ok(lowLevelText.waitAfterCursor);
  const lowLevelTextCompleted = await call(
    secondClient.client,
    "wait_for_claude_turn",
    {
      managedSession,
      afterCursor: lowLevelText.waitAfterCursor,
      timeoutSeconds: 180,
      pollIntervalMs: 1000,
      lines: 120,
    },
    210000
  );
  assert.equal(lowLevelTextCompleted.status, "completed");
  assert.match(
    lowLevelTextCompleted.transcript.lastAssistant.text,
    new RegExp(lowLevelTextProof)
  );

  const stagedLowLevelKey = await call(secondClient.client, "send_text", {
    managedSession,
    text: `Reply with exactly: ${lowLevelKeyProof}`,
    submit: false,
  });
  assert.equal(stagedLowLevelKey.waitAfterCursor, undefined);
  const lowLevelKey = await call(secondClient.client, "send_key", {
    managedSession,
    key: "Enter",
  });
  assert.ok(lowLevelKey.waitAfterCursor);
  const lowLevelKeyCompleted = await call(
    secondClient.client,
    "wait_for_claude_turn",
    {
      managedSession,
      afterCursor: lowLevelKey.waitAfterCursor,
      timeoutSeconds: 180,
      pollIntervalMs: 1000,
      lines: 120,
    },
    210000
  );
  assert.equal(lowLevelKeyCompleted.status, "completed");
  assert.match(
    lowLevelKeyCompleted.transcript.lastAssistant.text,
    new RegExp(lowLevelKeyProof)
  );

  const renamed = await call(secondClient.client, "rename_claude_session", {
    managedSession,
    title: renamedTitle,
  });
  assert.equal(renamed.status, "renamed");
  const alreadyNamed = await call(secondClient.client, "rename_claude_session", {
    managedSession,
    title: renamedTitle,
  });
  assert.equal(alreadyNamed.status, "already_named");

  await secondClient.client.close();
  secondClient = null;

  const noBypassEnv = { ...mcpEnv };
  delete noBypassEnv.RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS;
  secondClient = await connectClient("rail-live-refreshed", noBypassEnv);
  const refreshedStatus = await call(secondClient.client, "status", {});
  assert.equal(Object.hasOwn(refreshedStatus, "activeClaudeAgents"), false);
  assert.equal(
    refreshedStatus.managedSessions.some((session) => session.name === managedSession),
    true
  );
  const refreshedCapture = await call(secondClient.client, "capture_remote_control", {
    managedSession,
    lines: 100,
  });
  assert.equal(refreshedCapture.transcript.resolvedSessionId, resolvedSessionId);
  const rejectedBypassMutation = await secondClient.client.callTool(
    {
      name: "send_text",
      arguments: {
        managedSession,
        text: "this must not reach the bypass session",
        submit: false,
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(rejectedBypassMutation.isError, true);
  assert.match(
    resultText(rejectedBypassMutation),
    /bypassPermissions is disabled/
  );

  const stopped = await call(secondClient.client, "stop_remote_control", {
    managedSession,
    graceful: true,
    force: false,
  });
  assert.equal(stopped.status, "stopped");

  const found = await call(secondClient.client, "list_claude_sessions", {
    cwd: workspace,
    query: renamedTitle,
    includeSnippets: true,
    archiveState: "active",
    limit: 10,
  });
  assert.equal(found.sessions.some((session) => session.sessionId === resolvedSessionId), true);

  assert.equal(
    (
      await call(secondClient.client, "archive_claude_session", {
        cwd: workspace,
        sessionId: resolvedSessionId,
      })
    ).status,
    "archived"
  );
  const hidden = await call(secondClient.client, "list_claude_sessions", {
    cwd: workspace,
    archiveState: "active",
  });
  assert.equal(hidden.sessions.some((session) => session.sessionId === resolvedSessionId), false);
  assert.equal(
    (
      await call(secondClient.client, "unarchive_claude_session", {
        cwd: workspace,
        sessionId: resolvedSessionId,
      })
    ).status,
    "unarchived"
  );

  const resumed = await call(
    secondClient.client,
    "start_remote_control",
    {
      cwd: workspace,
      managedSession: resumedManagedSession,
      resumeSessionName: renamedTitle,
      remoteName: "Rail Resume Acceptance",
      permissionMode: "default",
      trustWorkspace: true,
      killExisting: false,
    },
    45000
  );
  assert.equal(resumed.status, "started");
  assert.equal(resumed.resolvedSessionId, resolvedSessionId);
  assert.equal(resumed.logBindingStatus, "resolved");
  assert.match(resumed.remoteUrl, /^https:\/\/claude\.ai\/code\//);
  assert.equal(resumed.permissionModeRequested, "default");
  assert.equal(
    ["default", "manual"].includes(resumed.permissionModeResolved),
    true
  );
  const resumeCompleted = await completeProofTurn(
    secondClient.client,
    resumedManagedSession,
    resumeProof
  );
  assert.notEqual(
    resumeCompleted.posture.observed.permissionMode,
    "bypassPermissions"
  );
  await call(secondClient.client, "stop_remote_control", {
    managedSession: resumedManagedSession,
    graceful: true,
    force: false,
  });

  const continued = await call(
    secondClient.client,
    "start_remote_control",
    {
      cwd: workspace,
      managedSession: continuedManagedSession,
      continueLatest: true,
      remoteName: "Rail Continue Acceptance",
      permissionMode: "default",
      trustWorkspace: true,
    },
    45000
  );
  assert.equal(continued.status, "started");
  assert.equal(continued.resolvedSessionId, resolvedSessionId);
  assert.equal(continued.logBindingStatus, "resolved");
  assert.match(continued.remoteUrl, /^https:\/\/claude\.ai\/code\//);
  assert.equal(continued.permissionModeRequested, "default");
  assert.equal(
    ["default", "manual"].includes(continued.permissionModeResolved),
    true
  );
  const continueCompleted = await completeProofTurn(
    secondClient.client,
    continuedManagedSession,
    continueProof
  );
  assert.notEqual(
    continueCompleted.posture.observed.permissionMode,
    "bypassPermissions"
  );
  await call(secondClient.client, "stop_remote_control", {
    managedSession: continuedManagedSession,
    graceful: true,
    force: false,
  });

  const forked = await call(
    secondClient.client,
    "start_remote_control",
    {
      cwd: workspace,
      managedSession: forkedManagedSession,
      sessionId: resolvedSessionId,
      forkSession: true,
      remoteName: "Rail Fork Acceptance",
      permissionMode: "default",
      trustWorkspace: true,
    },
    45000
  );
  assert.equal(forked.status, "started");
  assert.ok(forked.resolvedSessionId);
  assert.notEqual(forked.resolvedSessionId, resolvedSessionId);
  assert.equal(forked.logBindingStatus, "resolved");
  assert.match(forked.remoteUrl, /^https:\/\/claude\.ai\/code\//);
  assert.equal(forked.permissionModeRequested, "default");
  assert.equal(
    ["default", "manual"].includes(forked.permissionModeResolved),
    true
  );
  const forkCompleted = await completeProofTurn(
    secondClient.client,
    forkedManagedSession,
    forkProof
  );
  assert.notEqual(
    forkCompleted.posture.observed.permissionMode,
    "bypassPermissions"
  );
  await call(secondClient.client, "stop_remote_control", {
    managedSession: forkedManagedSession,
    graceful: true,
    force: false,
  });

  console.log(
    JSON.stringify({
      status: "live acceptance ok",
      resolvedSessionId,
      proofText,
      lowLevelTextProof,
      lowLevelKeyProof,
      resumeProof,
      continueProof,
      forkProof,
      workspace,
    })
  );
} finally {
  if (firstClient) await firstClient.client.close().catch(() => {});
  if (secondClient) await secondClient.client.close().catch(() => {});
  for (const sessionName of [
    managedSession,
    resumedManagedSession,
    continuedManagedSession,
    forkedManagedSession,
  ]) {
    try {
      const leaseId = `cleanup-${process.pid}-${sessionName}`;
      const lease = await windowsBrokerRequest(
        "acquireLease",
        { sessionName, leaseId, ttlMs: 10000 },
        { startIfMissing: false, timeoutMs: 10000 }
      );
      await windowsBrokerRequest(
        "stop",
        {
          sessionName,
          graceful: false,
          force: true,
          leaseId: lease.status === "acquired" ? leaseId : undefined,
        },
        { startIfMissing: false, timeoutMs: 10000 }
      );
    } catch {
      // The session may already be stopped.
    }
  }
  try {
    await windowsBrokerRequest("shutdown", {}, { startIfMissing: false });
    const deadline = Date.now() + 5000;
    while ((await probeWindowsBroker()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch {
    // The broker may already have exited.
  }
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (!claudeProjectDirExisted) {
    fs.rmSync(claudeProjectDir, { recursive: true, force: true });
  }
}
