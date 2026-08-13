import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveTmuxCommand, SERVER_VERSION } from "../src/index.js";
import {
  WINDOWS_BROKER_VERSION,
  railConnectorStateDir,
} from "../src/windows-broker-client.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const lockText = fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8");
const lock = JSON.parse(lockText);

assert.equal(packageJson.private, true);
assert.equal(packageJson.engines.node, "^22.0.0 || ^24.0.0 || ^26.0.0");
assert.equal(SERVER_VERSION, packageJson.version);
assert.match(WINDOWS_BROKER_VERSION, new RegExp(`^${packageJson.version.replaceAll(".", "\\.")}\\+broker\\.\\d+$`));
assert.equal(typeof railConnectorStateDir, "function");
const priorTmuxPath = process.env.RAIL_CONNECTOR_TMUX_PATH;
process.env.RAIL_CONNECTOR_TMUX_PATH = process.execPath;
try {
  const resolvedTmux = resolveTmuxCommand();
  assert.equal(
    process.platform === "win32" ? resolvedTmux.toLowerCase() : resolvedTmux,
    process.platform === "win32" ? path.resolve(process.execPath).toLowerCase() : path.resolve(process.execPath)
  );
} finally {
  if (priorTmuxPath === undefined) delete process.env.RAIL_CONNECTOR_TMUX_PATH;
  else process.env.RAIL_CONNECTOR_TMUX_PATH = priorTmuxPath;
}
assert.equal(lock.name, packageJson.name);
assert.equal(lock.version, packageJson.version);
assert.equal(lock.packages[""].name, packageJson.name);
assert.equal(lock.packages[""].version, packageJson.version);
assert.deepEqual(lock.packages[""].bin, packageJson.bin);
assert.deepEqual(lock.packages[""].engines, packageJson.engines);
assert.equal(lock.packages["node_modules/@hono/node-server"].engines.node, ">=20");
assert.equal(
  (lockText.match(/"rail-connector-mcp": "src\/index\.js"/g) ?? []).length,
  1,
  "package lock must contain one public bin entry"
);

const sourceText = ["src/index.js", "src/windows-broker-client.js", "src/windows-broker.js"]
  .map((file) => fs.readFileSync(path.join(repoRoot, file), "utf8"))
  .join("\n");
assert.doesNotMatch(sourceText, /\b1\.2\.0\b|agility\.8/);

for (const file of [
  ".agents/skills/rail-operator/SKILL.md",
  ".agents/skills/rail-debugger/SKILL.md",
  ".agents/skills/rail-reviewer/SKILL.md",
  ".agents/skills/rail-operator/agents/openai.yaml",
  ".agents/skills/rail-debugger/agents/openai.yaml",
  ".agents/skills/rail-reviewer/agents/openai.yaml",
  "docs/SKILLS_LINUX.md",
  "src/index.js",
  "src/windows-broker-client.js",
]) {
  const text = fs.readFileSync(path.join(repoRoot, ...file.split("/")), "utf8")
    .replaceAll("Claude Code Remote Control", "");
  assert.doesNotMatch(text, /Claude Remote/, `${file} contains stale product branding`);
}

for (const file of ["README.md", "COMPATIBILITY.md", "docs/INSTALL.md", "docs/LINUX.md", "docs/MACOS.md", "docs/WINDOWS.md"]) {
  const text = fs.readFileSync(path.join(repoRoot, ...file.split("/")), "utf8");
  assert.doesNotMatch(text, /Node(?:\.js)? (?:must be version )?20\b/i, `${file} advertises Node 20`);
}

const unixInstaller = fs.readFileSync(path.join(repoRoot, "install.sh"), "utf8");
const windowsInstaller = fs.readFileSync(path.join(repoRoot, "install-windows.ps1"), "utf8");
const windowsDocs = fs.readFileSync(path.join(repoRoot, "docs", "WINDOWS.md"), "utf8");
const gitAttributes = fs.readFileSync(path.join(repoRoot, ".gitattributes"), "utf8");
assert.match(unixInstaller, /22\|24\|26/);
assert.match(windowsInstaller, /\$nodeMajor -notin @\(22, 24, 26\)/);
for (const variable of ["RAIL_CONNECTOR_CLAUDE_PATH", "RAIL_CONNECTOR_ALLOWED_ROOTS"]) {
  assert.match(unixInstaller, new RegExp(variable));
  assert.match(windowsInstaller, new RegExp(variable));
}
assert.match(unixInstaller, /RAIL_CONNECTOR_TMUX_PATH/);
assert.ok(
  unixInstaller.includes('for requested_root in ${allowed_roots[@]+"${allowed_roots[@]}"}; do'),
  "Unix installer must use the Bash 3.2-safe empty-array expansion"
);
assert.ok(unixInstaller.includes('main ${@+"$@"}'), "Unix installer must support zero arguments under Bash 3.2 nounset");
assert.match(windowsInstaller, /Get-Command node -CommandType Application, ExternalScript/);
assert.match(windowsInstaller, /Test-Path -LiteralPath \$resolvedCommand\.Path -PathType Leaf/);
assert.ok(windowsDocs.includes("RAIL_CONNECTOR_CLAUDE_PATH = 'C:\\path\\to\\claude.exe'"));
assert.ok(windowsDocs.includes("RAIL_CONNECTOR_ALLOWED_ROOTS = 'C:\\Users\\<you>\\Projects;D:\\Work'"));
assert.doesNotMatch(windowsDocs, /RAIL_CONNECTOR_(?:CLAUDE_PATH|ALLOWED_ROOTS) = "[A-Za-z]:\\/);
assert.match(gitAttributes, /^\* text=auto eol=lf$/m);
for (const file of ["install-windows.ps1", "test/install-windows.ps1"]) {
  assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, ...file.split("/")), "utf8"), /\r\n/, `${file} must use LF`);
}

const directPrivacyEnvironment = { ...process.env };
delete directPrivacyEnvironment.npm_execpath;
const directPrivacy = spawnSync(process.execPath, ["tools/leak-scan.mjs"], {
  cwd: repoRoot,
  encoding: "utf8",
  env: directPrivacyEnvironment,
});
assert.equal(directPrivacy.status, 0, directPrivacy.stderr || directPrivacy.stdout);
assert.match(directPrivacy.stdout, /privacy scan ok/);

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rail-connector-public-metadata-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/index.js"],
  cwd: repoRoot,
  env: {
    ...process.env,
    RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS: "",
    RAIL_CONNECTOR_STATE_DIR: path.join(testRoot, "state"),
    CLAUDE_CONFIG_DIR: path.join(testRoot, "claude-config"),
  },
  stderr: "pipe",
});
const client = new Client({ name: "rail-public-metadata-test", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport, { timeout: 30000 });
try {
  assert.deepEqual(client.getServerVersion(), {
    name: packageJson.name,
    version: packageJson.version,
  });
} finally {
  await client.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}

console.log(`public-metadata ok (${packageJson.version})`);
