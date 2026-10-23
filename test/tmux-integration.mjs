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
const wireFile = path.join(root, "wire.jsonl");
const fakeClaude = path.join(root, "claude");
function fakeTmuxClaude(wireFile) {
  const fs = require("node:fs");
  const { StringDecoder } = require("node:string_decoder");
  if (process.argv.includes("--version")) { console.log("2.1.220 (Claude Code)"); return; }
  if (process.argv.includes("--help")) {
    console.log("--effort <level> low, medium, high, xhigh, max, ultracode\n--permission-mode <mode> default, manual, plan, acceptEdits, auto, dontAsk, bypassPermissions\n--settings <file-or-json>\n--remote-control");
    return;
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const decoder = new StringDecoder("utf8");
  let wire = "";
  let input = "";
  let pasted = false;
  process.stdout.write("https://claude.ai/code/session_tmux_integration\r\n> ");
  process.stdin.on("data", (data) => {
    fs.appendFileSync(wireFile, `${JSON.stringify(data.toString("base64"))}\n`);
    wire += decoder.write(data);
    while (wire.length) {
      if (wire.startsWith("\x1b[200~")) { pasted = true; wire = wire.slice(6); continue; }
      if (wire.startsWith("\x1b[201~")) { pasted = false; wire = wire.slice(6); continue; }
      if ("\x1b[200~".startsWith(wire) || "\x1b[201~".startsWith(wire)) break;
      const character = wire[0];
      wire = wire.slice(1);
      if (!pasted && /[\r\n]/.test(character)) {
        const command = input;
        input = "";
        if (command === "/exit") process.exit(0);
        if (command === "/frame-mode-on") process.stdout.write("\x1b[?2004h\r\nFRAME_MODE:on\r\n> ");
        else if (command === "/workflow-test") process.stdout.write("\r\nWaiting for 1 dynamic workflow to finish\r\n> ");
        else if (command === "/workflow-clear") process.stdout.write("\r\nWorked for 2s\r\n> ");
        else process.stdout.write(`\r\nACK:${JSON.stringify(command)}\r\n> `);
      } else input += character;
    }
  });
}
fs.writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node\n(${fakeTmuxClaude.toString()})(${JSON.stringify(wireFile)});\n`,
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

  await tmux([
    "set-option",
    "-t",
    managedName,
    metadataOption,
    JSON.stringify({
      ...upgradedMetadata,
      observedPosture: {
        permissionMode: "plan",
        model: "claude-fable-5-1",
        effort: "high",
        ultracode: null,
        evidence: { effort: "legacy-test-fixture" },
      },
    }),
  ]);
  const statusWithLegacyObservation = await client.callTool(
    { name: "status", arguments: {} },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(
    statusWithLegacyObservation.isError,
    undefined,
    statusWithLegacyObservation.content?.[0]?.text
  );
  const statusManagedSession = JSON.parse(
    statusWithLegacyObservation.content?.[0]?.text ?? "{}"
  ).managedSessions.find((session) => session.name === managedName);
  assert.ok(statusManagedSession);
  assert.equal(Object.hasOwn(statusManagedSession, "observedPosture"), false);

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

  const readWire = () => fs.existsSync(wireFile) ? Buffer.concat(fs.readFileSync(wireFile, "utf8")
    .split("\n").filter(Boolean).map((line) => Buffer.from(JSON.parse(line), "base64"))) : Buffer.alloc(0);
  const prompt = "Unicode 🧪 résumé\tTAB\nLF\rCR\r\nlast";
  const modeOffWire = readWire();
  for (const [text, pasteMode] of [[prompt, "auto"], ["strict single line", "bracketed"]]) {
    const refused = await client.callTool({ name: "submit_prompt", arguments: {
      managedSession: managedName, text, pasteMode, submitRetries: 0,
    } }, undefined, { timeout: 30000 });
    assert.equal(refused.isError, true);
    assert.match(refused.content?.[0]?.text ?? "", /no input was sent/);
    assert.deepEqual(readWire(), modeOffWire, "unavailable framing must not deliver body or Enter");
  }
  const enabled = await client.callTool({ name: "send_text", arguments: {
    managedSession: managedName, text: "/frame-mode-on", submit: true,
  } }, undefined, { timeout: 30000 });
  assert.equal(enabled.isError, undefined, enabled.content?.[0]?.text);
  let mode = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    mode = (await tmux(["display-message", "-p", "-t", currentMetadata.paneId,
      "#{bracket_paste_flag}"])).stdout.trim();
    if (mode !== "0") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const beforeFramed = readWire().length;
  const submitted = await client.callTool(
    {
      name: "submit_prompt",
      arguments: {
        managedSession: managedName,
        text: prompt,
        pasteMode: "bracketed",
        submitRetries: 0,
        chunkDelayMs: 0,
      },
    },
    undefined,
    { timeout: 30000 }
  );
  if (mode === "1") {
    assert.equal(submitted.isError, undefined, submitted.content?.[0]?.text);
    const submitPayload = JSON.parse(submitted.content[0].text);
    assert.equal(submitPayload.status, "submitted", submitted.content[0].text);
    assert.equal(submitPayload.bracketedPasteUsed, true);
    assert.equal(readWire().subarray(beforeFramed).toString("utf8"), `\x1b[200~${prompt}\x1b[201~\r`);
    const ack = `ACK:${JSON.stringify(prompt)}`;
    assert.ok(submitPayload.capture.replaceAll("\n", "").includes(ack),
      "wire framing and synthetic ACK must preserve the complete logical prompt");
    assert.equal(submitPayload.transcriptAcknowledged, false,
      "a synthetic terminal ACK is not a Claude transcript acknowledgement");
  } else {
    assert.equal(mode, "", "expected unknown format on older supported tmux, not an observed disabled mode");
    assert.equal(submitted.isError, true);
    assert.match(submitted.content?.[0]?.text ?? "", /no input was sent/);
    assert.equal(readWire().length, beforeFramed);
    console.log("tmux-integration: mode format unavailable; strict refusal verified, mode-on wire acceptance UNTESTED");
  }

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
