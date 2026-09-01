import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { windowsBrokerRequest } from "../src/windows-broker-client.js";

if (process.env.RAIL_CONNECTOR_LIVE_ULTRACODE !== "1") {
  console.log(
    "live-ultracode-transition skipped; set RAIL_CONNECTOR_LIVE_ULTRACODE=1"
  );
  process.exit(0);
}
if (process.platform !== "win32") {
  throw new Error("Live UltraCode transition validation requires native Windows.");
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "Rail-UltraCode-Transition-"));
const workspace = path.join(root, "workspace");
const stateDir = path.join(root, "state");
const managedSession = `ultracode_transition_${process.pid}`;
const initialProof = `ULTRACODE_INITIAL_OK_${process.pid}`;
const highProof = `HIGH_TRANSITION_OK_${process.pid}`;
const proof = `ULTRACODE_TRANSITION_OK_${process.pid}`;
const claudeConfigDir = path.resolve(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
);
const claudeSettingsFile = path.join(claudeConfigDir, "settings.json");
const claudeSettingsSnapshot = fs.existsSync(claudeSettingsFile)
  ? fs.readFileSync(claudeSettingsFile, "utf8")
  : null;
const testedModel = "claude-fable-5";
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

fs.mkdirSync(workspace, { recursive: true });

function withoutTestedEffortDefaults(settings) {
  const result = structuredClone(settings);
  delete result.effortLevel;
  if (result.modelSettings?.[testedModel]) {
    delete result.modelSettings[testedModel].effortLevel;
    if (Object.keys(result.modelSettings[testedModel]).length === 0) {
      delete result.modelSettings[testedModel];
    }
    if (Object.keys(result.modelSettings).length === 0) {
      delete result.modelSettings;
    }
  }
  return result;
}

function restoreClaudeEffortDefaults() {
  if (!fs.existsSync(claudeSettingsFile)) {
    if (claudeSettingsSnapshot !== null) {
      fs.writeFileSync(claudeSettingsFile, claudeSettingsSnapshot, "utf8");
    }
    return;
  }
  const currentRaw = fs.readFileSync(claudeSettingsFile, "utf8");
  if (currentRaw === claudeSettingsSnapshot) return;
  const current = JSON.parse(currentRaw);
  const original = claudeSettingsSnapshot === null
    ? {}
    : JSON.parse(claudeSettingsSnapshot);
  if (
    JSON.stringify(withoutTestedEffortDefaults(current)) ===
    JSON.stringify(withoutTestedEffortDefaults(original))
  ) {
    if (claudeSettingsSnapshot === null) fs.rmSync(claudeSettingsFile);
    else fs.writeFileSync(claudeSettingsFile, claudeSettingsSnapshot, "utf8");
    return;
  }
  if (Object.hasOwn(original, "effortLevel")) {
    current.effortLevel = original.effortLevel;
  } else {
    delete current.effortLevel;
  }
  const originalModel = original.modelSettings?.[testedModel];
  if (originalModel && Object.hasOwn(originalModel, "effortLevel")) {
    current.modelSettings ??= {};
    current.modelSettings[testedModel] ??= {};
    current.modelSettings[testedModel].effortLevel = originalModel.effortLevel;
  } else if (current.modelSettings?.[testedModel]) {
    delete current.modelSettings[testedModel].effortLevel;
    if (Object.keys(current.modelSettings[testedModel]).length === 0) {
      delete current.modelSettings[testedModel];
    }
    if (Object.keys(current.modelSettings).length === 0) {
      delete current.modelSettings;
    }
  }
  fs.writeFileSync(
    claudeSettingsFile,
    `${JSON.stringify(current, null, 2)}\n`,
    "utf8"
  );
}

function resultText(result) {
  return (result.content || []).map((item) => item.text || "").join("\n");
}

async function call(client, name, args = {}, timeout = 30000) {
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout }
  );
  if (result.isError) throw new Error(`${name}: ${resultText(result)}`);
  return JSON.parse(resultText(result));
}

async function waitForUltraState(client, expectedActive, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await call(client, "capture_remote_control", {
      managedSession,
      lines: 100,
    });
    const attachment =
      latest.posture?.ultracodeAssessment?.ultraEffortAttachment;
    if (attachment?.active === expectedActive) return latest;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timed out waiting for UltraCode active=${expectedActive}; last lifecycle=${JSON.stringify(
      latest?.posture?.ultracodeAssessment?.ultraEffortAttachment ?? null
    )}`
  );
}

async function confirmEffortChange(client, expectedEffort, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  const confirmationLabel = expectedEffort === "ultracode" ? "xhigh" : expectedEffort;
  while (Date.now() < deadline) {
    latest = await call(client, "capture_remote_control", {
      managedSession,
      lines: 100,
    });
    if (/Change effort level\?/i.test(latest.capture || "")) {
      assert.match(
        latest.capture,
        new RegExp(`Yes, switch to ${confirmationLabel}`, "i")
      );
      const confirmed = await call(client, "send_key", {
        managedSession,
        key: "Enter",
      });
      assert.equal(confirmed.status, "sent", JSON.stringify(confirmed));
      return confirmed;
    }
    if (latest.posture?.observed?.effort === expectedEffort) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting to confirm effort=${expectedEffort}; terminalState=${
      latest?.signals?.terminalState ?? "unknown"
    }`
  );
}

async function waitForTurnEvidence(
  client,
  { expectedActive, expectedEffort, proof, timeoutMs = 180000 }
) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await call(client, "capture_remote_control", {
      managedSession,
      lines: 120,
    });
    const attachment =
      latest.posture?.ultracodeAssessment?.ultraEffortAttachment;
    if (
      attachment?.active === expectedActive &&
      latest.posture?.observed?.effort === expectedEffort &&
      latest.transcript?.lastAssistant?.text?.trim() === proof
    ) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `Timed out waiting for turn evidence: ${JSON.stringify({
      expectedActive,
      expectedEffort,
      observedActive:
        latest?.posture?.ultracodeAssessment?.ultraEffortAttachment?.active ??
        null,
      observedEffort: latest?.posture?.observed?.effort ?? null,
      lastAssistantSha256:
        latest?.transcript?.lastAssistant?.textSha256 ?? null,
      terminalState: latest?.signals?.terminalState ?? null,
    })}`
  );
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/index.js"],
  cwd: repoRoot,
  env: mcpEnv,
  stderr: "pipe",
});
transport.stderr?.on("data", (data) => process.stderr.write(data.toString()));
const client = new Client(
  { name: "live-ultracode-transition", version: "1.0.0" },
  { capabilities: {} }
);

let connected = false;
let stopped = false;
try {
  await client.connect(transport, { timeout: 30000 });
  connected = true;
  const capabilities = await call(client, "get_claude_capabilities");
  assert.equal(capabilities.mcp.bypassPermissionsEnabled, true);
  assert.equal(
    capabilities.mcp.bypassPermissionsPolicyMode,
    "local_host_acknowledged"
  );
  assert.equal(capabilities.ultracode.launchMechanism, "effort_flag");
  assert.equal(capabilities.ultracode.argumentProbe.rejected, false);
  assert.equal(capabilities.ultracode.supportedByInstalledVersion, true);
  assert.equal(capabilities.advertised.debugFileFlag, true);

  const started = await call(
    client,
    "start_remote_control",
    {
      cwd: workspace,
      managedSession,
      remoteName: "Rail UltraCode Transition",
      sessionTitle: `Rail UltraCode Transition ${process.pid}`,
      permissionMode: "bypassPermissions",
      confirmBypassPermissions: true,
      model: "claude-fable-5",
      ultracode: true,
      confirmUltracode: true,
      debug: true,
      trustWorkspace: true,
      killExisting: false,
    },
    45000
  );
  assert.equal(started.status, "started", JSON.stringify(started));
  assert.equal(started.permissionModeResolved, "bypassPermissions");
  assert.equal(started.ultracodeMechanism, "effort");
  assert.equal(started.debugLog.status, "ready_acl_unverified");
  assert.equal(started.debugLog.filter, null);
  assert.equal(started.debugLog.launchBindingMatch, true);
  assert.equal(started.debugLog.contentsReturned, false);

  const initialSubmitted = await call(client, "submit_prompt", {
    managedSession,
    text: `Reply with exactly: ${initialProof}`,
    submitRetries: 1,
    lines: 120,
  });
  const initialCompleted = await call(
    client,
    "wait_for_claude_turn",
    {
      managedSession,
      afterCursor: initialSubmitted.waitAfterCursor,
      timeoutSeconds: 180,
      pollIntervalMs: 1000,
      lines: 120,
    },
    210000
  );
  assert.equal(initialCompleted.status, "completed");
  assert.equal(initialCompleted.transcript.lastAssistant.text.trim(), initialProof);
  const entered = await waitForUltraState(client, true);
  assert.equal(
    entered.posture.ultracodeAssessment.status,
    "attachment_lifecycle_active"
  );

  const highCommand = await call(client, "send_text", {
    managedSession,
    text: "/effort high",
    submit: true,
  });
  assert.equal(highCommand.status, "sent");
  await confirmEffortChange(client, "high");
  const highSubmitted = await call(client, "submit_prompt", {
    managedSession,
    text: `Reply with exactly: ${highProof}`,
    submitRetries: 1,
    lines: 120,
  });
  assert.equal(highSubmitted.status, "submitted", JSON.stringify(highSubmitted));
  const highCompleted = await waitForTurnEvidence(client, {
    expectedActive: false,
    expectedEffort: "high",
    proof: highProof,
  });
  assert.equal(highCompleted.transcript.lastAssistant.text.trim(), highProof);
  assert.equal(highCompleted.posture.observed.effort, "high");
  assert.equal(
    highCompleted.posture.ultracodeAssessment.status,
    "exited_after_entry"
  );

  const ultraCommand = await call(client, "send_text", {
    managedSession,
    text: "/effort ultracode",
    submit: true,
  });
  assert.equal(ultraCommand.status, "sent");
  await confirmEffortChange(client, "ultracode");

  const submitted = await call(client, "submit_prompt", {
    managedSession,
    text: `Reply with exactly: ${proof}`,
    submitRetries: 1,
    lines: 120,
  });
  assert.equal(submitted.status, "submitted", JSON.stringify(submitted));
  const completed = await waitForTurnEvidence(client, {
    expectedActive: true,
    expectedEffort: "xhigh",
    proof,
  });
  assert.equal(completed.transcript.lastAssistant.text.trim(), proof);
  assert.equal(completed.posture.observed.effort, "xhigh");
  assert.equal(completed.posture.observed.ultracode, true);
  assert.equal(
    completed.posture.ultracodeAssessment.ultraEffortAttachment.active,
    true
  );
  const transitionAttachment =
    completed.posture.ultracodeAssessment.ultraEffortAttachment;
  assert.equal(transitionAttachment.enterCount >= 2, true);
  assert.equal(transitionAttachment.exitCount >= 1, true);
  assert.equal(transitionAttachment.transitionEvents.length >= 3, true);
  assert.equal(
    completed.posture.audit.debugCapture.sizeBytes > started.debugLog.sizeBytes,
    true,
    JSON.stringify(completed.posture.audit.debugCapture)
  );

  const stoppedResult = await call(client, "stop_remote_control", {
    managedSession,
    graceful: true,
    force: false,
  });
  assert.equal(stoppedResult.status, "stopped", JSON.stringify(stoppedResult));
  stopped = true;

  console.log(
    JSON.stringify(
      {
        status: "live-ultracode-transition ok",
        claudeCliVersion: started.claudeCliVersion,
        permissionMode: completed.posture.observed.permissionMode,
        effort: completed.posture.observed.effort,
        ultracodeActive: completed.posture.observed.ultracode,
        transitionEvents: transitionAttachment.transitionEvents,
        debugStatus: started.debugLog.status,
        debugSizeBytesAtStart: started.debugLog.sizeBytes,
        debugSizeBytesAfterTurn:
          completed.posture.audit.debugCapture.sizeBytes,
      },
      null,
      2
    )
  );
} finally {
  if (connected && !stopped) {
    try {
      await call(client, "stop_remote_control", {
        managedSession,
        graceful: false,
        force: true,
      });
    } catch {
      // Preserve the original test failure.
    }
  }
  if (connected) {
    try {
      await client.close();
    } catch {
      // Transport is already closed.
    }
  }
  let shutdownPid = null;
  try {
    const shutdown = await windowsBrokerRequest(
      "shutdown",
      {},
      { env: mcpEnv, startIfMissing: false, timeoutMs: 5000 }
    );
    shutdownPid = shutdown.pid;
  } catch {
    // The task-owned broker is already stopped.
  }
  if (Number.isInteger(shutdownPid)) {
    for (let index = 0; index < 50; index += 1) {
      try {
        process.kill(shutdownPid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") break;
        process.exitCode = 1;
        console.error(
          `Failed to verify task-owned broker shutdown: ${error?.message || error}`
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    restoreClaudeEffortDefaults();
  } catch (error) {
    process.exitCode = 1;
    console.error(
      `Failed to restore Claude effort defaults: ${error?.message || error}`
    );
  }
  if (!claudeProjectDirExisted) {
    fs.rmSync(claudeProjectDir, { recursive: true, force: true });
  }
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
