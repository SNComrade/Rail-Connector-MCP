import assert from "node:assert/strict";
import { runSubmitPrompt } from "../src/index.js";

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
      sendText: async (...args) => calls.sendText.push(args),
      sendKey: async (...args) => calls.sendKey.push(args),
      delay: async (...args) => calls.delay.push(args),
      promptAcknowledged: async () => false,
    },
  };
}

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
  { bracketedPaste: true, chunkSize: 1024, chunkDelayMs: 0 },
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
  { bracketedPaste: true, keywordPrefix: true, chunkSize: 1024, chunkDelayMs: 0 }]);
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
