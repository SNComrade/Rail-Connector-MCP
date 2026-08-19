import assert from "node:assert/strict";
import {
  activeInputContainsText,
  captureSignals,
  lifecycleBlockReason,
  signalsWithWorkflowActivity,
  submitPreflightReason,
  submitResultStatus,
} from "../src/index.js";

const prompt = "Please review the repo and return a concise report.";

assert.equal(submitPreflightReason(captureSignals("> ")), "");
assert.equal(submitPreflightReason(captureSignals("Misting...   ( 1s  ·  1 tokens )\n> ")), "busy");
assert.equal(submitPreflightReason(captureSignals("Bloviating…   ( 1s  ·  1 tokens )\n> ")), "busy");
assert.equal(submitPreflightReason(captureSignals("Usage limit reached soon\n> ")), "limit_warning");
assert.equal(submitPreflightReason(captureSignals("[managed session exited, code 0]\nDone")), "exited");
assert.equal(submitPreflightReason(captureSignals("Do you want to proceed?\nYes, and don't ask again")), "approval_required");
assert.equal(submitPreflightReason(captureSignals("[Pasted text #1 +30 lines]\n> ")), "paste_pending");
assert.equal(submitPreflightReason(captureSignals("> [Pasted text #1 +46 lines]\n")), "paste_pending");
assert.equal(submitPreflightReason(captureSignals("Interrupted · What should Claude do instead?\n> ")), "interrupted");
assert.equal(
  submitPreflightReason(captureSignals("Do you trust the files in this folder?\nYes, I trust\nNo, exit\n> ")),
  "workspace_trust_required"
);
assert.equal(submitPreflightReason(captureSignals(`> ${prompt}`)), "active_input_not_empty");
assert.equal(submitPreflightReason(captureSignals("> 1. keep this numbered draft")), "active_input_not_empty");
assert.equal(submitPreflightReason(captureSignals('> Try "review the repository"')), "active_input_not_empty");
const pendingWorkflowSignals = signalsWithWorkflowActivity(captureSignals("> "), {
  pendingCount: 2,
  pendingObservedAt: "2026-08-18T12:00:00Z",
  evidence: "claude_session_log",
});
assert.equal(submitPreflightReason(pendingWorkflowSignals), "workflow_pending");
assert.equal(lifecycleBlockReason(pendingWorkflowSignals), "workflow_pending");
const uncertainWorkflowSignals = signalsWithWorkflowActivity(captureSignals("> "), {
  pendingCount: null,
  lastKnownPendingCount: 1,
  evidence: "claude_session_log_incomplete",
  observationUncertain: true,
  observationCoverage: "head_tail",
  observationSkippedBytes: 4096,
});
assert.equal(uncertainWorkflowSignals.workflowPending, true);
assert.equal(uncertainWorkflowSignals.workflowPendingCount, null);
assert.equal(
  uncertainWorkflowSignals.workflowPendingEvidence,
  "claude_session_log_incomplete"
);
assert.equal(uncertainWorkflowSignals.workflowPendingObservedAt, "");
assert.equal(uncertainWorkflowSignals.workflowObservationUncertain, true);
assert.equal(submitPreflightReason(uncertainWorkflowSignals), "workflow_pending");
assert.equal(lifecycleBlockReason(uncertainWorkflowSignals), "workflow_pending");
const mixedUncertainWorkflowSignals = signalsWithWorkflowActivity(
  captureSignals("✢ Waiting for 2 dynamic workflows to finish\n> "),
  {
    pendingCount: null,
    lastKnownPendingCount: 1,
    evidence: "claude_session_log_incomplete",
    observationUncertain: true,
    observationCoverage: "head_tail",
    observationSkippedBytes: 4096,
  }
);
assert.equal(mixedUncertainWorkflowSignals.workflowPending, true);
assert.equal(mixedUncertainWorkflowSignals.workflowPendingCount, 2);
assert.equal(
  mixedUncertainWorkflowSignals.workflowPendingEvidence,
  "terminal_heuristic"
);
assert.equal(mixedUncertainWorkflowSignals.workflowObservationUncertain, true);
const approvalDuringWorkflow = signalsWithWorkflowActivity(
  captureSignals("Do you want to proceed?\nYes, and don't ask again"),
  {
    pendingCount: 1,
    evidence: "claude_session_log",
  }
);
assert.equal(approvalDuringWorkflow.workflowPending, true);
assert.equal(approvalDuringWorkflow.terminalState, "approval_required");
assert.equal(lifecycleBlockReason(approvalDuringWorkflow), "approval_required");
assert.equal(lifecycleBlockReason(captureSignals("> ")), "");
assert.equal(lifecycleBlockReason(captureSignals("> unsent draft")), "awaiting_input");

assert.equal(activeInputContainsText(`assistant transcript kept the words ${prompt}\n> `, prompt), false);
assert.equal(activeInputContainsText(`> ${prompt}`, prompt), true);
assert.equal(activeInputContainsText(`│ ❯\t${prompt}`, prompt), true);
assert.equal(
  activeInputContainsText(`>${"\t".repeat(100_000)}${prompt}`, prompt),
  true
);

assert.deepEqual(submitResultStatus(captureSignals("Misting...   ( 1s  ·  1 tokens )\n> "), "Misting...\n> ", prompt), {
  status: "submitted",
  reason: "",
});
assert.deepEqual(submitResultStatus(captureSignals(`Misting...   ( 1s  ·  1 tokens )\n> ${prompt}`), `Misting...\n> ${prompt}`, prompt), {
  status: "stuck_paste",
  reason: "active_input_not_submitted",
});
assert.deepEqual(
  submitResultStatus(captureSignals(`Misting...   ( 1s  ·  1 tokens )\n> ${prompt}`), `Misting...\n> ${prompt}`, prompt, {
    wasBusyBeforeSubmit: true,
  }),
  {
    status: "needs_attention",
    reason: "submitted_while_busy_active_input",
  }
);
assert.deepEqual(submitResultStatus(captureSignals("claude: done\n> "), "claude: done\n> ", prompt), {
  status: "submitted",
  reason: "",
});
assert.deepEqual(submitResultStatus(captureSignals(`[Pasted text #1 +30 lines]\n> `), `[Pasted text #1 +30 lines]\n> `, prompt), {
  status: "stuck_paste",
  reason: "paste_pending",
});
assert.deepEqual(submitResultStatus(captureSignals(`> ${prompt}`), `> ${prompt}`, prompt), {
  status: "stuck_paste",
  reason: "active_input_not_submitted",
});
assert.deepEqual(
  submitResultStatus(captureSignals("Do you want to proceed?\nYes, and don't ask again"), "Do you want to proceed?", prompt),
  {
    status: "approval_required",
    reason: "approval_required",
  }
);

console.log("submit-prompt ok");
