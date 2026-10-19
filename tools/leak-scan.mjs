#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const ignoredDirectories = new Set([".git", "node_modules"]);
const ignoredFiles = new Set([".rail-export-state.json"]);
const blockedArtifactExtensions = new Set([".tgz", ".zip", ".7z", ".rar", ".jsonl"]);
export const allowedUuids = new Set([
  "00000000-0000-0000-0000-000000000000",
  "00000000-0000-4000-8000-000000000000",
  "11111111-1111-1111-1111-111111111111",
  "11111111-1111-4111-8111-111111111111",
  "12121212-1212-4121-8121-121212121212",
  "12121212-1212-4212-8212-121212121212",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "34343434-3434-4343-8343-343434343434",
  "44444444-4444-4444-8444-444444444444",
  "45454545-4545-4454-8454-454545454545",
  "55555555-5555-4555-8555-555555555555",
  "56565656-5656-4656-8656-565656565656",
  "66666666-6666-4666-8666-666666666661",
  "66666666-6666-4666-8666-666666666662",
  "66666666-6666-4666-8666-666666666663",
  "67676767-6767-4676-8676-676767676767",
  "77777777-7777-4777-8777-777777777777",
  "78787878-7878-4787-8787-787878787878",
  "88888888-8888-4888-8888-888888888888",
  "89898989-8989-4898-8989-898989898989",
  "90909090-9090-4909-8909-909090909090",
  "90909090-9090-4090-8090-909090909090",
  "90909091-9090-4909-8990-909090909091",
  "91919191-9191-4919-8919-919191919191",
  "91919191-9191-4919-8991-919191919191",
  "92929292-9292-4929-8929-929292929292",
  "92929292-9292-4929-8992-929292929292",
  "93939393-9393-4939-8939-939393939393",
  "93939393-9393-4939-8993-939393939393",
  "94949494-9494-4949-8949-949494949494",
  "94949494-9494-4949-8994-949494949494",
  "95959595-9595-4959-8959-959595959595",
  "96969696-9696-4969-8969-969696969696",
  "96969696-9696-4696-8696-969696969696",
  "97979797-9797-4979-8979-979797979797",
  "97979797-9797-4797-8797-979797979797",
  "98989898-9898-4898-8898-989898989898",
  "99999999-9999-4999-8999-999999999999",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1",
  "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2",
  "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
]);
export const allowedRemoteIds = new Set([
  "fake_tui",
  "fork_binding_test",
  "session_abc123",
  "session_current",
  "session_old",
  "session_sensitive",
  "session_test",
  "session_tmux_integration",
]);

export function isDirectExecution(entryPath = process.argv[1], modulePath = scriptPath) {
  if (!entryPath) return false;
  return fs.realpathSync.native(path.resolve(entryPath)) === fs.realpathSync.native(path.resolve(modulePath));
}

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

// Stop at the username component so an allowed child path cannot swallow a
// later Windows profile prefix in the same whitespace-delimited token.
const windowsUserPath = /[A-Za-z]:\\+(?!\\)Users\\+[^\\\s`"']+/gi;

const sourceIdentifier = "[A-Za-z_$][\\w$]*";
const sourcePlaceholder = "\0";
const sourceDeclaration = `(?:const|let|var)\\s+${sourceIdentifier}\\s*=\\s*`;
const sourceMember = `${sourcePlaceholder}(?:\\.${sourceIdentifier})*(?:\\s+/\\s+\\d+(?:\\.\\d+)?)?`;
const sourceValue = `(?:${sourceMember}|\\[\\s*${sourcePlaceholder}\\s*\\]|\\{\\s*${sourceIdentifier}\\s*:\\s*${sourcePlaceholder}\\s*\\}|${sourceIdentifier}\\s*\\?\\s*${sourcePlaceholder}\\s*:\\s*${sourceIdentifier})`;
const sourceLiteral = `(?:"(?:[^"\\\\\\r\\n]|\\\\[^\\r\\n])*"|'(?:[^'\\\\\\r\\n]|\\\\[^\\r\\n])*')`;
const sourceLaterDeclaration = `(?:\\s*${sourceDeclaration}${sourceLiteral};)?`;
const sourceComment = String.raw`(?:\s+(?://[^\r\n]*|/\*(?:[^*\r\n]|\*(?!/))*\*/))?`;
const windowsPlaceholderSourceUnit = new RegExp(
  `^(?:${sourceDeclaration}${sourceValue}|${sourceIdentifier}\\(\\s*${sourcePlaceholder}\\s*(?:,\\s*${sourceIdentifier}\\s*)?\\));${sourceLaterDeclaration}${sourceComment}\\s*$`
);

function hasCompleteWindowsPlaceholderSourceUnit(text, frameStart, frameEnd) {
  const lineStart = text.lastIndexOf("\n", frameStart - 1) + 1;
  const nextLine = text.indexOf("\n", frameEnd);
  const lineEnd = nextLine < 0 ? text.length : nextLine;
  if (lineEnd - lineStart > 4096) return false;
  // Bind the grammar's value slot to this exact span, never source-controlled
  // lookalike syntax elsewhere in a comment or an independent literal.
  if (text.slice(lineStart, lineEnd).includes(sourcePlaceholder)) return false;
  const unit = `${text.slice(lineStart, frameStart)}${sourcePlaceholder}${text.slice(frameEnd, lineEnd)}`.trim();
  return windowsPlaceholderSourceUnit.test(unit);
}

function isExactWindowsPlaceholder(text, index, match) {
  const profile = match.replace(/^[A-Za-z]:\\+Users\\+/i, "");
  const placeholder = /^(?:you|<you>)/i.exec(profile);
  if (!placeholder) return false;
  const remainder = profile.slice(placeholder[0].length);
  if (remainder) return false;

  const next = text[index + match.length];
  if (next === undefined || /\s/.test(next) || next === '"' || next === "\\") return true;
  if ((next === "'" || next === "`") && text[index - 1] === next) {
    let frameLength = 1;
    if (next === "`") {
      while (text[index - frameLength - 1] === next) frameLength += 1;
      let closingLength = 1;
      while (text[index + match.length + closingLength] === next) closingLength += 1;
      if (closingLength !== frameLength) return false;
    }
    const frameEnd = index + match.length + frameLength;
    const afterClosingFrame = text[frameEnd];
    if (afterClosingFrame !== undefined && !/[\s;,:\)\]}."]/.test(afterClosingFrame)) return false;
    // A suffix can disclose a username even without a child separator. Admit
    // nonempty contiguous source syntax only as one complete supported unit.
    if (afterClosingFrame !== undefined && !/[\s"]/.test(afterClosingFrame) &&
        !hasCompleteWindowsPlaceholderSourceUnit(text, index - frameLength, frameEnd)) return false;
    for (let cursor = frameEnd; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (/[\s'"`]/.test(character)) break;
      if (character === "\\" || character === "/") return false;
    }
    return true;
  }
  return false;
}

function hasNonPlaceholderWindowsUserPath(text) {
  windowsUserPath.lastIndex = 0;
  for (const match of text.matchAll(windowsUserPath)) {
    if (!isExactWindowsPlaceholder(text, match.index, match[0])) return true;
  }
  return false;
}

const unixUserRoot = "/home/";
const macUserRoot = "/Users/";

// POSIX classification reuses the unchanged bounded source-unit grammar above.
function hasExactPosixClosingFrame(text, index, end) {
  const next = text[end];
  if (![String.fromCharCode(39), String.fromCharCode(34), String.fromCharCode(96)].includes(next) ||
      text[index - 1] !== next) return false;
  let frameLength = 1;
  if (next.charCodeAt(0) === 96) {
    while (text[index - frameLength - 1] === next) frameLength += 1;
    let closingLength = 1;
    while (text[end + closingLength] === next) closingLength += 1;
    if (closingLength !== frameLength) return false;
  }
  const frameEnd = end + frameLength;
  const after = text[frameEnd];
  if (after === undefined || /\s/.test(after)) return true;
  if (!hasCompleteWindowsPlaceholderSourceUnit(text, index - frameLength, frameEnd)) return false;
  for (let cursor = frameEnd; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (/[\s'"\x60]/.test(character)) break;
    if (character === '/' || character === '\\') return false;
  }
  return true;
}
function isAllowedPosixUserComponent(text, index, usernameStart) {
  const placeholder = /^(?:you|<you>)/.exec(text.slice(usernameStart));
  // An empty component is exempt only when this exact root directory has a
  // matching adjacent closing frame; arbitrary quote-start usernames refuse.
  if (!placeholder) return hasExactPosixClosingFrame(text, index, usernameStart);
  const end = usernameStart + placeholder[0].length;
  const next = text[end];
  if (next === undefined || next === '/' || /\s/.test(next)) return true;
  return hasExactPosixClosingFrame(text, index, end);
}
function hasNonPlaceholderPosixUserPath(text, prefix) {
  // Include quote characters in the component inventory. They are valid POSIX
  // filename bytes and cannot unconditionally end the placeholder exemption.
  const pattern = prefix === '/home/' ? /\/home\/+[^\s/]+/g : /\/Users\/+[^\s/]+/g;
  for (const match of text.matchAll(pattern)) {
    let usernameStart = match.index + prefix.length;
    while (text[usernameStart] === '/') usernameStart += 1;
    // Preserve username offsets; framing begins at the complete leading slash run.
    let profileStart = match.index;
    while (profileStart > 0 && text[profileStart - 1] === '/') profileStart -= 1;
    if (!isAllowedPosixUserComponent(text, profileStart, usernameStart)) return true;
  }
  return false;
}

export function inspectPrivacyText(file, text, findings) {
  const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const remotePattern = /https:\/\/claude\.ai\/code\/([A-Za-z0-9_:-]+)/g;
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
  if (hasNonPlaceholderWindowsUserPath(text)) findings.push(`${file}: local Windows user path`);
  if (hasNonPlaceholderPosixUserPath(text, unixUserRoot)) findings.push(file + ": local Unix user path");
  if (hasNonPlaceholderPosixUserPath(text, macUserRoot)) findings.push(file + ": local macOS user path");
  for (const [pattern, label] of [
    [emailPattern, "email address"],
  ]) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${file}: ${label}`);
  }
}

if (isDirectExecution()) {
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
      inspectPrivacyText(file, fs.readFileSync(source, "utf8"), findings);
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
      inspectPrivacyText(`npm:${file}`, fs.readFileSync(source, "utf8"), findings);
    }
  }

  if (findings.length) {
    console.error([...new Set(findings)].join("\n"));
    process.exit(1);
  }

  console.log(`privacy scan ok (${files.size} files, ${packed.size} packaged files)`);
}
