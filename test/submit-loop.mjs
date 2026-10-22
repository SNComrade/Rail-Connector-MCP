import assert from "node:assert/strict";
import { runSubmitPrompt, sendTmuxText, validateSubmitPromptInput, withRequestSignal, requestDelay } from "../src/index.js";
import { assertFramedPromptText } from "../src/terminal.js";

const prompt = "Review the current branch and return a concise report.";
const input = {
  managedSession: "claude-review",
  text: prompt,
  pasteMode: "auto",
  submitRetries: 1,
  retryDelayMs: 250,
  chunkSize: 1024,
  chunkDelayMs: 0,
  lines: 120,
  force: false,
};

function scriptedBackend(captures) {
  const remainingCaptures = [...captures];
  const calls = { capture: [], sendText: [], sendKey: [], delay: [] };
  return {
    calls,
    dependencies: {
      isNativeWindows: true,
      capture: async (...args) => {
        calls.capture.push(args);
        assert.ok(remainingCaptures.length > 0, "submit workflow requested an unexpected capture");
        return remainingCaptures.shift();
      },
      sendText: async (...args) => {
        calls.sendText.push(args);
        return { bracketedPasteUsed: Boolean(args[3]?.bracketedPaste) };
      },
      sendKey: async (...args) => calls.sendKey.push(args),
      delay: async (...args) => calls.delay.push(args),
      promptAcknowledged: async () => false,
    },
  };
}

// Framed intent rejects terminal controls before capture, workflow observation,
// acknowledgement, delay or input. Force never changes this validation rule.
const forbiddenControls = Array.from({ length: 160 }, (_, code) => code)
  .filter((code) => code <= 0x1f && ![0x09, 0x0a, 0x0d].includes(code) || code >= 0x7f)
  .map((code) => String.fromCharCode(code));
for (const pasteMode of [undefined, "auto", "bracketed"]) {
  for (const force of [false, true]) {
    for (const unsafe of [...forbiddenControls, "\x1b[201~\r/exit", "\x1b[200~"] ) {
      const effects = [];
      const dependencies = Object.fromEntries([
        "capture", "sendText", "sendKey", "delay", "runtimeObservation", "promptAcknowledged",
      ].map((name) => [name, async () => { effects.push(name); throw new Error("Unexpected pre-validation side effect"); }]));
      await assert.rejects(runSubmitPrompt({ ...input, pasteMode, force, text: `body${unsafe}suffix` }, dependencies),
        (error) => error.code === "EINVAL" && /terminal control/.test(error.message));
      assert.deepEqual(effects, []);
      assert.throws(() => validateSubmitPromptInput({ ...input, pasteMode, force, text: `body${unsafe}suffix` }),
        (error) => error.code === "EINVAL");
    }
  }
}
for (const pasteMode of ["unknown", "literal ", "AUTO", "", null, false, 0]) {
  const invalidMode = scriptedBackend([]);
  await assert.rejects(runSubmitPrompt({ ...input, pasteMode, text: "body\x1b[201~", force: true }, invalidMode.dependencies),
    (error) => error.code === "EINVAL" && /pasteMode/.test(error.message));
  assert.deepEqual(invalidMode.calls, { capture: [], sendText: [], sendKey: [], delay: [] });
}
const exactValidPrompt = "Unicode 🧪 résumé e\u0301 漢字\tTAB\nLF\rCR\r\nCRLF\u2028line\u2029paragraph";
assert.equal(assertFramedPromptText(exactValidPrompt), exactValidPrompt);
for (const pasteMode of ["auto", "bracketed"]) {
  const exact = scriptedBackend(["> ", "> ", "> "]);
  exact.dependencies.promptAcknowledged = async (_name, text) => text === exactValidPrompt;
  const result = await runSubmitPrompt({ ...input, pasteMode, text: exactValidPrompt }, exact.dependencies);
  assert.equal(result.status, "submitted");
  assert.equal(result.transcriptAcknowledged, true);
  assert.equal(exact.calls.sendText.length, 1);
  assert.equal(exact.calls.sendText[0][1], exactValidPrompt);
  assert.equal(exact.calls.sendText[0][3].bracketedPaste, true);
  assert.equal(exact.calls.sendKey.length, 0);
}
const literalControlPrompt = "explicit raw\x1b[201~\x00\t\r\n";
const explicitLiteral = scriptedBackend(["> ", "> ", "> "]);
explicitLiteral.dependencies.promptAcknowledged = async () => true;
assert.equal((await runSubmitPrompt({ ...input, pasteMode: "literal", text: literalControlPrompt },
  explicitLiteral.dependencies)).status, "submitted");
assert.equal(explicitLiteral.calls.sendText[0][1], literalControlPrompt);
assert.equal(explicitLiteral.calls.sendText[0][3].bracketedPaste, false);

const blocked = scriptedBackend(["Misting...   ( 1s  ·  1 tokens )\n> "]);
const blockedResult = await runSubmitPrompt(input, blocked.dependencies);
assert.equal(blockedResult.status, "preflight_blocked");
assert.equal(blockedResult.reason, "busy");
assert.equal(blockedResult.forceUsed, false);
assert.equal(blocked.calls.sendText.length, 0);
assert.equal(blocked.calls.sendKey.length, 0);

const workflowBlocked = scriptedBackend(["> "]);
workflowBlocked.dependencies.runtimeObservation = async () => ({
  workflowActivity: {
    pendingCount: 1,
    pendingObservedAt: "2026-08-18T12:00:00Z",
    evidence: "claude_session_log",
  },
});
const workflowBlockedResult = await runSubmitPrompt(
  input,
  workflowBlocked.dependencies
);
assert.equal(workflowBlockedResult.status, "preflight_blocked");
assert.equal(workflowBlockedResult.reason, "workflow_pending");
assert.equal(workflowBlockedResult.forceUsed, false);
assert.equal(workflowBlockedResult.signals.workflowPending, true);
assert.equal(workflowBlocked.calls.sendText.length, 0);
assert.equal(workflowBlocked.calls.sendKey.length, 0);

const forcedBusy = scriptedBackend([
  "Misting...   ( 1s  ·  1 tokens )\n> ",
  "> ",
  "> ",
]);
const forcedBusyResult = await runSubmitPrompt(
  { ...input, force: true, submitRetries: 0 },
  forcedBusy.dependencies
);
assert.equal(forcedBusyResult.forceUsed, true);
assert.equal(forcedBusyResult.forcedPastReason, "busy");
assert.equal(forcedBusy.calls.sendText.length, 1);

const forcedUncertain = scriptedBackend(["> ", "> ", "> "]);
forcedUncertain.dependencies.runtimeObservation = async () => ({
  workflowActivity: {
    pendingCount: null,
    lastKnownPendingCount: 1,
    evidence: "claude_session_log_incomplete",
    observationUncertain: true,
  },
});
const forcedUncertainResult = await runSubmitPrompt(
  { ...input, force: true, submitRetries: 0 },
  forcedUncertain.dependencies
);
assert.equal(forcedUncertainResult.forceUsed, true);
assert.equal(forcedUncertainResult.forcedPastReason, "workflow_pending");
assert.equal(forcedUncertain.calls.sendText.length, 1);

const recovered = scriptedBackend(["> ", `> ${prompt}`, `> ${prompt}`, "Misting...   ( 1s  ·  1 tokens )\n> "]);
const recoveredResult = await runSubmitPrompt(input, recovered.dependencies);
assert.equal(recoveredResult.status, "submitted");
assert.equal(recoveredResult.forceUsed, false);
assert.equal(recoveredResult.forcedPastReason, undefined);
assert.equal(recoveredResult.retriesUsed, 1);
assert.equal(recovered.calls.sendText.length, 1);
assert.deepEqual(recovered.calls.sendText[0], [
  "claude-review",
  prompt,
  true,
  { bracketedPaste: true, requireBracketedPaste: false, chunkSize: 1024, chunkDelayMs: 0 },
]);
assert.deepEqual(recovered.calls.sendKey, [["claude-review", "Enter"]]);
assert.deepEqual(recovered.calls.delay, [[250]]);

const approvalText = "Do you want to proceed?\nYes, and don't ask again";
const approval = scriptedBackend(["> ", approvalText, approvalText, approvalText]);
const approvalResult = await runSubmitPrompt(input, approval.dependencies);
assert.equal(approvalResult.status, "approval_required");
assert.equal(approvalResult.reason, "approval_required");
assert.equal(approvalResult.retriesUsed, 0);
assert.equal(approval.calls.sendKey.length, 0);

const artifactPrompt = "Review the esc to interrupt terminal marker and report gaps.";
const artifactBackend = scriptedBackend([
  "> ",
  `> ${artifactPrompt}`,
  `> ${artifactPrompt}`,
  "Misting...   ( 1s  ·  1 tokens )\n> ",
]);
const artifactResult = await runSubmitPrompt({ ...input, text: artifactPrompt }, artifactBackend.dependencies);
assert.equal(artifactResult.status, "submitted");
assert.equal(artifactResult.retriesUsed, 1);
assert.deepEqual(artifactBackend.calls.sendKey, [["claude-review", "Enter"]]);

const unixBackend = scriptedBackend(["> ", `> ${prompt}`, `> ${prompt}`, "Misting...\n> "]);
unixBackend.dependencies.isNativeWindows = false;
await runSubmitPrompt(input, unixBackend.dependencies);
assert.equal(unixBackend.calls.sendText[0][3].bracketedPaste, true);

const acknowledged = scriptedBackend(["> ", `> ${prompt}`, `> ${prompt}`]);
acknowledged.dependencies.promptAcknowledged = async () => true;
const acknowledgedResult = await runSubmitPrompt(input, acknowledged.dependencies);
assert.equal(acknowledgedResult.status, "submitted");
assert.equal(acknowledgedResult.transcriptAcknowledged, true);
assert.equal(acknowledged.calls.sendKey.length, 0);

// Explicit keyword intent keeps the long multiline body pasted; it is never
// inferred from an occurrence in ordinary text, code, or quoted/tool material.
const keywordText = `ultracode: ${"context ".repeat(400)}\nUnicode 🧪 résumé\nlast line`;
const keyword = scriptedBackend(["> ", "> ", "> "]);
keyword.dependencies.sendText = async (...args) => {
  keyword.calls.sendText.push(args);
  return { bracketedPasteUsed: true, literalPrefixCharacters: 10 };
};
keyword.dependencies.promptAcknowledged = async (_name, text) => text === keywordText;
const keywordResult = await runSubmitPrompt(
  { ...input, text: keywordText, pasteMode: "keyword" },
  keyword.dependencies
);
assert.equal(keywordResult.status, "submitted");
assert.equal(keywordResult.pasteMode, "keyword");
assert.equal(keywordResult.literalPrefixCharacters, 10);
assert.equal(keywordResult.transcriptAcknowledged, true);
assert.equal(keyword.calls.sendText.length, 1);
assert.equal(keyword.calls.sendKey.length, 0);
assert.deepEqual(keyword.calls.sendText[0], [input.managedSession, keywordText, true,
  { bracketedPaste: true, requireBracketedPaste: true, keywordPrefix: true, chunkSize: 1024, chunkDelayMs: 0 }]);
for (const receipt of [{ bracketedPasteUsed: false }, { bracketedPasteUsed: true }, undefined]) {
  const downgrade = scriptedBackend(["> "]);
  downgrade.dependencies.sendText = async () => receipt;
  await assert.rejects(runSubmitPrompt({ ...input, text: keywordText, pasteMode: "keyword" }, downgrade.dependencies), error => error.code === "EPASTEMODE");
  assert.equal(downgrade.calls.sendKey.length, 0);
}
const ambiguousKeyword = scriptedBackend(["> ", `> ${keywordText}`, `> ${keywordText}`]);
ambiguousKeyword.dependencies.sendText = async () => ({ bracketedPasteUsed: true, literalPrefixCharacters: 10 });
const ambiguousKeywordResult = await runSubmitPrompt({ ...input, text: keywordText, pasteMode: "keyword", submitRetries: 2 }, ambiguousKeyword.dependencies);
assert.equal(ambiguousKeywordResult.retriesUsed, 0);
assert.equal(ambiguousKeyword.calls.sendKey.length, 0);
for (const text of ["ULTRACODE: body", "quoted ultracode: body", "```\nultracode: code\n```", "ultracode:", "ultracode:\n ", "ultracode: body\x1b[201~\r/exit", "ultracode: body\x00"]) {
  const invalid = scriptedBackend([]);
  await assert.rejects(runSubmitPrompt({ ...input, text, pasteMode: "keyword" }, invalid.dependencies), /Keyword delivery requires/);
  assert.equal(invalid.calls.sendText.length, 0);
  assert.equal(invalid.calls.capture.length, 0);
}
const keywordUnix = scriptedBackend([]);
keywordUnix.dependencies.isNativeWindows = false;
await assert.rejects(runSubmitPrompt({ ...input, text: keywordText, pasteMode: "keyword" }, keywordUnix.dependencies), /requires native Windows/);
const incidental = scriptedBackend(["> ", "> ", "> "]);
incidental.dependencies.promptAcknowledged = async () => true;
await runSubmitPrompt({ ...input, text: keywordText }, incidental.dependencies);
assert.equal(incidental.calls.sendText[0][3].keywordPrefix, undefined);
const keywordBusy = scriptedBackend(["Misting...   ( 1s  ·  1 tokens )\n> "]);
assert.equal((await runSubmitPrompt({ ...input, text: keywordText, pasteMode: "keyword" }, keywordBusy.dependencies)).status, "preflight_blocked");
assert.equal(keywordBusy.calls.sendText.length, 0);

// Keyword delivery cannot put its literal prefix after an existing draft,
// including when workflow evidence masks the composer's preflight reason.
for (const [capture, reason] of [
  ["> existing unsent draft", "active_input_not_empty"],
  ["> [Pasted text #1 +30 lines]", "paste_pending"],
  ["[Pasted text #1 +30 lines]\n> ", "paste_pending"],
  ["> A generated suggestion indistinguishable from a real draft", "active_input_not_empty"],
]) {
  for (const pending of [false, true]) {
    for (const force of [false, true]) {
      const occupied = scriptedBackend([capture]);
      occupied.dependencies.runtimeObservation = async () => ({
        workflowActivity: { pendingCount: pending ? 1 : 0, evidence: "claude_session_log" },
      });
      const result = await runSubmitPrompt(
        { ...input, text: keywordText, pasteMode: "keyword", force },
        occupied.dependencies
      );
      assert.equal(result.status, "preflight_blocked");
      assert.equal(result.reason, reason);
      assert.equal(result.forceUsed, false);
      assert.equal(result.forceRefused, force ? true : undefined);
      assert.equal(result.signals.workflowPending, pending);
      assert.equal(occupied.calls.sendText.length, 0);
      assert.equal(occupied.calls.sendKey.length, 0);
    }
  }
}
const unavailableKeywordCapture = scriptedBackend([]);
unavailableKeywordCapture.dependencies.capture = async () => { throw new Error("capture unavailable"); };
await assert.rejects(runSubmitPrompt(
  { ...input, text: keywordText, pasteMode: "keyword", force: true }, unavailableKeywordCapture.dependencies
), /capture unavailable/);
assert.equal(unavailableKeywordCapture.calls.sendText.length, 0);
assert.equal(unavailableKeywordCapture.calls.sendKey.length, 0);

// Ordinary force behavior is unchanged; this new restriction is keyword-only.
const ordinaryForcedDraft = scriptedBackend(["> existing unsent draft", "> ", "> "]);
ordinaryForcedDraft.dependencies.promptAcknowledged = async () => true;
const ordinaryForcedResult = await runSubmitPrompt({ ...input, force: true }, ordinaryForcedDraft.dependencies);
assert.equal(ordinaryForcedResult.status, "submitted");
assert.equal(ordinaryForcedResult.forcedPastReason, "active_input_not_empty");
assert.equal(ordinaryForcedDraft.calls.sendText.length, 1);

const emptyForcedKeyword = scriptedBackend(["> ", "> ", "> "]);
emptyForcedKeyword.dependencies.promptAcknowledged = async () => true;
emptyForcedKeyword.dependencies.sendText = async (...args) => {
  emptyForcedKeyword.calls.sendText.push(args);
  return { bracketedPasteUsed: true, literalPrefixCharacters: 10 };
};
const emptyForcedResult = await runSubmitPrompt(
  { ...input, text: keywordText, pasteMode: "keyword", force: true }, emptyForcedKeyword.dependencies
);
assert.equal(emptyForcedResult.status, "submitted");
assert.equal(emptyForcedResult.forceUsed, false);
assert.equal(emptyForcedKeyword.calls.sendText.length, 1);
assert.equal(emptyForcedKeyword.calls.sendKey.length, 0);

const degradedPaste = scriptedBackend(["> ", "> ", "> "]);
degradedPaste.dependencies.sendText = async (...args) => {
  degradedPaste.calls.sendText.push(args);
  return { bracketedPasteUsed: false };
};
degradedPaste.dependencies.promptAcknowledged = async () => true;
const degradedPasteResult = await runSubmitPrompt(
  input,
  degradedPaste.dependencies
);
assert.equal(degradedPasteResult.status, "submitted");
assert.equal(degradedPasteResult.pasteMode, "literal");
assert.equal(degradedPasteResult.bracketedPasteRequested, true);
assert.equal(degradedPasteResult.bracketedPasteUsed, false);
assert.match(degradedPasteResult.deliveryWarning, /literal chunked input/);

for (const [pasteMode, text, receipt] of [
  ["auto", "plain prompt", undefined],
  ["auto", "plain prompt", {}],
  ["auto", "plain prompt", { bracketedPasteUsed: "true" }],
  ["auto", "line\nline", { bracketedPasteUsed: false }],
  ["auto", "has\ttab", { bracketedPasteUsed: false }],
  ["bracketed", "plain prompt", { bracketedPasteUsed: false }],
]) {
  const missing = scriptedBackend(["> "]);
  missing.dependencies.sendText = async (...args) => { missing.calls.sendText.push(args); return receipt; };
  missing.dependencies.promptAcknowledged = async () => assert.fail("unconfirmed send must not continue to acknowledgement");
  await assert.rejects(runSubmitPrompt({ ...input, pasteMode, text, force: true }, missing.dependencies),
    (error) => error.code === "EPASTEMODE");
  assert.equal(missing.calls.sendText.length, 1, "the first backend call may already have written input");
  assert.equal(missing.calls.capture.length, 1);
  assert.equal(missing.calls.sendKey.length, 0);
  assert.equal(missing.calls.delay.length, 0, "no retry after an ambiguous delivery receipt");
}

// Mock only the tmux invocation boundary; real queue/mode/wire acceptance is
// exercised separately by tmux-integration on a supported POSIX CI host.
function cleanupCommand(args) {
  return args[0] === "set-buffer" && args[1] === "-b" && args.length === 10;
}
function cleanupReceipt(args, outcome = "cleanup_deleted") {
  const selected = args[outcome === "cleanup_deleted" ? 8 : 9];
  const marker = /RAIL_SEND:[a-f0-9]{32}:cleanup_(?:deleted|unconfirmed)/.exec(selected)?.[0];
  assert.ok(marker, "cleanup needs an internally generated nonce receipt");
  return { ok: true, stdout: `${marker}\n` };
}
function mockedTmux(mode, enterMode = mode) {
  const calls = [];
  let branch = 0;
  let ownedBuffer;
  return { calls, dependencies: {
    loadTmux: async (...args) => { ownedBuffer = args[0][2]; calls.push(["load", ...args]); return { ok: true }; },
    delay: async (...args) => { calls.push(["delay", ...args]); },
    runTmux: async (args, options = {}) => {
      calls.push(["tmux", args]);
      assert.notEqual(args[0], "delete-buffer", "no unconditional delete");
      if (cleanupCommand(args)) {
        assert.equal(options.requestCleanup, true);
        assert.deepEqual(args.slice(0, 7), ["set-buffer", "-b", ownedBuffer, "x", ";", "if-shell", "-F"]);
        assert.equal(args[7], `#{==:#{buffer_name},${ownedBuffer}}`);
        return cleanupReceipt(args);
      }
      if (args[0] !== "if-shell") return { ok: true, stdout: "" };
      assert.deepEqual(args.slice(0, 5), ["if-shell", "-F", "-t", "%17", "#{==:#{bracket_paste_flag},1}"]);
      const selected = (branch++ === 0 ? mode : enterMode) === "1" ? args[5] : args[6];
      if (selected.includes(":refused")) assert.equal(selected.includes("delete-buffer"), false);
      const marker = /RAIL_SEND:[a-f0-9]{32}:(framed|literal|refused|entered|enter_refused)/.exec(selected)?.[0];
      assert.ok(marker, "branch needs an explicit owned marker");
      return { ok: true, stdout: `${marker}\n` };
    },
  } };
}
const cleanupCalls = (backend) => backend.calls.filter(([kind, args]) => kind === "tmux" && cleanupCommand(args));
for (const mode of ["0", ""]) {
  for (const [text, requireBracketedPaste] of [["line\nline", false], ["has\ttab", false], ["CR\rline", false], ["strict plain", true]]) {
    const backend = mockedTmux(mode);
    await assert.rejects(sendTmuxText("%17", text, true, { bracketedPaste: true, requireBracketedPaste }, backend.dependencies),
      (error) => error.code === "EPASTEMODE" && /no input was sent/.test(error.message));
    assert.equal(backend.calls.filter(([kind, args]) => kind === "tmux" && args[0] === "if-shell").length, 1);
    assert.equal(backend.calls.filter(([kind]) => kind === "delay").length, 0);
    assert.equal(cleanupCalls(backend).length, 1);
  }
  const fallback = mockedTmux(mode);
  assert.equal((await sendTmuxText("%17", "plain Unicode 🧪", true, { bracketedPaste: true }, fallback.dependencies)).bracketedPasteUsed, false);
  assert.equal(cleanupCalls(fallback).length, 0);
}
const framedTmux = mockedTmux("1");
assert.equal((await sendTmuxText("%17", exactValidPrompt, true, {
  bracketedPaste: true, requireBracketedPaste: true,
}, framedTmux.dependencies)).bracketedPasteUsed, true);
assert.equal(framedTmux.calls[0][2], exactValidPrompt);
assert.equal(framedTmux.calls.filter(([kind, args]) => kind === "tmux" && args[0] === "if-shell").length, 2);
assert.equal(cleanupCalls(framedTmux).length, 0);
const lostTmux = mockedTmux("1", "0");
await assert.rejects(sendTmuxText("%17", "plain", true, { bracketedPaste: true }, lostTmux.dependencies),
  (error) => error.code === "EPASTEMODE" && /prompt was pasted/.test(error.message) && /no Enter was sent/.test(error.message));
assert.equal(cleanupCalls(lostTmux).length, 0);
const missingEnterMarker = mockedTmux("1");
const runWithMarker = missingEnterMarker.dependencies.runTmux;
let conditionalCalls = 0;
missingEnterMarker.dependencies.runTmux = async (args) => {
  if (args[0] === "if-shell" && ++conditionalCalls === 2) return { ok: true, stdout: "" };
  return runWithMarker(args);
};
await assert.rejects(sendTmuxText("%17", "plain", true, { bracketedPaste: true }, missingEnterMarker.dependencies),
  (error) => error.code === "EPASTEMODE" && /Enter was not confirmed/.test(error.message) && !/no Enter was sent/.test(error.message));
assert.equal(cleanupCalls(missingEnterMarker).length, 0);
const failedLoad = mockedTmux("1");
failedLoad.dependencies.loadTmux = async (...args) => {
  failedLoad.calls.push(["load", ...args]); return { ok: false, stderr: "synthetic load failure" };
};
const failedLoadRun = failedLoad.dependencies.runTmux;
failedLoad.dependencies.runTmux = async (args) => cleanupCommand(args)
  ? (failedLoad.calls.push(["tmux", args]), cleanupReceipt(args)) : failedLoadRun(args);
await assert.rejects(sendTmuxText("%17", "plain", true, { bracketedPaste: true }, failedLoad.dependencies), /synthetic load failure/);
assert.equal(cleanupCalls(failedLoad).length, 1);
const failedCleanup = mockedTmux("0");
const deliveryBeforeCleanup = failedCleanup.dependencies.runTmux;
failedCleanup.dependencies.runTmux = async (args) => cleanupCommand(args)
  ? (failedCleanup.calls.push(["tmux", args]), { ok: false, stderr: "synthetic cleanup failure" }) : deliveryBeforeCleanup(args);
await assert.rejects(sendTmuxText("%17", "line\nline", true, { bracketedPaste: true }, failedCleanup.dependencies),
  (error) => error instanceof AggregateError && error.cause?.code === "EPASTEMODE" && error.errors[1]?.code === "ECLEANUP");
const missingMarker = mockedTmux("1");
const missingMarkerRun = missingMarker.dependencies.runTmux;
missingMarker.dependencies.runTmux = async (args, options) => {
  if (cleanupCommand(args)) return missingMarkerRun(args, options);
  missingMarker.calls.push(["tmux", args]); return { ok: true, stdout: "" };
};
await assert.rejects(sendTmuxText("%17", "plain", true, { bracketedPaste: true }, missingMarker.dependencies),
  (error) => error.code === "EPASTEMODE");
assert.equal(missingMarker.calls.filter(([kind]) => kind === "delay").length, 0);
assert.equal(cleanupCalls(missingMarker).length, 1);
const rawTmux = mockedTmux("0");
assert.equal((await sendTmuxText("%17", literalControlPrompt, false, { bracketedPaste: false }, rawTmux.dependencies)).bracketedPasteUsed, false);
assert.equal(rawTmux.calls[0][2], literalControlPrompt);
assert.equal(rawTmux.calls.some(([kind, args]) => kind === "tmux" && args[0] === "if-shell"), false);
for (const pane of ["session:0", "%17'; run-shell 'bad", ""]) {
  const backend = mockedTmux("1");
  await assert.rejects(sendTmuxText(pane, "plain", true, { bracketedPaste: true }, backend.dependencies), /concrete managed tmux pane/);
  assert.deepEqual(backend.calls, []);
}
for (const unsafe of ["body\x1b[201~", "body\x00"]) {
  const backend = mockedTmux("1");
  await assert.rejects(sendTmuxText("%17", unsafe, true, { bracketedPaste: true }, backend.dependencies), (error) => error.code === "EINVAL");
  assert.deepEqual(backend.calls, []);
}

// #209: all eight cancellation phases retain consumption and shield semantics.
const cancellationSeamEvidence = [];
for (const phase of ["before_start", "after_load", "after_paste", "during_settle", "during_default_settle", "after_enter", "after_final_delay", "cleanup_error"]) {
  const controller = new AbortController();
  const calls = [];
  let loadedBuffer, pendingRelease;
  let conditionalCalls = 0, cleanupWasShielded = false;
  const dependencies = {
    loadTmux: async (args) => {
      loadedBuffer = args[2]; calls.push("load");
      if (phase === "after_load" || phase === "cleanup_error") controller.abort();
      return { ok: true };
    },
    runTmux: async (args, options = {}) => {
      assert.notEqual(args[0], "delete-buffer");
      if (cleanupCommand(args)) {
        calls.push("cleanup");
        assert.equal(options.requestCleanup, true);
        assert.deepEqual(args.slice(0, 7), ["set-buffer", "-b", loadedBuffer, "x", ";", "if-shell", "-F"]);
        assert.equal(args[7], `#{==:#{buffer_name},${loadedBuffer}}`);
        await requestDelay(0);
        cleanupWasShielded = true;
        return phase === "cleanup_error" ? { ok: false, stderr: "owned cleanup sentinel failure" } : cleanupReceipt(args);
      }
      assert.equal(args[0], "if-shell");
      calls.push(++conditionalCalls === 1 ? "paste" : "enter");
      const marker = /RAIL_SEND:[a-f0-9]{32}:(framed|entered)/.exec(args[5])?.[0];
      assert.ok(marker);
      if ((phase === "after_paste" || phase === "during_default_settle") && conditionalCalls === 1) {
        if (phase === "after_paste") controller.abort(); else setTimeout(() => controller.abort(), 0);
      }
      if (phase === "after_enter" && conditionalCalls === 2) controller.abort();
      return { ok: true, stdout: `${marker}\n` };
    },
  };
  if (phase !== "during_default_settle") dependencies.delay = async (ms) => {
    calls.push(`delay:${ms}`);
    if (phase === "during_settle" && ms === 100) {
      const pending = new Promise((resolve) => { pendingRelease = resolve; });
      queueMicrotask(() => controller.abort()); return pending;
    }
    if (phase === "after_final_delay" && ms === 500) controller.abort();
  };
  if (phase === "before_start") controller.abort();
  let rejected;
  try {
    await withRequestSignal(controller.signal, () => sendTmuxText("%17", "Unicode 🧪\tline\nnext", true,
      { bracketedPaste: true, requireBracketedPaste: true }, dependencies));
  } catch (error) { rejected = error; } finally { pendingRelease?.(); }
  assert.ok(rejected, `${phase} must reject`);
  if (phase === "cleanup_error") {
    assert.ok(rejected instanceof AggregateError);
    assert.equal(rejected.code, "ECLEANUP");
    assert.ok(rejected.message.includes(rejected.cause.message));
    assert.equal(rejected.cause?.code, "ECANCELLED");
    assert.equal(rejected.errors[0], rejected.cause);
    assert.equal(rejected.errors[1]?.code, "ECLEANUP");
  } else assert.equal(rejected.code, "ECANCELLED");
  const needsCleanup = ["after_load", "cleanup_error"].includes(phase);
  assert.equal(calls.filter((x) => x === "cleanup").length, needsCleanup ? 1 : 0);
  assert.equal(cleanupWasShielded, needsCleanup);
  if (phase === "before_start") assert.deepEqual(calls, []);
  else {
    if (needsCleanup) assert.equal(calls.at(-1), "cleanup");
    assert.equal(calls.includes("enter"), ["after_enter", "after_final_delay"].includes(phase));
    if (needsCleanup) assert.equal(calls.includes("paste"), false);
  }
  cancellationSeamEvidence.push({ phase, calls, cleanupWasShielded, rejection: rejected.code ?? rejected.constructor.name });
}
assert.equal(cancellationSeamEvidence.length, 8);

// Inert source model: tmux3.2 exact set replacement/promote, after-set hook,
// top guard and dangerous missing-name delete fallback. No tmux/CLI/PTY.
// Final-state assertions model no after-delete hook; a real hook may recreate
// the owned name after guarded deletion, so its nonce does not prove absence.
function modeledTmux32({ loadAbsent = false, foreignAfterLoad = false, cancelAfterLoad = false,
  cancelAfterPaste = false, lostPasteAck = false, cleanupOutcome = "normal",
  afterSetHook = "none", pasteReceiptStyle = "clean", mode = "1" } = {}) {
  const controller = new AbortController();
  const buffers = new Map([["foreign-initial", "private sentinel A"]]);
  const calls = [], deleted = [], setNames = [];
  let owned, conditionals = 0, shielded = false;
  const top = () => [...buffers.keys()].at(-1);
  function deleteBuffer32(name) {
    const selected = buffers.has(name) ? name : top(); // upstream3.2 fallback
    if (selected !== undefined) { deleted.push(selected); buffers.delete(selected); }
  }
  function consumeNamed32(name) {
    // Named paste-buffer fails when absent; it has no delete-buffer fallback.
    assert.equal(buffers.has(name), true); deleted.push(name); buffers.delete(name);
  }
  function setExact32(name, value) {
    // paste_set replaces only exact name; a new order promotes it to the top.
    buffers.delete(name); buffers.set(name, value); setNames.push(name);
  }
  const dependencies = {
    delay: async () => {},
    loadTmux: async (args, value) => {
      owned = args[2]; calls.push("load");
      if (!loadAbsent) buffers.set(owned, value);
      if (foreignAfterLoad) buffers.set("foreign-latest", "private sentinel B");
      if (cancelAfterLoad) controller.abort();
      return loadAbsent ? { ok: false, stderr: "synthetic uncertain load" } : { ok: true };
    },
    runTmux: async (args, options = {}) => {
      assert.notEqual(args[0], "delete-buffer", "unconditional delete could hit foreign top");
      if (cleanupCommand(args)) {
        calls.push("cleanup");
        assert.equal(options.requestCleanup, true);
        assert.deepEqual(args.slice(0, 7), ["set-buffer", "-b", owned, "x", ";", "if-shell", "-F"]);
        assert.equal(args[7], `#{==:#{buffer_name},${owned}}`);
        assert.match(args[8], new RegExp("^'delete-buffer' '-b' '" + owned + "' ; 'display-message' '-p' 'RAIL_SEND:[a-f0-9]{32}:cleanup_deleted'$"));
        assert.match(args[9], /^'display-message' '-p' 'RAIL_SEND:[a-f0-9]{32}:cleanup_unconfirmed'$/);
        assert.equal(args.some((arg) => arg.includes("#(") || arg.includes("run-shell") || arg.includes("show-buffer")), false);
        await requestDelay(0); shielded = true;
        setExact32(owned, "x");
        // Model after-set hook BEFORE the if-shell guard, including yielding
        // to a second client that inserts an unrelated newer buffer.
        if (afterSetHook === "foreign") buffers.set("foreign-after-set", "private sentinel C");
        if (afterSetHook === "delete-owned") buffers.delete(owned);
        let result;
        if (top() === owned) { deleteBuffer32(owned); result = cleanupReceipt(args); }
        else result = cleanupReceipt(args, "cleanup_unconfirmed");
        if (cleanupOutcome === "missing") return { ok: true, stdout: "" };
        if (cleanupOutcome === "wrong") return { ok: true, stdout: result.stdout.replace(/^RAIL_SEND:(.)/,
          (_, digit) => "RAIL_SEND:" + (digit === "0" ? "1" : "0")) };
        if (cleanupOutcome === "timeout-result") return { ok: false, code: "ETIMEDOUT", stderr: "synthetic cleanup timeout" };
        if (cleanupOutcome === "timeout-throw") throw Object.assign(new Error("synthetic cleanup timeout"), { code: "ETIMEDOUT" });
        if (cleanupOutcome === "nonzero") return { ok: false, stderr: "synthetic conditional failure" };
        return result;
      }
      if (args[0] === "paste-buffer") {
        calls.push("raw-paste"); assert.equal(args.includes("-d"), true); consumeNamed32(owned);
        if (cancelAfterPaste) controller.abort(); return { ok: true };
      }
      assert.equal(args[0], "if-shell"); assert.equal(args[1], "-F"); assert.equal(args[2], "-t");
      const paste = ++conditionals === 1; calls.push(paste ? "paste" : "enter");
      const selected = mode === "1" ? args[5] : args[6];
      const marker = /RAIL_SEND:[a-f0-9]{32}:(framed|literal|refused|entered|enter_refused)/.exec(selected)?.[0];
      assert.ok(marker);
      if (paste && !marker.endsWith(":refused")) {
        assert.equal(selected.includes("'-d'"), true); consumeNamed32(owned);
        if (cancelAfterPaste) controller.abort();
        if (lostPasteAck) { buffers.set("foreign-latest", "private sentinel B"); return { ok: true, stdout: "" }; }
        if (pasteReceiptStyle === "hook-output") return { ok: true, stdout: "synthetic after-paste hook\n" + marker + "\n" };
        if (pasteReceiptStyle === "nonzero") return { ok: false, stdout: marker + "\n", stderr: "synthetic later hook failure" };
      } else if (paste) {
        assert.equal(selected.includes("delete-buffer"), false); assert.equal(selected.includes("paste-buffer"), false);
      }
      return { ok: true, stdout: marker + "\n" };
    },
  };
  return { controller, buffers, calls, deleted, setNames, dependencies, owned: () => owned, shielded: () => shielded };
}
function hasCleanupError(error, primaryCode) {
  return error instanceof AggregateError && error.code === "ECLEANUP" &&
    error.errors[1]?.code === "ECLEANUP" && error.errors[0] === error.cause &&
    (!primaryCode || error.cause?.code === primaryCode) &&
    error.message.includes(error.cause.message) && error.message.includes("UNCONFIRMED");
}
for (const scenario of [
  { name: "absent-owned-foreign-top", loadAbsent: true },
  { name: "owned-nontop-foreign-top", foreignAfterLoad: true, cancelAfterLoad: true },
]) {
  const fixture = modeledTmux32(scenario);
  await assert.rejects(withRequestSignal(fixture.controller.signal, () => sendTmuxText("%17", "line\nline", true,
    { bracketedPaste: true, requireBracketedPaste: true }, fixture.dependencies)),
    (error) => scenario.cancelAfterLoad ? error.code === "ECANCELLED" : /synthetic uncertain load/.test(error.message));
  assert.equal(fixture.calls.filter((x) => x === "cleanup").length, 1);
  assert.equal(fixture.calls.includes("paste"), false); assert.equal(fixture.calls.includes("enter"), false);
  assert.deepEqual(fixture.setNames, [fixture.owned()]);
  assert.deepEqual(fixture.deleted, [fixture.owned()]);
  assert.equal(fixture.buffers.has(fixture.owned()), false);
  assert.equal(fixture.buffers.get("foreign-initial"), "private sentinel A");
  if (scenario.foreignAfterLoad) assert.equal(fixture.buffers.get("foreign-latest"), "private sentinel B");
}
const topCancelled = modeledTmux32({ cancelAfterLoad: true });
await assert.rejects(withRequestSignal(topCancelled.controller.signal, () => sendTmuxText("%17", "line\nline", true,
  { bracketedPaste: true, requireBracketedPaste: true }, topCancelled.dependencies)), (error) => error.code === "ECANCELLED");
assert.deepEqual(topCancelled.deleted, [topCancelled.owned()]);
assert.equal(topCancelled.shielded(), true); assert.deepEqual(topCancelled.calls, ["load", "cleanup"]);
assert.equal(topCancelled.buffers.get("foreign-initial"), "private sentinel A");
for (const afterSetHook of ["foreign", "delete-owned"]) {
  const interleaved = modeledTmux32({ cancelAfterLoad: true, afterSetHook });
  await assert.rejects(withRequestSignal(interleaved.controller.signal, () => sendTmuxText("%17", "private owned prompt", true,
    { bracketedPaste: true, requireBracketedPaste: true }, interleaved.dependencies)),
    (error) => hasCleanupError(error, "ECANCELLED"));
  assert.deepEqual(interleaved.setNames, [interleaved.owned()]);
  assert.deepEqual(interleaved.deleted, [], "false top guard must not reach legacy fallback");
  assert.equal(interleaved.buffers.get("foreign-initial"), "private sentinel A");
  assert.equal([...interleaved.buffers.values()].includes("private owned prompt"), false, "exact set overwrites prompt before hook");
  assert.equal(interleaved.buffers.get(interleaved.owned()), afterSetHook === "foreign" ? "x" : undefined);
  if (afterSetHook === "foreign") assert.equal(interleaved.buffers.get("foreign-after-set"), "private sentinel C");
  assert.equal(interleaved.calls.includes("paste"), false); assert.equal(interleaved.calls.includes("enter"), false);
}
for (const options of [
  { bracketedPaste: true, mode: "1" }, { bracketedPaste: true, mode: "0" }, { bracketedPaste: false, mode: "0" },
]) {
  const consumed = modeledTmux32({ cancelAfterPaste: true, mode: options.mode });
  await assert.rejects(withRequestSignal(consumed.controller.signal, () => sendTmuxText("%17", "plain", true,
    { bracketedPaste: options.bracketedPaste }, consumed.dependencies)), (error) => error.code === "ECANCELLED");
  assert.deepEqual(consumed.deleted, [consumed.owned()]);
  assert.equal(consumed.calls.includes("cleanup"), false);
  assert.deepEqual(consumed.setNames, []);
  assert.equal(consumed.calls.includes("enter"), false);
}
for (const mode of ["1", "0"]) for (const pasteReceiptStyle of ["hook-output", "nonzero"]) {
  const consumed = modeledTmux32({ mode, pasteReceiptStyle });
  await assert.rejects(sendTmuxText("%17", "plain", true, { bracketedPaste: true }, consumed.dependencies),
    (error) => error.code === "EPASTEMODE");
  assert.deepEqual(consumed.deleted, [consumed.owned()]);
  assert.equal(consumed.calls.includes("cleanup"), false, "exact nonce line proves consumption despite dirty delivery receipt");
  assert.deepEqual(consumed.setNames, []); assert.equal(consumed.calls.includes("enter"), false);
}
for (const afterSetHook of ["none", "foreign"]) {
  const lostAck = modeledTmux32({ lostPasteAck: true, afterSetHook });
  await assert.rejects(sendTmuxText("%17", "line\nline", true,
    { bracketedPaste: true, requireBracketedPaste: true }, lostAck.dependencies),
    (error) => afterSetHook === "none" ? error.code === "EPASTEMODE" : hasCleanupError(error, "EPASTEMODE"));
  assert.equal(lostAck.buffers.get("foreign-latest"), "private sentinel B");
  assert.equal(lostAck.calls.includes("enter"), false);
  assert.deepEqual(lostAck.setNames, [lostAck.owned()]);
  assert.deepEqual(lostAck.deleted, afterSetHook === "none" ? [lostAck.owned(), lostAck.owned()] : [lostAck.owned()]);
  if (afterSetHook === "foreign") assert.equal(lostAck.buffers.get("foreign-after-set"), "private sentinel C");
}
const refusedPaste = modeledTmux32({ mode: "0" });
await assert.rejects(sendTmuxText("%17", "line\nline", true,
  { bracketedPaste: true, requireBracketedPaste: true }, refusedPaste.dependencies), (error) => error.code === "EPASTEMODE");
assert.deepEqual(refusedPaste.deleted, [refusedPaste.owned()]);
assert.deepEqual(refusedPaste.setNames, [refusedPaste.owned()]);
assert.deepEqual(refusedPaste.calls, ["load", "paste", "cleanup"]);
for (const cleanupOutcome of ["missing", "wrong", "timeout-result", "timeout-throw", "nonzero"]) {
  const uncertain = modeledTmux32({ cancelAfterLoad: true, cleanupOutcome });
  await assert.rejects(withRequestSignal(uncertain.controller.signal, () => sendTmuxText("%17", "line\nline", true,
    { bracketedPaste: true, requireBracketedPaste: true }, uncertain.dependencies)),
    (error) => hasCleanupError(error, "ECANCELLED") &&
      (!cleanupOutcome.startsWith("timeout-") || error.errors[1].cause?.code === "ETIMEDOUT"));
  assert.equal(uncertain.calls.filter((x) => x === "cleanup").length, 1);
  assert.equal(uncertain.calls.includes("paste"), false); assert.equal(uncertain.calls.includes("enter"), false);
  assert.equal(uncertain.buffers.get("foreign-initial"), "private sentinel A");
}


const delayedPaste = scriptedBackend([
  "> ",
  "> ",
  "> ",
  "> [Pasted text #1 +576 lines]\n",
  "Cultivating...\n> ",
]);
const delayedPasteResult = await runSubmitPrompt(
  { ...input, text: "A".repeat(23000), retryDelayMs: 500 },
  delayedPaste.dependencies
);
assert.equal(delayedPasteResult.status, "submitted");
assert.equal(delayedPasteResult.retriesUsed, 1);
assert.deepEqual(delayedPaste.calls.sendKey, [["claude-review", "Enter"]]);
assert.deepEqual(delayedPaste.calls.delay, [[500], [500]]);

const noRetryEvidence = scriptedBackend(Array(7).fill("> "));
const noRetryEvidenceResult = await runSubmitPrompt(input, noRetryEvidence.dependencies);
assert.equal(noRetryEvidenceResult.retriesUsed, 0);
assert.equal(noRetryEvidence.calls.sendKey.length, 0);
assert.deepEqual(noRetryEvidence.calls.delay, [[250], [250], [250], [250]]);

const trustText = "Do you trust the files in this folder?\nYes, I trust\nNo, exit";
const trustAfterSubmit = scriptedBackend(["> ", trustText, trustText, trustText]);
const trustAfterSubmitResult = await runSubmitPrompt(input, trustAfterSubmit.dependencies);
assert.equal(trustAfterSubmitResult.status, "needs_attention");
assert.equal(trustAfterSubmitResult.reason, "workspace_trust_required");
assert.equal(trustAfterSubmitResult.retriesUsed, 0);
assert.equal(trustAfterSubmit.calls.sendKey.length, 0);

console.log("submit-loop ok");
