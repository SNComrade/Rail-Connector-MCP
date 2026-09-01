import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(root, ".agents", "skills");
const expectedSkills = [
  "rail-debugger",
  "rail-operator",
  "rail-reviewer",
];
const staleGuidance = [
  /managed Windows sessions live inside the MCP process/i,
  /use bypass only in a disposable isolated/i,
  /do not combine report-only review posture with Ultracode/i,
  /claude_session_log_correlated_with_resolved_launch/i,
];

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function frontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(match, "SKILL.md must begin with YAML frontmatter");
  const name = match[1].match(/^name:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n]+))$/m);
  const description = match[1].match(
    /^description:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n]+))$/m
  );
  assert.ok(name, "frontmatter must contain name");
  assert.ok(description, "frontmatter must contain description");
  return {
    name: (name[1] ?? name[2] ?? name[3]).trim(),
    description: (description[1] ?? description[2] ?? description[3]).trim(),
  };
}

for (const skill of expectedSkills) {
  const skillDir = path.join(skillsRoot, skill);
  const skillFile = path.join(skillDir, "SKILL.md");
  const openaiFile = path.join(skillDir, "agents", "openai.yaml");
  assert.ok(fs.statSync(skillDir).isDirectory(), `${skill} directory must exist`);
  assert.ok(fs.existsSync(skillFile), `${skill}/SKILL.md must exist`);
  assert.ok(fs.existsSync(openaiFile), `${skill}/agents/openai.yaml must exist`);

  const markdown = read(skillFile);
  const metadata = frontmatter(markdown);
  assert.equal(metadata.name, skill, `${skill} frontmatter name must match directory`);
  assert.ok(metadata.description.length >= 40, `${skill} description must be actionable`);
  assert.ok(metadata.description.length <= 1024, `${skill} description must remain concise`);
  assert.ok(markdown.split(/\r?\n/).length < 500, `${skill}/SKILL.md must stay below 500 lines`);

  const openai = read(openaiFile);
  assert.match(openai, /^interface:\s*$/m, `${skill} must define interface metadata`);
  assert.match(openai, /^\s+display_name:\s*"[^"]+"\s*$/m);
  assert.match(openai, /^\s+short_description:\s*"[^"]{25,64}"\s*$/m);
  assert.match(
    openai,
    new RegExp(
      `^\\s+default_prompt:\\s*"[^"]*\\\\?\\$${skill.replaceAll("-", "\\-")}[^"]*"\\s*$`,
      "m"
    )
  );

  for (const link of markdown.matchAll(/\]\((references\/[^)#]+)\)/g)) {
    assert.ok(
      fs.existsSync(path.join(skillDir, ...link[1].split("/"))),
      `${skill} reference does not exist: ${link[1]}`
    );
  }

  const allMarkdown = [skillFile];
  const references = path.join(skillDir, "references");
  if (fs.existsSync(references)) {
    for (const entry of fs.readdirSync(references, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        allMarkdown.push(path.join(references, entry.name));
      }
    }
  }
  const combined = allMarkdown.map(read).join("\n");
  for (const pattern of staleGuidance) {
    assert.doesNotMatch(combined, pattern, `${skill} contains stale guidance: ${pattern}`);
  }
  assert.match(combined, /Remote Control web/i, `${skill} must explain the web UI evidence scope`);
  assert.match(combined, /session-bound web `?Extra`?/i, `${skill} must distinguish the web Extra label`);
  assert.match(combined, /\/effort ultracode/i, `${skill} must teach explicit current-setting readback`);
  assert.match(combined, /substantive\s+(?:turn|prompt)/i, `${skill} must reject trivial workflow validation`);
  assert.match(combined, /awaiting_input/i, `${skill} must preserve protected composer drafts`);
  assert.match(combined, /workflowPending/i, `${skill} must honor structured pending-workflow state`);
  assert.match(combined, /workflow_pending/i, `${skill} must document the pending-workflow block reason`);
  assert.match(combined, /terminalState/, `${skill} must separate terminal and workflow state`);
  assert.match(combined, /launchEnvironment/, `${skill} must preserve child launch provenance`);
  assert.match(combined, /currentMcpEnvironment/, `${skill} must separate refreshed MCP diagnostics`);
  assert.match(combined, /timeout|termination/i, `${skill} must treat incomplete probes cautiously`);
  assert.match(combined, /get_claude_result/, `${skill} must recover truncated results`);
  assert.match(combined, /textSha256/, `${skill} must verify large-result integrity`);
  assert.match(
    combined,
    /MCP and connector tools can remain available|built-in tool flags do not remove MCP\s+or connector tools/i,
    `${skill} must distinguish built-in and connector tool filtering`
  );
  assert.match(
    combined,
    /helpListsUltracode/,
    `${skill} must explain the UltraCode help-advertisement field`
  );
  assert.match(
    combined,
    /ultraEffortAttachment\.active/,
    `${skill} must interpret the UltraCode attachment lifecycle`
  );
}

const actualSkills = fs
  .readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsRoot, entry.name, "SKILL.md")))
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(actualSkills, expectedSkills, "active repo skill inventory must be intentional");

const operatorGuidance = [
  path.join(skillsRoot, "rail-operator", "SKILL.md"),
  path.join(
    skillsRoot,
    "rail-operator",
    "references",
    "operator-playbook.md"
  ),
]
  .map(read)
  .join("\n");
assert.match(operatorGuidance, /xhigh_correlated_unconfirmed/);
assert.match(operatorGuidance, /claude-fable-5/);
assert.match(operatorGuidance, /claude-opus-5/);
assert.match(operatorGuidance, /conflicting_effort_evidence/);
assert.match(operatorGuidance, /effort other than `xhigh` or `ultracode`/i);
assert.match(operatorGuidance, /Rename `force` bypasses only/i);
assert.match(operatorGuidance, /workflowObservationUncertain/);
assert.match(operatorGuidance, /disallowedTools/);
assert.match(operatorGuidance, /operating-system sandbox/i);
assert.match(operatorGuidance, /created by this\s+workflow/i);
assert.match(operatorGuidance, /operator_asserted/);
assert.match(operatorGuidance, /debugLog\.status/);
assert.match(operatorGuidance, /windowsAclVerified/);

const debuggerGuidance = read(
  path.join(
    skillsRoot,
    "rail-debugger",
    "references",
    "debugging-playbook.md"
  )
);
assert.match(debuggerGuidance, /CLAUDE_CODE_EFFORT_LEVEL/);
assert.match(debuggerGuidance, /workflow trigger\s+unknown/i);
assert.match(debuggerGuidance, /effort other than `xhigh` or `ultracode`/i);
assert.match(debuggerGuidance, /workflowObservationCoverage/);
assert.match(debuggerGuidance, /workflowObservationUncertain/);
assert.match(debuggerGuidance, /tmux 3\.2 or newer/i);
assert.match(debuggerGuidance, /debugLog\.status/);
assert.match(
  read(path.join(skillsRoot, "rail-debugger", "SKILL.md")),
  /report-only requests as non-mutating/i
);

const reviewerGuidance = [
  path.join(skillsRoot, "rail-reviewer", "SKILL.md"),
  path.join(
    skillsRoot,
    "rail-reviewer",
    "references",
    "review-prompt.md"
  ),
]
  .map(read)
  .join("\n");
assert.match(reviewerGuidance, /at most 3 workflow agents/i);
assert.match(reviewerGuidance, /no recursive delegation/i);
assert.match(reviewerGuidance, /5 findings/i);
assert.match(reviewerGuidance, /10 minutes/i);
assert.match(reviewerGuidance, /200k aggregate tokens/i);
assert.match(reviewerGuidance, /workflowObservationUncertain/);
assert.match(reviewerGuidance, /disallowedTools/);
assert.match(reviewerGuidance, /pre\/post repository evidence/i);
assert.match(reviewerGuidance, /created by this workflow/i);

const installGuidePath = [
  path.join(root, "docs", "SKILL_INSTALL_PRIVATE.md"),
  path.join(root, "docs", "SKILL_INSTALL.md"),
].find((candidate) => fs.existsSync(candidate));
assert.ok(installGuidePath, "a private or public skill install guide must exist");
const installGuide = read(installGuidePath);
for (const skill of expectedSkills) {
  assert.match(
    installGuide,
    new RegExp(`\\.agents/skills/${skill}`),
    `skill install guide must include ${skill}`
  );
}
assert.match(installGuide, /MCP\s+registration and skill installation/i);
assert.match(installGuide, /fresh Codex task/i);
assert.match(installGuide, /does not update automatically/i);
assert.match(installGuide, /\$skill-installer/);
assert.match(installGuide, /immutable tagged GitHub directory/i);
assert.match(installGuide, /v\d+\.\d+\.\d+-beta\.\d+/);
assert.ok(installGuide.includes("/tree/main/"));

console.log(`skills ok (${expectedSkills.length})`);
