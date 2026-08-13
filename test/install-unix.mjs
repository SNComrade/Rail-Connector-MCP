import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log("install-unix skipped on Windows");
  process.exit(0);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rail-connector-install-unix-"));
const installRoot = path.join(tempRoot, "repo with spaces");
const allowedRoot = path.join(tempRoot, "allowed project");
const fakeBin = path.join(tempRoot, "fake-bin");
const captureFile = path.join(tempRoot, "codex-argv.bin");

function writeExecutable(name, body) {
  const target = path.join(fakeBin, name);
  fs.writeFileSync(target, `#!/usr/bin/env bash\n${body}\n`, "utf8");
  fs.chmodSync(target, 0o755);
}

function capturedCalls() {
  if (!fs.existsSync(captureFile)) return [];
  const tokens = fs.readFileSync(captureFile).toString("utf8").split("\0");
  const calls = [];
  let current = null;
  for (const token of tokens) {
    if (token === "CALL") current = [];
    else if (token === "END" && current) {
      calls.push(current);
      current = null;
    } else if (current) current.push(token);
  }
  return calls;
}

function runInstaller(policy, extraArgs = []) {
  fs.rmSync(captureFile, { force: true });
  return spawnSync(
    "bash",
    [path.join(installRoot, "install.sh"), "--bypass-policy", policy, ...extraArgs],
    {
      cwd: installRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
        RAIL_INSTALL_CAPTURE: captureFile,
      },
    }
  );
}

try {
  fs.mkdirSync(installRoot, { recursive: true });
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "install.sh"), path.join(installRoot, "install.sh"));

  writeExecutable(
    "node",
    'if [ "${1:-}" = "-p" ]; then printf "24\\n"; elif [ "${1:-}" = "--version" ]; then printf "v24.0.0\\n"; fi'
  );
  for (const command of ["npm", "tmux", "claude"]) writeExecutable(command, "exit 0");
  writeExecutable(
    "codex",
    'printf "CALL\\0" >> "$RAIL_INSTALL_CAPTURE"; printf "%s\\0" "$@" >> "$RAIL_INSTALL_CAPTURE"; printf "END\\0" >> "$RAIL_INSTALL_CAPTURE"'
  );

  const expectedNode = path.join(fakeBin, "node");
  const expectedClaude = path.join(fakeBin, "claude");
  const expectedTmux = path.join(fakeBin, "tmux");
  const expectedEntrypoint = path.join(installRoot, "src", "index.js");
  const expectedBase = [
    "mcp",
    "add",
    "rail-connector",
    "--env",
    `RAIL_CONNECTOR_CLAUDE_PATH=${expectedClaude}`,
    "--env",
    `RAIL_CONNECTOR_TMUX_PATH=${expectedTmux}`,
  ];

  const disabled = runInstaller("Disabled");
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(capturedCalls(), [
    [...expectedBase, "--", expectedNode, expectedEntrypoint],
    ["mcp", "get", "rail-connector"],
  ]);

  const localHost = runInstaller("LocalHost");
  assert.equal(localHost.status, 0, localHost.stderr);
  assert.deepEqual(capturedCalls()[0], [
    ...expectedBase,
    "--env",
    "RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS=I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS",
    "--",
    expectedNode,
    expectedEntrypoint,
  ]);

  const isolated = runInstaller("Isolated");
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.deepEqual(capturedCalls()[0], [
    ...expectedBase,
    "--env",
    "RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS=I_UNDERSTAND_THIS_REQUIRES_ISOLATION",
    "--",
    expectedNode,
    expectedEntrypoint,
  ]);

  const rooted = runInstaller("localhost", ["--allowed-root", allowedRoot]);
  assert.equal(rooted.status, 0, rooted.stderr);
  assert.deepEqual(capturedCalls()[0], [
    ...expectedBase,
    "--env",
    "RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS=I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS",
    "--env",
    `RAIL_CONNECTOR_ALLOWED_ROOTS=${fs.realpathSync(allowedRoot)}`,
    "--",
    expectedNode,
    expectedEntrypoint,
  ]);

  const missingRoot = runInstaller("Disabled", ["--allowed-root", path.join(tempRoot, "missing")]);
  assert.notEqual(missingRoot.status, 0);
  assert.match(missingRoot.stderr, /Allowed root is not an existing directory/);

  const invalid = runInstaller("yes");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid bypass policy/);
  assert.deepEqual(capturedCalls(), []);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("install-unix ok");
