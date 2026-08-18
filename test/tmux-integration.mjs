import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.platform === "win32") {
  console.log("tmux-integration skipped on Windows");
  process.exit(0);
}

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rail-connector-tmux-"));
const unmanagedName = `rail-unmanaged-${process.pid}`;
const managedName = `rail-managed-${process.pid}`;
const outputFile = path.join(root, "multiline.txt");
const fakeClaude = path.join(root, "claude");
fs.writeFileSync(
  fakeClaude,
  [
    "#!/usr/bin/env bash",
    "if [[ \"${1:-}\" == \"--version\" ]]; then",
    "  printf '2.1.220 (Claude Code)\\n'",
    "  exit 0",
    "fi",
    "if [[ \"${1:-}\" == \"--help\" ]]; then",
    "  printf '%s\\n' '  --effort <level> low, medium, high, xhigh, max, ultracode'",
    "  printf '%s\\n' '  --permission-mode <mode> default, manual, plan, acceptEdits, auto, dontAsk, bypassPermissions'",
    "  printf '%s\\n' '  --settings <file-or-json>'",
    "  printf '%s\\n' '  --remote-control'",
    "  exit 0",
    "fi",
    "printf 'https://claude.ai/code/session_tmux_integration\\n'",
    "while IFS= read -r command; do",
    "  if [[ \"$command\" == \"/exit\" ]]; then exit 0; fi",
    "  if [[ \"$command\" == \"/workflow-test\" ]]; then",
    "    printf 'Waiting for 1 dynamic workflow to finish\\n'",
    "    continue",
    "  fi",
    "  if [[ \"$command\" == \"/workflow-clear\" ]]; then",
    "    printf 'Worked for 2s\\n'",
    "    continue",
    "  fi",
    "  eval \"$command\"",
    "done",
    "",
  ].join("\n"),
  { mode: 0o755 }
);

async function tmux(args) {
  return execFileAsync("tmux", args, { timeout: 10000 });
}

async function killTmux(name) {
  try {
    await tmux(["kill-session", "-t", name]);
  } catch {
    // Session is already gone.
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/index.js"],
  cwd: repoRoot,
  env: {
    ...process.env,
    RAIL_CONNECTOR_CLAUDE_PATH: fakeClaude,
    CLAUDE_CONFIG_DIR: path.join(root, "claude-config"),
    RAIL_CONNECTOR_STATE_DIR: path.join(root, "state"),
  },
  stderr: "pipe",
});
const client = new Client({ name: "rail-connector-tmux-integration", version: "1.0.0" }, { capabilities: {} });

try {
  await tmux(["new-session", "-d", "-s", unmanagedName, "sleep", "60"]);
  await client.connect(transport, { timeout: 30000 });

  const unmanagedCapture = await client.callTool(
    { name: "capture_remote_control", arguments: { managedSession: unmanagedName, lines: 20 } },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(unmanagedCapture.isError, true);
  assert.match(unmanagedCapture.content?.[0]?.text ?? "", /no valid Rail Connector ownership metadata/i);
  await killTmux(unmanagedName);

  const started = await client.callTool(
    {
      name: "start_remote_control",
      arguments: {
        managedSession: managedName,
        cwd: root,
        remoteName: "tmux integration",
        permissionMode: "plan",
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(started.isError, undefined);
  const startPayload = JSON.parse(started.content[0].text);
  assert.equal(startPayload.status, "started");
  assert.equal(startPayload.remoteUrl, "https://claude.ai/code/session_tmux_integration");
  assert.match(startPayload.resolvedSessionId, /^[0-9a-f-]{36}$/);

  const metadataOption = "@rail_connector_launch";
  const currentMetadata = JSON.parse(
    (await tmux(["show-options", "-t", managedName, "-v", metadataOption])).stdout.trim()
  );
  const {
    bypassPermissionsPolicyMode: _removedPolicyMode,
    ...v2RequestedPosture
  } = currentMetadata.requestedPosture;
  const v2Metadata = {
    schemaVersion: 2,
    cwd: currentMetadata.cwd,
    startedAt: currentMetadata.startedAt,
    paneId: currentMetadata.paneId,
    pid: currentMetadata.pid,
    args: currentMetadata.args,
    requestedPosture: v2RequestedPosture,
  };
  await tmux([
    "set-option",
    "-t",
    managedName,
    metadataOption,
    JSON.stringify(v2Metadata),
  ]);
  const upgradedCapture = await client.callTool(
    {
      name: "capture_remote_control",
      arguments: { managedSession: managedName, lines: 40 },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(upgradedCapture.isError, undefined, upgradedCapture.content?.[0]?.text);
  const upgradedMetadata = JSON.parse(
    (await tmux(["show-options", "-t", managedName, "-v", metadataOption])).stdout.trim()
  );
  assert.equal(upgradedMetadata.schemaVersion, 3);
  assert.equal(upgradedMetadata.requestedPosture.bypassPermissionsPolicyMode, null);
  assert.equal(upgradedMetadata.resolvedPosture.bypassPermissionsPolicyMode, null);
  const postUpgradeCapture = await client.callTool(
    {
      name: "capture_remote_control",
      arguments: { managedSession: managedName, lines: 40 },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(postUpgradeCapture.isError, undefined, postUpgradeCapture.content?.[0]?.text);

  const otherPane = await tmux([
    "split-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    managedName,
    "sleep",
    "60",
  ]);
  const otherPaneId = otherPane.stdout.trim();
  assert.match(otherPaneId, /^%\d+$/);
  await tmux(["select-pane", "-t", otherPaneId]);

  const shellPath = outputFile.replaceAll("'", "'\\''");
  const prompt = `printf 'alpha\\n' > '${shellPath}'\nprintf 'beta\\n' >> '${shellPath}'`;
  const submitted = await client.callTool(
    {
      name: "submit_prompt",
      arguments: {
        managedSession: managedName,
        text: prompt,
        pasteMode: "auto",
        submitRetries: 0,
        chunkDelayMs: 0,
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(submitted.isError, undefined);
  const submitPayload = JSON.parse(submitted.content[0].text);
  assert.equal(submitPayload.status, "submitted", submitted.content[0].text);

  for (let i = 0; i < 20 && !fs.existsSync(outputFile); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(fs.readFileSync(outputFile, "utf8"), "alpha\nbeta\n");

  const workflowStarted = await client.callTool(
    {
      name: "send_text",
      arguments: {
        managedSession: managedName,
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

  const blockedWorkflowSubmit = await client.callTool(
    {
      name: "submit_prompt",
      arguments: {
        managedSession: managedName,
        text: "must not submit",
        force: false,
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(
    blockedWorkflowSubmit.isError,
    undefined,
    blockedWorkflowSubmit.content?.[0]?.text
  );
  const blockedWorkflowSubmitPayload = JSON.parse(
    blockedWorkflowSubmit.content?.[0]?.text ?? "{}"
  );
  assert.equal(blockedWorkflowSubmitPayload.status, "preflight_blocked");
  assert.equal(blockedWorkflowSubmitPayload.reason, "workflow_pending");

  const blockedWorkflowAlias = await client.callTool(
    {
      name: "send_key",
      arguments: { managedSession: managedName, key: "C-m" },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(
    blockedWorkflowAlias.isError,
    undefined,
    blockedWorkflowAlias.content?.[0]?.text
  );
  const blockedWorkflowAliasPayload = JSON.parse(
    blockedWorkflowAlias.content?.[0]?.text ?? "{}"
  );
  assert.equal(blockedWorkflowAliasPayload.status, "send_blocked");
  assert.equal(blockedWorkflowAliasPayload.reason, "workflow_pending");

  const blockedWorkflowStop = await client.callTool(
    {
      name: "stop_remote_control",
      arguments: {
        managedSession: managedName,
        graceful: true,
        force: false,
      },
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
        managedSession: managedName,
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

  const stopped = await client.callTool(
    { name: "stop_remote_control", arguments: { managedSession: managedName } },
    undefined,
    { timeout: 30000 }
  );
  const stopPayload = JSON.parse(stopped.content[0].text);
  assert.equal(stopPayload.status, "stopped");
  assert.equal(stopPayload.graceful, true);
  assert.equal(stopPayload.cleanedRemainingPanes, true);
  await assert.rejects(tmux(["has-session", "-t", managedName]));
  console.log("tmux-integration ok");
} finally {
  await client.close().catch(() => {});
  await killTmux(unmanagedName);
  await killTmux(managedName);
  fs.rmSync(root, { recursive: true, force: true });
}
