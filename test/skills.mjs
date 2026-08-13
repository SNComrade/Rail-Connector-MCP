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
}

const actualSkills = fs
  .readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(skillsRoot, entry.name, "SKILL.md")))
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(actualSkills, expectedSkills, "active repo skill inventory must be intentional");

console.log(`skills ok (${expectedSkills.length})`);
