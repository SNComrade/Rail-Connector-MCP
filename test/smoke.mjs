import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rail-connector-smoke-"));
const stateDir = path.join(testRoot, "state");
const claudeConfigDir = path.join(testRoot, "claude-config");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/index.js"],
  cwd: repoRoot,
  env: {
    ...process.env,
    RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS: "",
    RAIL_CONNECTOR_STATE_DIR: stateDir,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  },
  stderr: "pipe",
});

transport.stderr?.on("data", (data) => process.stderr.write(data.toString()));

const client = new Client({ name: "rail-connector-mcp-smoke", version: "1.0.0" }, { capabilities: {} });
const text = (result) => (result.content || []).map((item) => item.text || JSON.stringify(item)).join("\n");

await client.connect(transport, { timeout: 30000 });
try {
  const tools = await client.listTools({}, { timeout: 30000 });
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [
    "archive_claude_session",
    "capture_remote_control",
    "get_claude_capabilities",
    "get_claude_result",
    "get_claude_session",
    "list_claude_sessions",
    "rename_claude_session",
    "send_key",
    "send_text",
    "start_remote_control",
    "status",
    "stop_remote_control",
    "submit_prompt",
    "unarchive_claude_session",
    "wait_for_claude_turn",
  ]);
  const sendTextTool = tools.tools.find((tool) => tool.name === "send_text");
  assert.match(sendTextTool.description, /multi-line prompts use submit_prompt/);
  assert.ok(sendTextTool.inputSchema.properties.force);
  assert.ok(
    tools.tools.find((tool) => tool.name === "send_key").inputSchema.properties.force
  );
  assert.ok(
    tools.tools.find((tool) => tool.name === "rename_claude_session")
      .inputSchema.properties.force
  );
  const startTool = tools.tools.find((tool) => tool.name === "start_remote_control");
  assert.ok(startTool.inputSchema.properties.ultracode);
  assert.ok(startTool.inputSchema.properties.confirmUltracode);
  assert.ok(startTool.inputSchema.properties.confirmBypassPermissions);
  assert.ok(startTool.inputSchema.properties.debug);
  assert.ok(startTool.inputSchema.properties.debugFilter);
  assert.ok(startTool.inputSchema.properties.permissionMode.enum.includes("manual"));
  const listTool = tools.tools.find((tool) => tool.name === "list_claude_sessions");
  assert.ok(listTool.inputSchema.properties.includeRemoteUrls);
  assert.ok(listTool.inputSchema.properties.archiveState);
  const resultTool = tools.tools.find((tool) => tool.name === "get_claude_result");
  assert.ok(resultTool.inputSchema.properties.resultId);
  assert.equal(resultTool.inputSchema.properties.maxCharacters.maximum, 64 * 1024);
  console.log("TOOLS", toolNames.join(", "));

  const sessions = await client.callTool(
    { name: "list_claude_sessions", arguments: { cwd: os.homedir(), limit: 3, includeSnippets: false } },
    undefined,
    { timeout: 30000 }
  );
  const sessionPayload = JSON.parse(text(sessions));
  assert.equal(typeof sessionPayload.projectDirExists, "boolean");
  assert.equal(typeof sessionPayload.totalSessionFiles, "number");
  assert.equal(typeof sessionPayload.filesExamined, "number");
  for (const session of sessionPayload.sessions) {
    assert.equal(Object.hasOwn(session, "firstUserPrompt"), false);
    assert.equal(Object.hasOwn(session, "lastUserPrompt"), false);
    assert.equal(Object.hasOwn(session, "lastAssistantText"), false);
    assert.equal(Object.hasOwn(session, "remoteUrl"), false);
    assert.equal(Object.hasOwn(session, "file"), false);
    assert.equal(Object.hasOwn(session, "title"), false);
    assert.equal(typeof session.remoteUrlPresent, "boolean");
    assert.equal(typeof session.titlePresent, "boolean");
  }
  console.log("SESSIONS", `${sessionPayload.sessions.length} metadata records`);

  const bypassDenied = await client.callTool(
    {
      name: "start_remote_control",
      arguments: {
        cwd: os.homedir(),
        permissionMode: "bypassPermissions",
        confirmBypassPermissions: true,
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(bypassDenied.isError, true);
  assert.match(text(bypassDenied), /disabled by policy/);
  assert.match(text(bypassDenied), /newly spawned MCP process/);

  const injectedFlagDenied = await client.callTool(
    {
      name: "start_remote_control",
      arguments: {
        cwd: os.homedir(),
        permissionMode: "plan",
        allowedTools: "--dangerously-skip-permissions",
      },
    },
    undefined,
    { timeout: 30000 }
  );
  assert.equal(injectedFlagDenied.isError, true);

  const status = await client.callTool({ name: "status", arguments: {} }, undefined, { timeout: 30000 });
  const statusPayload = JSON.parse(text(status));
  assert.equal(statusPayload.platform, process.platform);
  assert.ok(["native-windows-broker", "tmux"].includes(statusPayload.backend));
  assert.ok(Array.isArray(statusPayload.managedSessions));
  assert.equal(statusPayload.managedSessions.length, 0);
  assert.equal(typeof statusPayload.claudeProcesses, "string");
  assert.equal(Number.isInteger(statusPayload.mcpProcess.pid), true);
  assert.ok(statusPayload.mcpProcess.pid > 0);
  assert.equal(Number.isNaN(Date.parse(statusPayload.mcpProcess.startedAt)), false);
  assert.equal(typeof statusPayload.bypassPolicy.enabled, "boolean");
  assert.equal(statusPayload.bypassPolicy.readAtProcessStart, true);
  console.log("STATUS", `${statusPayload.platform} ${statusPayload.backend}`);
} finally {
  await client.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
