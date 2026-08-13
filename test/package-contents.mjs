import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "npm_execpath is required; run this check through npm");
const result = JSON.parse(
  execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
);
const files = new Set(result[0].files.map((entry) => entry.path.replaceAll("\\", "/")));
const expectedFiles = new Set([
  ".agents/skills/rail-debugger/agents/openai.yaml",
  ".agents/skills/rail-debugger/references/debugging-playbook.md",
  ".agents/skills/rail-debugger/SKILL.md",
  ".agents/skills/rail-operator/agents/openai.yaml",
  ".agents/skills/rail-operator/references/operator-playbook.md",
  ".agents/skills/rail-operator/SKILL.md",
  ".agents/skills/rail-reviewer/agents/openai.yaml",
  ".agents/skills/rail-reviewer/references/review-prompt.md",
  ".agents/skills/rail-reviewer/SKILL.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "COMPATIBILITY.md",
  "CONTRIBUTING.md",
  "docs/GITHUB_SETUP.md",
  "docs/INSTALL.md",
  "docs/LINUX.md",
  "docs/MACOS.md",
  "docs/RELEASE_PROCESS.md",
  "docs/SECURITY_MODEL.md",
  "docs/SKILL_INSTALL.md",
  "docs/SKILLS_LINUX.md",
  "docs/SKILLS_WINDOWS.md",
  "docs/SKILLS.md",
  "docs/TASK_GUIDE.md",
  "docs/TROUBLESHOOTING.md",
  "docs/USAGE.md",
  "docs/WINDOWS.md",
  "GOVERNANCE.md",
  "LICENSE",
  "NOTICE",
  "package.json",
  "README.md",
  "SECURITY.md",
  "src/index.js",
  "src/terminal.js",
  "src/windows-broker-client.js",
  "src/windows-broker.js",
  "SUPPORT.md",
  "THIRD-PARTY-NOTICES.md",
]);

assert.deepEqual(
  [...files].sort(),
  [...expectedFiles].sort(),
  `npm package contents differ from the reviewed ${expectedFiles.size}-file manifest`
);

for (const excluded of [
  "install.sh",
  "install-windows.ps1",
  "package-lock.json",
  "provenance.json",
  ".rail-export-state.json",
]) {
  assert.equal(files.has(excluded), false, `runtime package unexpectedly contains ${excluded}`);
}
for (const file of files) {
  assert.equal(file.startsWith("test/"), false, `package unexpectedly contains ${file}`);
  assert.equal(file.startsWith(".github/"), false, `package unexpectedly contains ${file}`);
}

const markdownFiles = [...files].filter((file) => file.endsWith(".md") || file === "NOTICE");
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
for (const file of markdownFiles) {
  const text = fs.readFileSync(path.join(repoRoot, ...file.split("/")), "utf8");
  for (const match of text.matchAll(linkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    if (/^(?:[a-z]+:|#)/i.test(rawTarget)) continue;
    const withoutFragment = rawTarget.split(/[?#]/, 1)[0];
    if (!withoutFragment) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), withoutFragment));
    assert.equal(files.has(target), true, `${file} links to unpackaged ${target}`);
  }
}

console.log(`package-contents ok (${files.size} files, relative links closed)`);
