#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", "node_modules"]);
const ignoredFiles = new Set([".rail-export-state.json"]);
const blockedArtifactExtensions = new Set([".tgz", ".zip", ".7z", ".rar", ".jsonl"]);
const allowedUuids = new Set([
  "00000000-0000-0000-0000-000000000000",
  "00000000-0000-4000-8000-000000000000",
  "11111111-1111-1111-1111-111111111111",
  "11111111-1111-4111-8111-111111111111",
  "12121212-1212-4121-8121-121212121212",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "34343434-3434-4343-8343-343434343434",
  "44444444-4444-4444-8444-444444444444",
  "45454545-4545-4454-8454-454545454545",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666661",
  "66666666-6666-4666-8666-666666666662",
  "66666666-6666-4666-8666-666666666663",
  "88888888-8888-4888-8888-888888888888",
  "99999999-9999-4999-8999-999999999999",
]);
const allowedRemoteIds = new Set([
  "fake_tui",
  "fork_binding_test",
  "session_abc123",
  "session_current",
  "session_old",
  "session_sensitive",
  "session_test",
  "session_tmux_integration",
]);
function walk(directory, relative = "") {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(child, childRelative));
    else if (!ignoredFiles.has(childRelative)) result.push(childRelative);
  }
  return result;
}

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/"));
}

function packageFiles() {
  const npmCli = process.env.npm_execpath;
  let output;
  if (npmCli) {
    output = execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
    });
  } else if (process.platform === "win32") {
    output = execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd pack --dry-run --json"], {
      cwd: root,
      encoding: "utf8",
    });
  } else {
    output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
  }
  const result = JSON.parse(output);
  return result[0].files.map((entry) => entry.path.replaceAll("\\", "/"));
}

function inspect(file, text, findings) {
  const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const remotePattern = /https:\/\/claude\.ai\/code\/([A-Za-z0-9_:-]+)/g;
  const windowsUserPath = /\b[A-Za-z]:\\Users\\(?!<you>(?:\\|\b)|you(?:\\|\b))[^\s`"']+/gi;
  const unixUserPath = /\/home\/(?!<you>(?:\/|\b)|you(?:\/|\b))[^\s`"']+/g;
  const macUserPath = /\/Users\/(?!<you>(?:\/|\b)|you(?:\/|\b))[^\s`"']+/g;
  const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const privateKeyPattern = new RegExp("-----" + "BEGIN [A-Z ]*PRIVATE KEY-----", "g");
  const secretPatterns = [
    privateKeyPattern,
    /\bsk-ant-[A-Za-z0-9_-]+/g,
    /\bsk-proj-[A-Za-z0-9_-]+/g,
    /\bghp_[A-Za-z0-9]+/g,
    /\bgithub_pat_[A-Za-z0-9_]+/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]+/g,
    /\bglpat-[A-Za-z0-9_-]+/g,
  ];

  for (const match of text.matchAll(uuidPattern)) {
    if (!allowedUuids.has(match[0].toLowerCase())) findings.push(`${file}: non-synthetic UUID`);
  }
  for (const match of text.matchAll(remotePattern)) {
    if (!allowedRemoteIds.has(match[1])) findings.push(`${file}: non-synthetic Remote Control URL`);
  }
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${file}: secret-like content`);
  }
  for (const [pattern, label] of [
    [windowsUserPath, "local Windows user path"],
    [unixUserPath, "local Unix user path"],
    [macUserPath, "local macOS user path"],
    [emailPattern, "email address"],
  ]) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${file}: ${label}`);
  }
}

const findings = [];
const files = new Set([...walk(root), ...trackedFiles()]);
for (const file of files) {
  if (ignoredFiles.has(file)) continue;
  if (blockedArtifactExtensions.has(path.extname(file).toLowerCase())) {
    findings.push(`${file}: generated archive or session artifact`);
    continue;
  }
  const source = path.join(root, ...file.split("/"));
  if (fs.existsSync(source) && fs.statSync(source).isFile()) {
    inspect(file, fs.readFileSync(source, "utf8"), findings);
  }
}

const packed = new Set(packageFiles());
for (const file of packed) {
  if (
    file.startsWith("test/") ||
    file.startsWith(".github/") ||
    ["install.sh", "install-windows.ps1", "provenance.json", ".rail-export-state.json"].includes(file)
  ) {
    findings.push(`npm package unexpectedly contains ${file}`);
  }
  const source = path.join(root, ...file.split("/"));
  if (fs.existsSync(source) && fs.statSync(source).isFile()) {
    inspect(`npm:${file}`, fs.readFileSync(source, "utf8"), findings);
  }
}

if (findings.length) {
  console.error([...new Set(findings)].join("\n"));
  process.exit(1);
}

console.log(`privacy scan ok (${files.size} files, ${packed.size} packaged files)`);
