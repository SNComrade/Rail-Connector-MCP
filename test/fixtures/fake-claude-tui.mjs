import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { recordFixtureProcess } from "./fixture-process-ledger.mjs";

function recordExitTrace(event, detail = {}) {
  const file = process.env.RAIL_FAKE_CLAUDE_EXIT_TRACE;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...detail })}\n`);
  } catch { /* Optional diagnostics never change fixture exit behavior. */ }
}
if (process.env.RAIL_FAKE_CLAUDE_EXIT_TRACE) {
  recordExitTrace("starting");
  process.on("exit", (code) => recordExitTrace("exit", { code }));
}
await recordFixtureProcess();

const argv = process.argv.slice(2);
recordExitTrace("arguments", { sessionId: argumentValue("--session-id"), probe: argv.includes("--help") || argv.includes("--version") });

function effortOverrideStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "unset";
  return normalized === "xhigh" ? "compatible_xhigh" : "other";
}

function promptSuggestionStatus(value) {
  if (value === undefined || String(value).trim() === "") return "unset";
  if (value === "false") return "disabled";
  if (value === "true") return "enabled";
  return "other";
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
      promptSuggestion: promptSuggestionStatus(
        process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION
      ),
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
  const canonicalCwd =
    fs.realpathSync.native?.(process.cwd()) ?? fs.realpathSync(process.cwd());
  const encodedCwd = canonicalCwd.replace(/[^A-Za-z0-9]/g, "-");
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
      "  --debug [filter]",
      "  --debug-file <path>",
      "",
    ].join("\n")
  );
  process.exit(0);
}

if (argv.includes("--version")) {
  process.stdout.write("2.1.234 (Claude Code)\n");
  process.exit(0);
}

if (process.env.RAIL_FAKE_CLAUDE_EXIT_ON_START === "1") {
  process.stderr.write("fixture exited before Remote Control became ready\n");
  process.exit(23);
}

const debugFile = argumentValue("--debug-file");
if (debugFile) {
  fs.appendFileSync(
    debugFile,
    `${JSON.stringify({ type: "fake_debug", argvCount: argv.length })}\n`
  );
}

writeSessionBridgeRecord();
process.stdin.setEncoding("utf8");
if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);

let input = "";
let pastePending = false;
let wire = "";
let bracketedPasteMode = true;
let disabledAfterKeywordPrefix = false;
let disabledAfterKeywordBody = false;
const disableBracketedPasteAfterKeywordPrefix =
  process.env.RAIL_FAKE_CLAUDE_DISABLE_PASTE_AFTER_KEYWORD_PREFIX === "1";
const disableBracketedPasteAfterKeywordBody =
  process.env.RAIL_FAKE_CLAUDE_DISABLE_PASTE_AFTER_KEYWORD_BODY === "1";
// Node 20 on Windows reads the console in plain raw mode and never sees the
// paste markers, so the windows-broker test uses this unframed trigger there.
const disableBracketedPasteAfterUnframedKeywordBody =
  process.env.RAIL_FAKE_CLAUDE_DISABLE_PASTE_AFTER_UNFRAMED_KEYWORD_BODY === "1";
const wireReceipt = process.env.RAIL_FAKE_CLAUDE_WIRE_RECEIPT || "";
const tuiBanner = process.env.RAIL_FAKE_CLAUDE_BANNER || "Fake Claude TUI";
function recordWire(chunk) {
  if (!wireReceipt) return;
  fs.appendFileSync(wireReceipt, `${JSON.stringify(String(chunk))}\n`, {
    flag: "a",
  });
}
process.stdout.write(
  `\x1b[>0q\x1b[?2004h${tuiBanner}\r\nhttps://claude.ai/code/fake_tui\r\n> `
);
recordExitTrace("ready");

process.stdin.on("data", (chunk) => {
  recordWire(chunk);
  wire += chunk;
  // Model bracketed paste correctly: embedded newlines stay in the composer,
  // while a literal CR/LF submits. Frames may be split across ConPTY reads.
  let commands = [];
  while (wire.length) {
    if (bracketedPasteMode && wire.startsWith("\x1b[200~")) { pastePending = true; wire = wire.slice(6); continue; }
    if (bracketedPasteMode && wire.startsWith("\x1b[201~")) { pastePending = false; wire = wire.slice(6); continue; }
    if (bracketedPasteMode && ("\x1b[200~".startsWith(wire) || "\x1b[201~".startsWith(wire))) break;
    const char = wire[0];
    wire = wire.slice(1);
    if (!pastePending && /[\r\n]/.test(char)) { commands.push(input); input = ""; }
    else {
      input += char;
      if (
        disableBracketedPasteAfterKeywordPrefix &&
        !disabledAfterKeywordPrefix &&
        !pastePending &&
        input === "ultracode:"
      ) {
        disabledAfterKeywordPrefix = true;
        bracketedPasteMode = false;
        process.stdout.write("\x1b[?2004l");
      }
      if (
        disableBracketedPasteAfterKeywordBody &&
        !disabledAfterKeywordBody &&
        pastePending &&
        input.startsWith("ultracode:") &&
        input.length > "ultracode:".length
      ) {
        disabledAfterKeywordBody = true;
        bracketedPasteMode = false;
        process.stdout.write("\x1b[?2004l");
      }
      if (
        disableBracketedPasteAfterUnframedKeywordBody &&
        !disabledAfterKeywordBody &&
        input.startsWith("ultracode:") &&
        input.length > "ultracode:".length
      ) {
        disabledAfterKeywordBody = true;
        bracketedPasteMode = false;
        process.stdout.write("\x1b[?2004l");
      }
    }
  }
  for (const submitted of commands) {
    const command = submitted.trim();
    if (command.startsWith("ultracode:")) {
      process.stdout.write(`\r\nKEYWORD_ACK:${JSON.stringify(submitted)}\r\n> `);
      continue;
    }
    if (command === "/exit") {
      recordExitTrace("exit_command", { ignored: process.env.RAIL_CONNECTOR_FAKE_CLAUDE_IGNORE_EXIT === "1" });
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
