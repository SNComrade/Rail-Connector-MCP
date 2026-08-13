import assert from "node:assert/strict";
import {
  activeInputContainsText,
  captureSignals,
  launchPostureReport,
  mergeObservedPosture,
  renderCapture,
  runtimeObservationFromRecords,
  trustedSessionLogPosture,
} from "../src/index.js";

const cursorStyleProbe = "\x1b[>0q\x1b]0;claude\x07\x1b[38;2;215;119;87mHello";
assert.equal(await renderCapture(cursorStyleProbe), "Hello");

const cursorRight = "A\x1b[3CB";
assert.equal(await renderCapture(cursorRight), "A   B");

const eraseLine = "before\r\x1b[Kafter";
assert.equal(await renderCapture(eraseLine), "after");

const multiLineRepaint = "old top\r\nold bottom\x1b[2A\r\x1b[Knew top\r\n\x1b[Knew bottom";
assert.equal((await renderCapture(multiLineRepaint)).split("\n").slice(-2).join("\n"), "new top\nnew bottom");

assert.equal(activeInputContainsText("assistant text\n> Please review issue 3", "Please review issue 3"), true);
assert.equal(activeInputContainsText("user prompt in transcript\n> ", "user prompt in transcript"), false);
assert.equal(activeInputContainsText("assistant text\n\u2502 > Please review issue 3", "Please review issue 3"), true);
assert.equal(activeInputContainsText("user prompt in transcript\n\u2502 > ", "user prompt in transcript"), false);
assert.equal(activeInputContainsText("user prompt in transcript", "user prompt in transcript"), false);
const longPrompt = `Please review ${"alpha ".repeat(30)}tail marker`;
const longPromptTail = longPrompt.replace(/\s+/g, " ").trim().slice(-80);
assert.equal(activeInputContainsText(`assistant text\n> ${longPromptTail}`, longPrompt), true);
assert.equal(captureSignals("✻ Quantumizing...\n> ").likelyBusy, true);
assert.equal(captureSignals("✽ Blanching...\n> ").likelyBusy, true);
assert.equal(captureSignals("✢ Stewing…\npaste again to expand\n> ").likelyBusy, true);
assert.equal(captureSignals("✢ Consulting the rubber ducky…\n> ").likelyBusy, true);
assert.equal(
  captureSignals(
    "✢ Consulting the rubber ducky about an unusually stubborn compiler error before lunch today…\n> "
  ).likelyBusy,
  true
);
assert.equal(captureSignals("Consulting the rubber ducky… (2s · 4 tokens)\n> ").likelyBusy, true);
assert.equal(
  captureSignals(
    "Consulting the rubber ducky about an unusually stubborn compiler error before lunch today… (2m 49s · 11.7k tokens)\n> "
  ).likelyBusy,
  true
);
assert.equal(captureSignals("Consulting the rubber ducky…\n> ").likelyBusy, false);
assert.equal(captureSignals("This is ordinary prose…\n> ").likelyBusy, false);
assert.equal(captureSignals("Hmm... this is ordinary prose in the transcript.\n> ").likelyBusy, false);
assert.equal(captureSignals("Wait... let me reconsider that approach now.\n> ").likelyBusy, false);
assert.equal(captureSignals("⏺ Updated the file...\n> ").likelyBusy, false);
assert.equal(captureSignals("⏺ Wait for the build to finish...\n> ").likelyBusy, false);
assert.equal(captureSignals("· Reviewing the diff for regressions…\n> ").likelyBusy, false);
assert.equal(captureSignals("Considering the trade-offs here...\n> ").likelyBusy, false);
assert.equal(captureSignals("Reviewing the diff now...\n> ").likelyBusy, false);
assert.equal(captureSignals("Done\npaste again to expand\n> ").pastePlaceholder, false);
assert.equal(captureSignals("✻ Canoodling...\n> ").likelyBusy, true);
assert.equal(captureSignals("✻ Canoodling...\n> ").state, "busy");
assert.equal(captureSignals("Misting...   ( 1s  ·  1 tokens )\n> ").likelyBusy, true);
assert.equal(captureSignals("Lollygagging...   ( 1s  ·  1 tokens )\n> ").likelyBusy, true);
assert.equal(captureSignals("Bloviating…   ( 2m 49s  ·  11.7k tokens )\nplan mode on  ·  esc to interrupt").likelyBusy, true);
assert.equal(captureSignals("Bloviating…   ( 2m 49s  ·  11.7k tokens )\nplan mode on  ·  esc to interrupt").state, "busy");
assert.equal(
  captureSignals("The assistant said it was still thinking about the API response.\n> ").state,
  "idle"
);
assert.equal(captureSignals("waiting for api response\n> ").state, "idle");
assert.equal(captureSignals("still thinking\n> ").state, "idle");
assert.equal(captureSignals("> Review how esc to interrupt is detected").likelyBusy, false);
assert.equal(captureSignals("> Review how esc to interrupt is detected").state, "awaiting_input");
assert.equal(captureSignals("✻ Sock-hopping...\n> ").likelyBusy, true);
assert.equal(captureSignals("✽ Billowing...\n> ").likelyBusy, true);
assert.equal(captureSignals("assistant text\n> unsent prompt").state, "awaiting_input");
assert.equal(captureSignals("Usage limit reached soon\n> ").state, "limit_warning");
assert.equal(
  captureSignals(
    "Usage limit reached soon\nDo you want to proceed?\nYes, and don't ask again\nNo, and tell Claude what to do differently"
  ).state,
  "approval_required"
);
assert.equal(captureSignals("The report mentions sessionLimitWarning but no real banner.\n> ").state, "idle");
assert.equal(captureSignals("No session limit warning was present in the transcript.\n> ").state, "idle");
assert.equal(captureSignals("Do you want to proceed?\nYes, and don't ask again\nNo, and tell Claude what to do differently").state, "approval_required");
const quotedApprovalScreen = [
  "● The report quoted this terminal screen:",
  "Do you want to proceed?",
  "Yes, and don't ask again",
  "No, and tell Claude what to do differently",
  "✻ Cooked for 1s",
  "> ",
].join("\n");
assert.equal(captureSignals(quotedApprovalScreen).approvalRequired, false);
assert.equal(captureSignals(quotedApprovalScreen).state, "idle");
const quotedApprovalWhileBusy = [
  "● The report quoted this terminal screen:",
  "Do you want to proceed?",
  "Yes, and don't ask again",
  "No, and tell Claude what to do differently",
  "✢ Consulting the rubber ducky…",
  "> ",
].join("\n");
assert.equal(captureSignals(quotedApprovalWhileBusy).approvalRequired, false);
assert.equal(captureSignals(quotedApprovalWhileBusy).state, "busy");
assert.equal(
  captureSignals(
    "The assistant asked, Do you want to proceed? This sentence is ordinary report prose.\n> "
  ).approvalRequired,
  false
);
assert.equal(captureSignals("Assistant mentioned approval in prose only.\n> ").approvalRequired, false);
assert.equal(captureSignals("[Pasted text #1 +30 lines]\n> ").state, "paste_pending");
assert.equal(captureSignals("> [Pasted text #1 +46 lines]\n").state, "paste_pending");
assert.equal(captureSignals("Interrupted · What should Claude do instead?\n> ").state, "interrupted");
const quotedAttentionMarkers = [
  "● Exact examples from the UI:",
  "Usage limit reached soon",
  "[Pasted text #1 +30 lines]",
  "Interrupted · What should Claude do instead?",
  "✻ Worked for 2s",
  "> ",
].join("\n");
const quotedAttentionSignals = captureSignals(quotedAttentionMarkers);
assert.equal(quotedAttentionSignals.sessionLimitWarning, false);
assert.equal(quotedAttentionSignals.pastePlaceholder, false);
assert.equal(quotedAttentionSignals.interruptedPrompt, false);
assert.equal(quotedAttentionSignals.state, "idle");
const workspaceTrustScreen = "Do you trust the files in this folder?\nYes, I trust\nNo, exit\n> ";
assert.equal(captureSignals(workspaceTrustScreen).state, "workspace_trust_required");
const currentWorkspaceTrustScreen =
  "Quick safety check: Is this a project you created or one you trust?\n> 1. Yes, I trust this folder\n  2. No, exit";
assert.equal(captureSignals(currentWorkspaceTrustScreen).state, "workspace_trust_required");
assert.equal(captureSignals("Assistant quoted: Do you trust the files in this folder?\n> ").workspaceTrustPrompt, false);
const quotedTrustScreen = [
  "● The report quoted:",
  "Do you trust the files in this folder?",
  "Yes, I trust",
  "No, exit",
  "✻ Brewed for 1s",
  "> ",
].join("\n");
assert.equal(captureSignals(quotedTrustScreen).workspaceTrustPrompt, false);
assert.equal(captureSignals(quotedTrustScreen).state, "idle");
assert.equal(
  captureSignals(`${workspaceTrustScreen}\nDo you want to proceed?\nYes, and don't ask again`).state,
  "approval_required"
);
assert.equal(captureSignals("[managed session exited, code 0]\nDone").state, "exited");
assert.equal(captureSignals("https://claude.ai/code/session_abc123\n> ").remoteUrl, "https://claude.ai/code/session_abc123");
assert.equal(
  captureSignals("https://claude.ai/code/session_old\nhttps://claude.ai/code/session_current\n> ").remoteUrl,
  "https://claude.ai/code/session_current"
);
const ultracodeSignals = captureSignals(
  "Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)\n> "
);
assert.equal(ultracodeSignals.effortIndicator, "ultracode");
assert.equal(ultracodeSignals.effortEvidence, "terminal_heuristic");
assert.equal(ultracodeSignals.ultracodeActive, true);
assert.equal(ultracodeSignals.ultracodeUnavailable, false);
assert.equal(
  captureSignals("✦ ultracode · xhigh effort + dynamic workflows for maximum thoroughness").effortIndicator,
  "ultracode"
);
assert.equal(
  captureSignals("⎿  Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration")
    .ultracodeActive,
  true
);
const posture = launchPostureReport(
  { permissionMode: "default", model: null, effort: "xhigh", ultracode: true },
  { permissionMode: "manual", model: null, effort: "xhigh", ultracode: true },
  ultracodeSignals
);
assert.equal(posture.requested.permissionMode, "default");
assert.equal(posture.resolved.permissionMode, "manual");
assert.equal(posture.observed.effort, "ultracode");
assert.equal(posture.observed.ultracode, true);
assert.equal(posture.verification, "ultracode_observed_terminal_heuristic");
const sessionLogPosture = launchPostureReport(
  { permissionMode: "bypassPermissions", effort: "xhigh", ultracode: true },
  { permissionMode: "bypassPermissions", effort: "xhigh", ultracode: true },
  captureSignals("manual mode on\nCurrent effort level: medium\n> "),
  {
    permissionMode: "bypassPermissions",
    effort: "ultracode",
    ultracode: true,
    evidence: {
      permissionMode: "claude_session_log",
      effort: "claude_session_log",
      ultracode: "claude_session_log_correlated_with_resolved_launch",
    },
  }
);
assert.equal(sessionLogPosture.observed.permissionMode, "bypassPermissions");
assert.equal(sessionLogPosture.observed.effort, "ultracode");
assert.equal(sessionLogPosture.verification, "session_log_observed");
const persistedObservation = {
  permissionMode: "bypassPermissions",
  model: "claude-opus-5",
  effort: "xhigh",
  ultracode: true,
  evidence: {
    permissionMode: "claude_session_log",
    model: "claude_session_log",
    effort: "claude_session_log",
    ultracode: "claude_session_log_correlated_with_resolved_launch",
  },
};
assert.deepEqual(
  mergeObservedPosture(persistedObservation, {
    permissionMode: null,
    model: null,
    effort: null,
    ultracode: null,
    evidence: {
      permissionMode: "",
      model: "",
      effort: "",
      ultracode: "",
    },
  }),
  persistedObservation
);
const partialObservation = mergeObservedPosture(persistedObservation, {
  permissionMode: null,
  model: "claude-opus-6",
  effort: null,
  ultracode: false,
  evidence: {
    permissionMode: "",
    model: "claude_session_log",
    effort: "",
    ultracode: "claude_session_log",
  },
});
assert.equal(partialObservation.permissionMode, "bypassPermissions");
assert.equal(partialObservation.model, "claude-opus-6");
assert.equal(partialObservation.effort, "xhigh");
assert.equal(partialObservation.ultracode, false);
assert.equal(
  partialObservation.evidence.permissionMode,
  "claude_session_log"
);
const evidenceClearedWithValue = mergeObservedPosture(persistedObservation, {
  permissionMode: "manual",
  evidence: { permissionMode: "" },
});
assert.equal(evidenceClearedWithValue.permissionMode, "manual");
assert.equal(
  Object.hasOwn(evidenceClearedWithValue.evidence, "permissionMode"),
  false
);
assert.deepEqual(
  trustedSessionLogPosture({
    permissionMode: "manual",
    model: "claude-opus-5",
    effort: "xhigh",
    ultracode: true,
    evidence: {
      permissionMode: "terminal_heuristic",
      model: "claude_session_log",
      effort: "terminal_heuristic",
      ultracode: "claude_session_log_correlated_with_resolved_launch",
    },
  }),
  {
    permissionMode: null,
    model: "claude-opus-5",
    effort: null,
    ultracode: true,
    evidence: {
      model: "claude_session_log",
      ultracode: "claude_session_log_correlated_with_resolved_launch",
    },
  }
);
const postureSessionId = "99999999-9999-4999-8999-999999999999";
const postureLaunchMs = Date.parse("2026-07-29T12:00:00Z");
const currentLaunchObservation = runtimeObservationFromRecords(
  [
    {
      timestamp: "2026-07-29T11:00:00Z",
      sessionId: postureSessionId,
      permissionMode: "bypassPermissions",
    },
    {
      timestamp: "2026-07-29T11:00:01Z",
      sessionId: postureSessionId,
      effort: "xhigh",
      message: {
        role: "assistant",
        model: "claude-historical",
        content: [{ type: "text", text: "historical answer" }],
      },
    },
    {
      timestamp: "2026-07-29T12:00:01Z",
      sessionId: postureSessionId,
      permissionMode: "default",
    },
    {
      timestamp: "2026-07-29T12:00:02Z",
      sessionId: postureSessionId,
      effort: "high",
      message: {
        role: "assistant",
        model: "claude-current",
        content: [{ type: "text", text: "current answer" }],
      },
    },
  ],
  {
    resolvedSessionId: postureSessionId,
    startedAtMs: postureLaunchMs,
    resolvedPosture: { ultracode: false },
  }
);
assert.equal(currentLaunchObservation.permissionMode, "default");
assert.equal(currentLaunchObservation.model, "claude-current");
assert.equal(currentLaunchObservation.effort, "high");
assert.equal(currentLaunchObservation.ultracode, null);
const unavailableUltracodeSignals = captureSignals("Ultracode needs dynamic workflows enabled (see /config).\n> ");
assert.equal(unavailableUltracodeSignals.ultracodeUnavailable, true);
assert.equal(
  launchPostureReport({ ultracode: true }, { ultracode: true }, unavailableUltracodeSignals).verification,
  "ultracode_rejected_terminal_heuristic"
);
assert.equal(captureSignals("> Current effort level: ultracode").ultracodeActive, false);
assert.equal(captureSignals("> Ultracode needs dynamic workflows enabled (see /config).").ultracodeUnavailable, false);
assert.equal(captureSignals("> ✦ ultracode · xhigh effort + dynamic workflows").ultracodeActive, false);
assert.equal(captureSignals("> ⎿ Set effort level to ultracode").ultracodeActive, false);
const rejectionAfterActive = captureSignals(
  "✦ ultracode · xhigh effort + dynamic workflows\nUltracode needs dynamic workflows enabled (see /config).\n> "
);
assert.equal(rejectionAfterActive.ultracodeActive, false);
assert.equal(rejectionAfterActive.ultracodeUnavailable, true);
const activeAfterRejection = captureSignals(
  "Ultracode needs dynamic workflows enabled (see /config).\n✦ ultracode · xhigh effort + dynamic workflows\n> "
);
assert.equal(activeAfterRejection.ultracodeActive, true);
assert.equal(activeAfterRejection.ultracodeUnavailable, false);
const staleBusyCapture = `esc to interrupt\n${Array.from({ length: 81 }, (_, i) => `line ${i}`).join("\n")}\n> `;
assert.equal(captureSignals(staleBusyCapture).likelyBusy, false);
const completedWithStaleSpinnerCapture = [
  "esc to interrupt · ← for agents",
  "✻ Nebulizing...",
  "(4s · ↓ 1 tokens)● refreshed MCP smoke ok· Nebulizing... (5s · ↓ 1 tokens)",
  "> ",
  "✻ Brewed for 5s> ? for shortcuts · ← for agents /rc",
].join("\n");
assert.equal(captureSignals(completedWithStaleSpinnerCapture).likelyBusy, false);
assert.equal(captureSignals(completedWithStaleSpinnerCapture).state, "idle");
assert.equal(captureSignals("✻ Brewed for 5s\n> next request\n✽ Nebulizing...").likelyBusy, true);
const completedWithWorkedMarkerCapture = [
  "esc to interrupt · ← for agents",
  "✻ Dilly-dallying...",
  "(1s · ↓ 1 tokens)● refreshed signal smoke ok✽ Dilly-dallying... (1s · ↓ 1 tokens)",
  "> ",
  "✻ Worked for 2s> ? for shortcuts · ← for agents /rc",
].join("\n");
assert.equal(captureSignals(completedWithWorkedMarkerCapture).likelyBusy, false);
assert.equal(captureSignals("✻ Worked for 2s\n> next request\n✽ Dilly-dallying...").likelyBusy, true);
const completedWithCookedMarkerCapture = [
  "Bloviating…   ( 1s  ·  4 tokens )",
  "plan mode on (shift+tab to cycle)  ·  esc to interrupt",
  "claude: refreshed mcp ok",
  "Bloviating…   ( 1s  ·  4 tokens )",
  "plan mode on (shift+tab to cycle)  ·  esc to interrupt",
  "Cooked for 1s",
  "plan mode on (shift+tab to cycle)",
  "/rc",
].join("\n");
assert.equal(captureSignals(completedWithCookedMarkerCapture).likelyBusy, false);
assert.equal(captureSignals(completedWithCookedMarkerCapture).state, "idle");
const completedWithInlineCookedMarkerCapture = [
  "PR #3 · ← for agents",
  "Reply exactly: refreshed mcp loaded ok> Reply exactly: refreshed mcp loaded ok",
  "* Orchestrating… >  · esc to interrupt · ← for agents",
  "Ruminating…",
  "(1s · ↓ 1 tokens)● refreshed mcp loaded okRuminating…✻ Cogitated for 1s> ← for agents",
].join("\n");
assert.equal(captureSignals(completedWithInlineCookedMarkerCapture).likelyBusy, false);
assert.equal(captureSignals(completedWithInlineCookedMarkerCapture).state, "idle");
const completedWithNewVerbMarkerCapture = [
  "Blanching...   ( 2s  ·  4 tokens )",
  "plan mode on (shift+tab to cycle)  ·  esc to interrupt",
  "claude: parser idle ok",
  "Blanching...   ( 2s  ·  4 tokens )",
  "plan mode on (shift+tab to cycle)  ·  esc to interrupt",
  "Crunched for 2s",
  "plan mode on (shift+tab to cycle)",
  "/rc",
].join("\n");
assert.equal(captureSignals(completedWithNewVerbMarkerCapture).likelyBusy, false);
assert.equal(captureSignals(completedWithNewVerbMarkerCapture).state, "idle");
const completedAfterLongSpinnerCapture = [
  "✢ Consulting the rubber ducky about an unusually stubborn compiler error before lunch today…",
  "(2m 49s · 11.7k tokens)",
  "claude: long spinner complete",
  "✻ Cogitated for 2m 49s",
  "> ",
].join("\n");
assert.equal(captureSignals(completedAfterLongSpinnerCapture).likelyBusy, false);
assert.equal(captureSignals(completedAfterLongSpinnerCapture).state, "idle");
assert.equal(captureSignals("The phrase Created for 1s is just prose.\nesc to interrupt").likelyBusy, true);
assert.equal(captureSignals("Created for 1s is just prose.\nesc to interrupt").likelyBusy, true);
assert.equal(captureSignals("The phrase Created for 1s is just prose.\n> ").state, "idle");
assert.equal(captureSignals("manual mode on\n> ").permissionModeIndicator, "manual");

console.log("render-capture ok");
