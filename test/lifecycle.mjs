import assert from "node:assert/strict";
import { startupReadiness, withSessionOperationLock } from "../src/index.js";

const idleSignals = { state: "idle", ultracodeUnavailable: false };

assert.deepEqual(
  startupReadiness({
    stillRunning: false,
    signals: idleSignals,
    remoteUrl: "https://claude.ai/code/session_test",
    needsWorkspaceTrust: false,
    requestedUltracode: false,
  }),
  {
    status: "exited_during_startup",
    note: "Claude exited before Remote Control readiness could be confirmed.",
  }
);
assert.equal(
  startupReadiness({
    stillRunning: true,
    signals: idleSignals,
    remoteUrl: "",
    needsWorkspaceTrust: false,
    requestedUltracode: false,
  }).status,
  "remote_control_not_ready"
);
assert.equal(
  startupReadiness({
    stillRunning: true,
    signals: { state: "workspace_trust_required", ultracodeUnavailable: false },
    remoteUrl: "",
    needsWorkspaceTrust: true,
    requestedUltracode: false,
  }).status,
  "needs_workspace_trust"
);
assert.equal(
  startupReadiness({
    stillRunning: true,
    signals: { state: "idle", ultracodeUnavailable: true },
    remoteUrl: "https://claude.ai/code/session_test",
    needsWorkspaceTrust: false,
    requestedUltracode: true,
  }).status,
  "ultracode_attention_required"
);
assert.equal(
  startupReadiness({
    stillRunning: true,
    signals: idleSignals,
    remoteUrl: "https://claude.ai/code/session_test",
    needsWorkspaceTrust: false,
    requestedUltracode: false,
  }).status,
  "started"
);

const events = [];
let releaseFirst;
const firstGate = new Promise((resolve) => {
  releaseFirst = resolve;
});
const first = withSessionOperationLock("same-session", async () => {
  events.push("first-start");
  await firstGate;
  events.push("first-end");
});
const second = withSessionOperationLock("same-session", async () => {
  events.push("second-start");
  events.push("second-end");
});
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(events, ["first-start"]);
releaseFirst();
await Promise.all([first, second]);
assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);

await assert.rejects(
  withSessionOperationLock("error-session", async () => {
    throw new Error("expected lock failure");
  }),
  /expected lock failure/
);
await withSessionOperationLock("error-session", async () => {
  events.push("after-error");
});
assert.equal(events.at(-1), "after-error");

console.log("lifecycle ok");
