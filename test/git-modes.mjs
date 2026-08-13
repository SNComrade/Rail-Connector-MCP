import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const executableFiles = ["install.sh", "src/index.js", "tools/leak-scan.mjs"];
const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
  cwd: repoRoot,
  stdio: "ignore",
});

if (head.status !== 0) {
  console.log("git-modes skipped (unborn public candidate; enforce at first commit)");
  process.exit(0);
}

const output = execFileSync("git", ["ls-files", "--stage", "--", ...executableFiles], {
  cwd: repoRoot,
  encoding: "utf8",
});
const modes = new Map();
for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
  const match = /^(\d{6}) [0-9a-f]+ \d+\t(.+)$/.exec(line);
  assert.ok(match, `unexpected git index row: ${line}`);
  modes.set(match[2].replaceAll("\\", "/"), match[1]);
}
for (const file of executableFiles) {
  assert.equal(modes.get(file), "100755", `${file} must be committed as 100755`);
}

console.log("git-modes ok (3 executable files)");
