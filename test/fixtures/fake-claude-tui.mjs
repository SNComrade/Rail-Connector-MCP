import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);

function effortOverrideStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "unset";
  return normalized === "xhigh" ? "compatible_xhigh" : "other";
}

function recordInvocation() {
  const directory =
    process.env.RAIL_FAKE_CLAUDE_ARGV_DIR ||
    (process.env.CLAUDE_CONFIG_DIR
      ? path.join(process.env.CLAUDE_CONFIG_DIR, "test-argv-records")
      : "");
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  const record = {
    argv,
    cwd: process.cwd(),
    environment: {
      effortOverrideStatus: effortOverrideStatus(
        process.env.CLAUDE_CODE_EFFORT_LEVEL
      ),
      workflowsDisabled:
        process.env.CLAUDE_CODE_DISABLE_WORKFLOWS === "1",
      forceColor: process.env.FORCE_COLOR === "1" ? "enabled" : "other",
    },
  };
  fs.writeFileSync(
    path.join(directory, `${Date.now()}-${process.pid}-${randomUUID()}.json`),
    `${JSON.stringify(record)}\n`,
    { flag: "wx" }
  );
}

function argumentValue(flag) {
  const direct = argv.find((value) => value.startsWith(`${flag}=`));
  if (direct) return direct.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] ?? "" : "";
}

function writeSessionBridgeRecord() {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const sessionId = argumentValue("--session-id");
  if (!configDir || !/^[0-9a-f-]{36}$/i.test(sessionId)) return;
  const encodedCwd = process.cwd().replace(/[^A-Za-z0-9]/g, "-");
  const projectDir = path.join(configDir, "projects", encodedCwd);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.appendFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    `${JSON.stringify({
      type: "system",
      subtype: "bridge_status",
      sessionId,
      timestamp: new Date().toISOString(),
      url: "https://claude.ai/code/fake_tui",
    })}\n`
  );
}

recordInvocation();

if (argv.includes("--effort=rail-invalid-probe")) {
  process.stderr.write("fixture rejected the requested effort selection\n");
  process.exit(64);
}

if (argv.includes("--help")) {
  process.stdout.write(
    [
      "Options:",
      "  --effort <level> low, medium, high, xhigh, max, ultracode",
      "  --permission-mode <mode> default, manual, plan, acceptEdits, auto, dontAsk, bypassPermissions",
      "  --settings <file-or-json>",
      "  --remote-control",
      "",
    ].join("\n")
  );
  process.exit(0);
}

if (argv.includes("--version")) {
  process.stdout.write("2.1.234 (Claude Code)\n");
  process.exit(0);
}

writeSessionBridgeRecord();
process.stdin.setEncoding("utf8");
if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);

let input = "";
process.stdout.write(
  "\x1b[>0q\x1b[?2004hFake Claude TUI\r\nhttps://claude.ai/code/fake_tui\r\n> "
);

process.stdin.on("data", (chunk) => {
  input += chunk.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
  for (;;) {
    const submit = input.search(/[\r\n]/);
    if (submit < 0) break;
    const command = input.slice(0, submit).trim();
    input = input.slice(submit + 1);
    if (command === "/exit") {
      if (process.env.RAIL_CONNECTOR_FAKE_CLAUDE_IGNORE_EXIT === "1") {
        process.stdout.write("\r\nIGNORED_EXIT\r\n> ");
        continue;
      }
      process.stdout.write("\r\nGoodbye\r\n");
      process.exit(0);
    }
    if (command === "/workflow-test") {
      process.stdout.write(
        "\r\n\u2722 Waiting for 1 dynamic workflow to finish\r\n> "
      );
      continue;
    }
    if (command === "/workflow-clear") {
      process.stdout.write("\r\n\u273b Worked for 2s\r\n> ");
      continue;
    }
    process.stdout.write(`\r\nACK:${command}\r\n> `);
  }
});
