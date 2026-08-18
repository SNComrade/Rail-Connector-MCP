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
