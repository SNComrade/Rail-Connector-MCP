import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { windowsBrokerRequest } from "../src/windows-broker-client.js";

const expectedDebugReadyStatus =
  process.platform === "win32" ? "ready_acl_unverified" : "ready";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-launch-proof-"));
const workspace = path.join(root, "workspace with spaces");
const configDir = path.join(root, "claude config");
const stateDir = path.join(root, "state");
const argvDir = path.join(configDir, "test-argv-records");
const fixture = path.join(repoRoot, "test", "fixtures", "fake-claude-tui.mjs");
const wrapper = path.join(
  root,
  process.platform === "win32" ? "claude proof.cmd" : "claude proof"
);
const managedSession = `launch_proof_${process.pid}`;
fs.mkdirSync(workspace, { recursive: true });

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return fs.realpathSync.native?.(resolved) ?? fs.realpathSync(resolved);
}

if (process.platform === "win32") {
  fs.writeFileSync(
    wrapper,
    [
      "@echo off",
      `"${process.execPath}" "${fixture}" %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n")
  );
} else {
  fs.writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `exec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
}

const baseEnv = {
  ...process.env,
  RAIL_CONNECTOR_CLAUDE_PATH: wrapper,
  RAIL_CONNECTOR_STATE_DIR: stateDir,
  RAIL_CONNECTOR_ALLOWED_ROOTS: root,
  CLAUDE_CONFIG_DIR: configDir,
  CLAUDE_CODE_EFFORT_LEVEL: "xhigh",
  CLAUDE_CODE_DISABLE_WORKFLOWS: "0",
  RAIL_DELAYED_EXPANSION: "must-not-rewrite-debug-filter",
};

function createMcpClient(env, name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/index.js"],
    cwd: repoRoot,
    env,
    stderr: "pipe",
  });
  const client = new Client(
    { name, version: "1.0.0" },
    { capabilities: {} }
  );
  return { client, transport };
}

async function callTool(client, name, args = {}, timeout = 45000) {
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout }
  );
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content?.[0]?.text ?? "{}");
}

async function invocationRecords(expectedCount) {
  for (let index = 0; index < 100; index += 1) {
    const files = fs.existsSync(argvDir)
      ? fs.readdirSync(argvDir).filter((name) => name.endsWith(".json"))
      : [];
    if (files.length >= expectedCount) {
      return files.map((name) =>
        JSON.parse(fs.readFileSync(path.join(argvDir, name), "utf8"))
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Expected ${expectedCount} fake Claude invocation records.`);
}

let first = null;
let second = null;
try {
  first = createMcpClient(baseEnv, "launch-provenance-first");
  await first.client.connect(first.transport, { timeout: 30000 });

  const capabilities = await callTool(
    first.client,
    "get_claude_capabilities"
  );
  assert.equal(capabilities.available, true);
  assert.equal(capabilities.ultracode.argumentProbe.accepted, true);
  assert.equal(capabilities.ultracode.argumentProbe.exitCode, 0);
  assert.equal(capabilities.ultracode.argumentProbe.controlExitCode, 64);
  assert.equal(
    capabilities.ultracode.argumentProbe.controlRejectionTextMatched,
    false
  );
  assert.equal(
    capabilities.ultracode.argumentProbe.evidenceBasis,
    "exit_status_calibrated"
  );
  assert.equal(capabilities.ultracode.directLaunchVersionFloor, "2.1.203");
  assert.equal(capabilities.advertised.debugFlag, true);
  assert.equal(capabilities.advertised.debugFileFlag, true);

  const started = await callTool(first.client, "start_remote_control", {
    cwd: workspace,
    managedSession,
    remoteName: "Argv Proof @ Transport",
    sessionTitle: "Argv Evidence #1",
    permissionMode: "plan",
    model: "fable:test-model_1",
    ultracode: true,
    confirmUltracode: true,
    debug: true,
    debugFilter: "api,!RAIL_DELAYED_EXPANSION!",
    allowedTools: [
      "Read",
      "Bash(git status:*)",
      "Bash(meta & | < > ^ ( ) * :)",
    ],
  });
  assert.equal(started.status, "started", JSON.stringify(started));
  assert.match(started.claudeCliVersion, /^2\.1\.234\b/);
  assert.equal(started.ultracodeMechanism, "effort");
  assert.equal(
    started.posture.ultracodeAssessment.launchEnvironment.status,
    "compatible"
  );
  assert.equal(
    started.posture.ultracodeAssessment.launchEnvironment.evidenceScope,
    "claude_child_launch_environment"
  );
  assert.equal(started.debugLog.status, expectedDebugReadyStatus);
  assert.equal(started.debugLog.filter, "api,!RAIL_DELAYED_EXPANSION!");
  assert.equal(started.debugLog.identityMatch, true);
  assert.equal(started.debugLog.launchBindingMatch, true);
  assert.equal(started.debugLog.contentsReturned, false);
  assert.equal(started.debugLog.sizeBytes > 0, true);
  assert.equal(
    canonicalPath(path.dirname(started.debugLog.file)),
    canonicalPath(path.join(stateDir, "debug"))
  );
  assert.equal(
    started.posture.audit.debugCapture.status,
    expectedDebugReadyStatus
  );

  const records = await invocationRecords(5);
  const vectors = records.map((record) => record.argv);
  for (const expected of [
    ["--version"],
    ["--help"],
    ["--effort=ultracode", "--version"],
    ["--effort=rail-invalid-probe", "--version"],
  ]) {
    assert.equal(
      vectors.some((vector) => JSON.stringify(vector) === JSON.stringify(expected)),
      true,
      `Missing final child argv ${JSON.stringify(expected)}: ${JSON.stringify(vectors)}`
    );
  }
  const interactive = records.find(
    (record) =>
      !record.argv.includes("--version") && !record.argv.includes("--help")
  );
  assert.ok(interactive, JSON.stringify(records));
  assert.deepEqual(interactive.argv, [
    "--session-id",
    started.sessionId,
    "--model=fable:test-model_1",
    "--effort=ultracode",
    "--allowedTools=Read,Bash(git status:*),Bash(meta & | < > ^ ( ) * :)",
    "--debug=api,!RAIL_DELAYED_EXPANSION!",
    `--debug-file=${started.debugLog.file}`,
    "--name=Argv Evidence #1",
    "--remote-control=Argv Proof @ Transport",
    "--permission-mode=plan",
  ]);
  const actualCwd = canonicalPath(interactive.cwd);
  const expectedCwd = canonicalPath(workspace);
  assert.equal(
    process.platform === "win32" ? actualCwd.toLowerCase() : actualCwd,
    process.platform === "win32" ? expectedCwd.toLowerCase() : expectedCwd
  );
  assert.deepEqual(interactive.environment, {
    effortOverrideStatus: "compatible_xhigh",
    workflowsDisabled: false,
    forceColor: "enabled",
  });

  const boundedWait = await callTool(first.client, "wait_for_claude_turn", {
    managedSession,
    timeoutSeconds: 1,
    pollIntervalMs: 250,
    lines: 40,
  });
  assert.equal(boundedWait.status, "timeout");

  await first.client.close();
  first = null;

  const refreshedEnv = {
    ...baseEnv,
    CLAUDE_CODE_EFFORT_LEVEL: "high",
    CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
  };
  second = createMcpClient(refreshedEnv, "launch-provenance-refreshed");
  await second.client.connect(second.transport, { timeout: 30000 });

  const captured = await callTool(second.client, "capture_remote_control", {
    managedSession,
    lines: 40,
  });
  const assessment = captured.posture.ultracodeAssessment;
  assert.equal(assessment.launchEnvironment.status, "compatible");
  assert.equal(
    assessment.launchEnvironment.effortOverrideStatus,
    "compatible_xhigh"
  );
  assert.equal(assessment.currentMcpEnvironment.status, "blocking");
  assert.deepEqual(assessment.currentMcpEnvironment.blockers, [
    "non_xhigh_effort_override",
    "workflows_disabled",
  ]);
  assert.equal(assessment.environmentComparison, "different");
  assert.notEqual(assessment.status, "environment_blocked");
  assert.equal(
    captured.posture.audit.debugCapture.status,
    expectedDebugReadyStatus
  );
  assert.equal(captured.posture.audit.debugCapture.identityMatch, true);

  const stopped = await callTool(second.client, "stop_remote_control", {
    managedSession,
    graceful: true,
    force: true,
  });
  assert.equal(stopped.status, "stopped", JSON.stringify(stopped));

  const noSession = await callTool(second.client, "stop_remote_control", {
    managedSession,
    graceful: true,
    force: false,
  });
  assert.equal(noSession.status, "not_running");

  console.log(
    `launch-provenance ok (${process.platform === "win32" ? "windows" : "tmux"})`
  );
} finally {
  for (const entry of [second, first]) {
    if (!entry) continue;
    try {
      await callTool(entry.client, "stop_remote_control", {
        managedSession,
        graceful: false,
        force: true,
      });
    } catch {
      // Best-effort cleanup after an assertion failure.
    }
    try {
      await entry.client.close();
    } catch {
      // Transport is already closed.
    }
  }
  if (process.platform === "win32") {
    let shutdownPid = null;
    try {
      const shutdown = await windowsBrokerRequest("shutdown", {}, {
        env: baseEnv,
        startIfMissing: false,
        timeoutMs: 5000,
      });
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
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
