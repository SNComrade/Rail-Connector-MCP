#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import { assertFramedPromptText, createTerminalRenderer, workflowKeywordPrefixLength } from "./terminal.js";
import { verifyNodePtyFix } from "../tools/install-node-pty-fix.mjs";
import {
  WINDOWS_BROKER_PROTOCOL,
  WINDOWS_BROKER_VERSION,
  windowsBrokerLaunchPolicyFingerprint,
} from "./windows-broker-client.js";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const CAPTURE_BUFFER_LIMIT = 4 * 1024 * 1024;
const DEFAULT_TEXT_CHUNK_SIZE = 2048;
const DEFAULT_TEXT_CHUNK_DELAY_MS = 10;
const DEFAULT_SUBMIT_SETTLE_MS = 100;
const KEYWORD_MODE_OBSERVATION_MS = DEFAULT_SUBMIT_SETTLE_MS;
const REQUEST_READ_TIMEOUT_MS = 2000;
const MAX_BROKER_CONNECTIONS = 64;
const MAX_SLEEP_MS = 30_000;
// Explicit child-start budget within the client's existing 30s request window.
// The carried public option gives node-pty the same readiness contract; its
// unconfigured upstream 5s watchdog must not terminate a valid slower start.
const PTY_STARTUP_TIMEOUT_MS = 15000;
const COMPATIBILITY_INSPECTION_OPERATIONS = new Set([
  "ping",
  "status",
  "list",
  "shutdown",
  "acquireCleanupLease",
  "releaseCleanupLease",
  "cleanupStop",
]);
// A generation pair is optional for the established public API, whose
// name-selected operations retain backwards compatibility. Callers that
// already possess a generation/start pair can opt into this stricter broker
// contract. Keeping the distinction explicit lets an isolated controller fail
// closed without making an ordinary legacy operation discover a pair before it
// can acquire its initial lease.
const EXACT_PAIR_OPERATIONS = new Set([
  "acquireLease",
  "conditionalMetadata",
  "conditionalStopMetadata",
  "capture",
  "updateMetadata",
  "updateObservation",
  "releaseLease",
  "renewLease",
  "stop",
  "acquireCleanupLease",
  "releaseCleanupLease",
  "cleanupStop",
  "sendText",
  "sendKey",
]);
const sessions = new Map();
const operationLocks = new Map();

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const pipeName = argumentValue("--pipe");
const tokenFile = argumentValue("--token-file");
if (!pipeName || !tokenFile) {
  process.stderr.write("windows-broker requires --pipe and --token-file\n");
  process.exit(2);
}
const brokerToken = fs.readFileSync(tokenFile, "utf8").trim();
const launchPolicyFingerprint =
  windowsBrokerLaunchPolicyFingerprint(process.env);
if (brokerToken.length < 32) {
  process.stderr.write("windows-broker token is invalid\n");
  process.exit(2);
}
// A broker must not remain alive with cached unpatched modules and later accept
// an on-disk repair as proof of its loaded code. Refuse before serving any IPC;
// an operator's reviewed npm ci is followed by a fresh broker process.
verifyNodePtyFix();

function sleep(ms) {
  let delay = Number.isInteger(ms) ? ms : 0;
  if (delay < 0) delay = 0;
  if (delay > MAX_SLEEP_MS) delay = MAX_SLEEP_MS;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function clampInteger(value, fallback, min, max) {
  if (!Number.isInteger(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function trimRawBuffer(buffer) {
  if (buffer.length <= CAPTURE_BUFFER_LIMIT) return buffer;
  return buffer.slice(buffer.length - CAPTURE_BUFFER_LIMIT);
}

function textChunks(value, chunkSize) {
  const text = String(value);
  const size = clampInteger(chunkSize, DEFAULT_TEXT_CHUNK_SIZE, 256, 8192);
  const chunks = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + size);
    if (
      end < text.length &&
      end > start &&
      /[\uD800-\uDBFF]/.test(text[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(text[end])
    ) {
      end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function keySequence(key) {
  const keys = {
    Enter: "\r",
    Return: "\r",
    "C-m": "\r",
    "Ctrl-M": "\r",
    "C-j": "\r",
    "Ctrl-J": "\r",
    KPEnter: "\r",
    NumpadEnter: "\r",
    Escape: "\x1b",
    Esc: "\x1b",
    "C-c": "\x03",
    "Ctrl-C": "\x03",
    "C-d": "\x04",
    "Ctrl-D": "\x04",
    Tab: "\t",
    Backspace: "\x7f",
    Up: "\x1b[A",
    Down: "\x1b[B",
    Right: "\x1b[C",
    Left: "\x1b[D",
  };
  if (Object.hasOwn(keys, key)) return keys[key];
  const error = new Error(`Unsupported native Windows key name: ${key}`);
  error.code = "EINVAL";
  throw error;
}

async function withOperationLock(sessionName, operation) {
  const previous = operationLocks.get(sessionName) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  operationLocks.set(sessionName, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (operationLocks.get(sessionName) === current) operationLocks.delete(sessionName);
  }
}

function reportBrokerError(kind, error, fallbackCode) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : fallbackCode;
  // Error messages may contain prompts, paths or protocol data. Only a closed
  // diagnostic kind and sanitized code belong in the broker log.
  try { process.stderr.write(`windows-broker: ${kind} ${code}\n`); } catch {}
  return code;
}

function liveSession(sessionName) {
  const session = sessions.get(sessionName);
  return session && !session.exited ? session : null;
}

function activeLease(session) {
  if (session.lease && session.lease.expiresAt > Date.now()) return session.lease;
  session.lease = null;
  return null;
}

function assertMutationLease(session, leaseId) {
  const lease = activeLease(session);
  const requestedLeaseId = typeof leaseId === "string" ? leaseId : "";
  if (!lease || !requestedLeaseId || lease.id !== requestedLeaseId) {
    const error = new Error(
      lease
        ? "Managed session is leased by another MCP mutation workflow."
        : "Managed session mutation requires an active broker lease."
    );
    error.code = "ELEASE";
    throw error;
  }
}

function normalizedWindowsPath(value) {
  const resolved = path.resolve(String(value));
  try {
    return (fs.realpathSync.native?.(resolved) ?? fs.realpathSync(resolved)).toLowerCase();
  } catch {
    return resolved.toLowerCase();
  }
}

function validatedLaunchCwd(payload) {
  const requestedCwd = path.resolve(String(payload.cwd || ""));
  const expectedCanonicalCwd = String(payload.canonicalCwd || "");
  if (!expectedCanonicalCwd || !path.isAbsolute(expectedCanonicalCwd)) {
    const error = new Error(
      "Broker launch requires an absolute, caller-validated canonical cwd."
    );
    error.code = "ECWDPROVENANCE";
    throw error;
  }
  const stat = fs.statSync(requestedCwd);
  if (!stat.isDirectory()) {
    const error = new Error("Broker launch cwd must be a directory.");
    error.code = "ECWDUNAVAILABLE";
    throw error;
  }
  const canonicalCwd =
    fs.realpathSync.native?.(requestedCwd) ?? fs.realpathSync(requestedCwd);
  if (
    path.resolve(canonicalCwd).toLowerCase() !==
    path.resolve(expectedCanonicalCwd).toLowerCase()
  ) {
    const error = new Error(
      "Broker launch cwd no longer matches its validated canonical path."
    );
    error.code = "ECWDPROVENANCE";
    throw error;
  }
  return { requestedCwd, canonicalCwd };
}

function windowsCommandLineValue(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function validatedLaunchEnvironment(value) {
  if (value === null || value === undefined) return null;
  const validStatus = ["compatible", "blocking"].includes(value.status);
  const validEffort = [
    "unset",
    "compatible_xhigh",
    "blocking_non_xhigh",
  ].includes(value.effortOverrideStatus);
  const validBlockers =
    Array.isArray(value.blockers) &&
    value.blockers.length <= 2 &&
    value.blockers.every((blocker) =>
      ["non_xhigh_effort_override", "workflows_disabled"].includes(blocker)
    );
  if (
    !validStatus ||
    value.evidenceScope !== "claude_child_launch_environment" ||
    !validEffort ||
    typeof value.workflowsDisabled !== "boolean" ||
    !validBlockers
  ) {
    const error = new Error("Invalid Claude child launch environment metadata.");
    error.code = "ELAUNCHENV";
    throw error;
  }
  const launchSnapshot = {
    status: value.status,
    evidenceScope: "claude_child_launch_environment",
    effortOverrideStatus: value.effortOverrideStatus,
    workflowsDisabled: value.workflowsDisabled,
    blockers: [...new Set(value.blockers)].sort(),
    note:
      value.status === "blocking"
        ? "The captured Claude child launch environment contains an override that prevents the requested UltraCode workflow posture."
        : "No blocking UltraCode override was present in the captured Claude child launch environment. Claude settings can still differ.",
  };
  const expectedBlockers = [];
  if (launchSnapshot.effortOverrideStatus === "blocking_non_xhigh") {
    expectedBlockers.push("non_xhigh_effort_override");
  }
  if (launchSnapshot.workflowsDisabled) {
    expectedBlockers.push("workflows_disabled");
  }
  if (
    launchSnapshot.blockers.length !== value.blockers.length ||
    JSON.stringify(launchSnapshot.blockers) !== JSON.stringify(expectedBlockers) ||
    launchSnapshot.status !==
      (expectedBlockers.length ? "blocking" : "compatible")
  ) {
    const error = new Error("Inconsistent Claude child launch environment metadata.");
    error.code = "ELAUNCHENV";
    throw error;
  }
  return launchSnapshot;
}

function validatedPtyLaunch(payload) {
  const command = String(payload.command || "");
  const args = Array.isArray(payload.args) ? payload.args.map(String) : [];
  const metadataCommand = String(payload.metadataCommand || command);
  const metadataArgs = Array.isArray(payload.metadataArgs)
    ? payload.metadataArgs.map(String)
    : args;
  if (
    !command ||
    !metadataCommand ||
    metadataArgs.length > 200 ||
    metadataArgs.some((value) => value.length > 4096)
  ) {
    const error = new Error("Invalid Claude launch descriptor.");
    error.code = "ELAUNCHCOMMAND";
    throw error;
  }

  const configuredCommand = process.env.RAIL_CONNECTOR_CLAUDE_PATH;
  const metadataAllowed = configuredCommand
    ? normalizedWindowsPath(metadataCommand) === normalizedWindowsPath(configuredCommand)
    : /^claude(?:\.exe|\.cmd|\.bat)?$/i.test(path.basename(metadataCommand));
  if (!metadataAllowed) {
    const error = new Error(
      configuredCommand
        ? "Broker launch command does not match RAIL_CONNECTOR_CLAUDE_PATH."
        : "Broker launch command must resolve to the Claude executable."
    );
    error.code = "ELAUNCHCOMMAND";
    throw error;
  }

  const extension = path.extname(metadataCommand).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    const commandProcessor =
      process.env.ComSpec ||
      (process.env.SystemRoot
        ? path.join(process.env.SystemRoot, "System32", "cmd.exe")
        : "cmd.exe");
    const innerCommandLine = [
      windowsCommandLineValue(metadataCommand),
      ...metadataArgs.map(windowsCommandLineValue),
    ].join(" ");
    const expectedCommandLine = `/d /s /v:off /c "${innerCommandLine}"`;
    if (
      normalizedWindowsPath(command) !== normalizedWindowsPath(commandProcessor) ||
      args.length !== 0 ||
      payload.commandLine !== expectedCommandLine
    ) {
      const error = new Error("Invalid Claude batch-wrapper launch descriptor.");
      error.code = "ELAUNCHCOMMAND";
      throw error;
    }
    return { command, ptyArgs: expectedCommandLine, metadataCommand, metadataArgs };
  }

  if (
    payload.commandLine !== undefined ||
    normalizedWindowsPath(command) !== normalizedWindowsPath(metadataCommand) ||
    args.length !== metadataArgs.length ||
    args.some((value, index) => value !== metadataArgs[index])
  ) {
    const error = new Error("Claude launch descriptor command and metadata do not match.");
    error.code = "ELAUNCHCOMMAND";
    throw error;
  }
  return { command, ptyArgs: args, metadataCommand, metadataArgs };
}

async function captureSession(session, lines = 120) {
  const capture = await session.renderer.capture(clampInteger(lines, 120, 20, 1000));
  return session.exited ? `[managed session exited, code ${session.exitCode}]\n${capture}` : capture;
}

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validatedFreshLaunchSessionId(payload, launch) {
  const freshSessionId = payload.freshSessionId;
  if (freshSessionId === undefined || freshSessionId === null) return null;
  const resolvedSessionId = payload.resolvedSessionId;
  if (
    !isUuid(freshSessionId) ||
    freshSessionId !== resolvedSessionId ||
    !isUuid(resolvedSessionId)
  ) {
    const error = new Error(
      "A fresh Claude session id must be the exact UUID supplied as the resolved session id."
    );
    error.code = "ESESSIONIDENTITY";
    throw error;
  }
  const sessionIdPositions = launch.metadataArgs
    .map((argument, index) => argument === "--session-id" ? index : -1)
    .filter((index) => index >= 0);
  if (
    sessionIdPositions.length !== 1 ||
    launch.metadataArgs[sessionIdPositions[0] + 1] !== freshSessionId
  ) {
    const error = new Error(
      "A fresh Claude session id requires exactly one matching --session-id launch argument."
    );
    error.code = "ESESSIONIDENTITY";
    throw error;
  }
  const hasContinuationArgument = launch.metadataArgs.some((argument) =>
    /^(?:--resume|--continue|--fork(?:-session)?)(?:=|$)/i.test(argument)
  );
  if (hasContinuationArgument) {
    const error = new Error(
      "A fresh Claude session identity cannot be combined with resume, continue, or fork arguments."
    );
    error.code = "ESESSIONIDENTITY";
    throw error;
  }
  return freshSessionId;
}

function validatedStartMetadata(payload, launch) {
  const leaseId = typeof payload.leaseId === "string" ? payload.leaseId : "";
  if (!leaseId) {
    const error = new Error("Starting a managed session requires a broker lease id.");
    error.code = "ELEASE";
    throw error;
  }
  return {
    leaseId,
    launchEnvironment: validatedLaunchEnvironment(payload.launchEnvironment),
    freshSessionId: validatedFreshLaunchSessionId(payload, launch),
  };
}

function sessionMetadata(sessionName, session) {
  return {
    name: sessionName,
    cwd: session.cwd,
    canonicalCwd: session.canonicalCwd,
    generationId: session.generationId,
    startedAt: session.startedAt,
    startedAtMs: session.startedAtMs,
    pid: session.pid,
    command: session.command,
    args: session.args,
    requestedPosture: session.requestedPosture ?? null,
    resolvedPosture: session.resolvedPosture ?? null,
    launchEnvironment: session.launchEnvironment ?? null,
    resolvedSessionId: session.resolvedSessionId ?? null,
    snapshotIdentityBinding: session.snapshotIdentityBinding ?? null,
    observedPosture: session.observedPosture ?? null,
    recoveryOnly: Boolean(session.recoveryOnly),
    ...(session.terminalErrorCode ? { terminalErrorCode: session.terminalErrorCode } : {}),
    exited: session.exited,
    exitCode: session.exitCode,
  };
}

function assertExpectedGeneration(
  sessionName,
  session,
  expectedStartedAtMs,
  expectedGenerationId
) {
  if (
    (expectedGenerationId !== null &&
      expectedGenerationId !== undefined &&
      String(expectedGenerationId) !== session.generationId) ||
    (expectedStartedAtMs !== null &&
      expectedStartedAtMs !== undefined &&
      Number(expectedStartedAtMs) !== session.startedAtMs)
  ) {
    const error = new Error(
      `Managed session generation changed for ${sessionName}; refusing a stale operation.`
    );
    error.code = "ESTALE";
    throw error;
  }
}

function assertCompleteExpectedGeneration(sessionName, session, payload, operation) {
  if (
    typeof payload.expectedGenerationId !== "string" ||
    payload.expectedGenerationId.length === 0 ||
    !Number.isSafeInteger(payload.expectedStartedAtMs)
  ) {
    const error = new Error(`${operation} requires a complete generation binding.`);
    error.code = "EINVAL";
    throw error;
  }
  if (!session) {
    const error = new Error(
      `Managed session generation changed for ${sessionName}; refusing a stale ${operation}.`
    );
    error.code = "ESTALE";
    throw error;
  }
  assertExpectedGeneration(
    sessionName,
    session,
    payload.expectedStartedAtMs,
    payload.expectedGenerationId
  );
}

function assertRequiredExactGeneration(sessionName, session, payload, operation) {
  if (payload.requireExactPair !== true) return;
  assertCompleteExpectedGeneration(sessionName, session, payload, operation);
}

function canonicalCwdForExactStop(session) {
  let currentCanonicalCwd;
  try {
    currentCanonicalCwd =
      fs.realpathSync.native?.(session.cwd) ?? fs.realpathSync(session.cwd);
  } catch {
    const error = new Error("Managed session cwd is unavailable for an exact stop.");
    error.code = "ECWDUNAVAILABLE";
    throw error;
  }
  if (
    path.resolve(currentCanonicalCwd).toLowerCase() !==
    path.resolve(session.canonicalCwd).toLowerCase()
  ) {
    const error = new Error("Managed session cwd no longer matches its start-time canonical provenance.");
    error.code = "ECWDPROVENANCE";
    throw error;
  }
  return currentCanonicalCwd;
}

function assertExpectedStopIdentity(sessionName, session, payload) {
  const hasSessionId =
    payload.expectedResolvedSessionId !== undefined &&
    payload.expectedResolvedSessionId !== null;
  const hasCwd =
    payload.expectedCanonicalCwd !== undefined &&
    payload.expectedCanonicalCwd !== null;
  if (!hasSessionId && !hasCwd) return null;
  if (!hasSessionId || !hasCwd) {
    const error = new Error("Exact stop identity requires both resolved session id and canonical cwd.");
    error.code = "EINVAL";
    throw error;
  }
  assertCompleteExpectedGeneration(sessionName, session, payload, "Exact stop identity");
  if (
    !isUuid(payload.expectedResolvedSessionId) ||
    session.resolvedSessionId !== payload.expectedResolvedSessionId
  ) {
    const error = new Error("Managed session identity changed; refusing a stale stop.");
    error.code = "ESTALE";
    throw error;
  }
  if (
    typeof payload.expectedCanonicalCwd !== "string" ||
    !path.isAbsolute(payload.expectedCanonicalCwd)
  ) {
    const error = new Error("Exact stop identity requires an absolute canonical cwd.");
    error.code = "EINVAL";
    throw error;
  }
  const canonicalCwd = canonicalCwdForExactStop(session);
  if (
    path.resolve(canonicalCwd).toLowerCase() !==
    path.resolve(payload.expectedCanonicalCwd).toLowerCase()
  ) {
    const error = new Error("Managed session identity changed; refusing a stale stop.");
    error.code = "ESTALE";
    throw error;
  }
  return {
    generationId: session.generationId,
    startedAtMs: session.startedAtMs,
    resolvedSessionId: session.resolvedSessionId,
    canonicalCwd,
  };
}

function assertRecoveryGeneration(sessionName, session, payload) {
  if (!session.recoveryOnly) return;
  if (
    typeof payload.expectedGenerationId !== "string" ||
    payload.expectedGenerationId.length === 0 ||
    !Number.isSafeInteger(payload.expectedStartedAtMs)
  ) {
    const error = new Error(
      `Session ${sessionName} is recovery-only (after a terminal error, stop timeout or interrupted keyword send); stop it with its exact expectedGenerationId and expectedStartedAtMs.`
    );
    error.code = "EINVAL";
    throw error;
  }
  assertExpectedGeneration(
    sessionName,
    session,
    payload.expectedStartedAtMs,
    payload.expectedGenerationId
  );
}

function assertOptionalExactGeneration(sessionName, session, payload) {
  const hasGeneration = payload.expectedGenerationId !== undefined &&
    payload.expectedGenerationId !== null;
  const hasStart = payload.expectedStartedAtMs !== undefined &&
    payload.expectedStartedAtMs !== null;
  if (!hasGeneration && !hasStart) return;
  if (
    !hasGeneration || !hasStart ||
    typeof payload.expectedGenerationId !== "string" ||
    payload.expectedGenerationId.length === 0 ||
    !Number.isSafeInteger(payload.expectedStartedAtMs)
  ) {
    const error = new Error("A lease release requires a complete generation binding.");
    error.code = "EINVAL";
    throw error;
  }
  if (!session) {
    const error = new Error(
      `Managed session generation changed for ${sessionName}; refusing a stale lease release.`
    );
    error.code = "ESTALE";
    throw error;
  }
  assertExpectedGeneration(
    sessionName,
    session,
    payload.expectedStartedAtMs,
    payload.expectedGenerationId
  );
}

async function waitForExit(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!session.exited && Date.now() < deadline) await sleep(50);
  return session.exited;
}

async function stopSession(
  sessionName,
  { graceful = false, force = false, omitCapture = false } = {}
) {
  const session = sessions.get(sessionName);
  if (!session) return { status: "not_running", managedSession: sessionName };
  if (session.exited) {
    const exitCode = session.exitCode;
    await session.renderer.dispose();
    sessions.delete(sessionName);
    return { status: "not_running", managedSession: sessionName, exitCode };
  }

  if (!graceful && !force) {
    return {
      status: "stop_blocked",
      reason: "stop_mode_required",
      managedSession: sessionName,
    };
  }

  const capture = omitCapture ? "" : await captureSession(session, 120);
  if (graceful) {
    session.ptyProcess.write("/exit\r");
    if (await waitForExit(session, 2500)) {
      const exitCode = session.exitCode;
      await session.renderer.dispose();
      sessions.delete(sessionName);
      return { status: "stopped", managedSession: sessionName, exitCode, graceful: true };
    }
  }
  if (!force && graceful) {
    return {
      status: "graceful_stop_timeout",
      managedSession: sessionName,
      ...(omitCapture ? {} : { capture }),
      note: "Claude did not exit after /exit. Retry with force=true only after confirming the session can be terminated.",
    };
  }
  try {
    session.ptyProcess.kill();
  } catch {
    // The process exited between checks.
  }
  // Do not add a separate PID-only taskkill fallback if node-pty cannot
  // confirm exit. The caller must bind its own exact process for recovery.
  await waitForExit(session, 1500);
  if (!(await waitForExit(session, 4000))) {
    session.lease = null;
    session.recoveryOnly = true;
    return {
      status: "stop_timeout",
      managedSession: sessionName,
      recoveryOnly: true,
      expectedGenerationId: session.generationId,
      expectedStartedAtMs: session.startedAtMs,
      ...(omitCapture ? {} : { capture }),
      note: "Claude did not confirm exit after ConPTY termination. The session remains tracked for exact-owned recovery: name-only calls are refused, so retry stop_remote_control with these expectedGenerationId and expectedStartedAtMs values.",
    };
  }
  const exitCode = session.exitCode;
  await session.renderer.dispose();
  sessions.delete(sessionName);
  return { status: "stopped", managedSession: sessionName, exitCode, graceful: false };
}

async function startSession(
  sessionName,
  payload,
  launch = validatedPtyLaunch(payload),
  launchCwd = validatedLaunchCwd(payload),
  launchMetadata = validatedStartMetadata(payload, launch)
) {
  const { requestedCwd, canonicalCwd } = launchCwd;
  const { leaseId, launchEnvironment, freshSessionId } = launchMetadata;
  const renderer = createTerminalRenderer({
    cols: clampInteger(payload.cols, 140, 40, 400),
    rows: clampInteger(payload.rows, 40, 10, 200),
    scrollback: clampInteger(payload.scrollback, 4000, 100, 20000),
  });
  let ptyProcess;
  try {
    ptyProcess = pty.spawn(launch.command, launch.ptyArgs, {
      name: "xterm-256color",
      // The bundled backend avoids node-pty's deferred console-list fork and
      // numeric-PID termination. The exact dependency includes the native
      // handle-registry synchronization fix; never fall back to system ConPTY.
      useConptyDll: true,
      conptyConnectionTimeout: PTY_STARTUP_TIMEOUT_MS,
      cols: clampInteger(payload.cols, 140, 40, 400),
      rows: clampInteger(payload.rows, 40, 10, 200),
      cwd: canonicalCwd,
      env: { ...(payload.env || process.env), FORCE_COLOR: "1" },
    });
  } catch (error) {
    await renderer.dispose();
    throw error;
  }
  const session = {
    ptyProcess,
    renderer,
    rawBuffer: "",
    exitCode: null,
    exited: false,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    generationId: randomUUID(),
    cwd: requestedCwd,
    canonicalCwd,
    command: launch.metadataCommand,
    pid: Number.isSafeInteger(ptyProcess.pid) && ptyProcess.pid > 0 ? ptyProcess.pid : null,
    args: launch.metadataArgs,
    requestedPosture: payload.requestedPosture ?? null,
    resolvedPosture: payload.resolvedPosture ?? null,
    launchEnvironment,
    resolvedSessionId: payload.resolvedSessionId ?? null,
    freshSessionId,
    snapshotIdentityBinding: null,
    observedPosture: payload.observedPosture ?? null,
    lease: {
      id: leaseId,
      expiresAt:
        Date.now() + clampInteger(payload.leaseTtlMs, 120000, 5000, 300000),
    },
  };
  const onTerminalError = (error) => {
    if (!session.terminalErrorCode) {
      session.terminalErrorCode = reportBrokerError("terminal_error", error, "EPTY");
    }
    // A failed output channel is not child-exit proof. Preserve the generation,
    // lease and PTY for exact-owned stop until numeric exit evidence arrives.
    session.recoveryOnly = true;
  };
  ptyProcess.on("error", onTerminalError);
  // In the pinned Windows backend Terminal.on delegates to the output socket.
  // Its separate input socket has no upstream error listener. Keep this
  // private-interface access guarded; inert PTY doubles expose the same shape.
  try {
    const inputSocket = ptyProcess._agent?.inSocket;
    if (!inputSocket || typeof inputSocket.on !== "function" ||
        typeof inputSocket.write !== "function" || typeof inputSocket.destroy !== "function") {
      onTerminalError({ code: "EPTYINPUT" });
    } else {
      inputSocket.on("error", onTerminalError);
    }
  } catch (error) { onTerminalError(error); }
  renderer.onData((data) => {
    if (!session.exited && !session.terminalErrorCode) session.ptyProcess.write(data);
  });
  renderer.onBinary((data) => {
    if (!session.exited && !session.terminalErrorCode) session.ptyProcess.write(data);
  });
  const observePid = () => {
    const pid = ptyProcess.pid;
    if (session.pid === null && Number.isSafeInteger(pid) && pid > 0) session.pid = pid;
  };
  ptyProcess.onData((data) => {
    observePid();
    session.rawBuffer = trimRawBuffer(session.rawBuffer + data);
    void renderer.write(data);
  });
  ptyProcess.onExit(({ exitCode }) => {
    observePid();
    // An output-socket close can emit onExit before the native child exits.
    // After a channel fault, an undefined code is not child-exit evidence.
    if (session.terminalErrorCode && !Number.isInteger(exitCode)) return;
    if (!session.exited) {
      session.exitCode = exitCode;
      session.exited = true;
    }
  });
  sessions.set(sessionName, session);
  // node-pty connects asynchronously after its output worker becomes ready.
  // Keep the original generation owned while renderer replies unblock the
  // terminal handshake; do not publish a successful start with a PID of zero.
  const startupDeadline = performance.now() + PTY_STARTUP_TIMEOUT_MS;
  while (session.pid === null && !session.exited && performance.now() < startupDeadline) {
    observePid();
    if (session.pid !== null) break;
    await sleep(10);
  }
  observePid();
  if (session.pid === null && !session.exited) {
    session.recoveryOnly = true;
    session.lease = null;
    // Public kill can be deferred until first data. It is a cancellation
    // request, not exit proof: retain the PTY, renderer and exact binding so
    // any late child remains tracked and replacement/shutdown stays blocked.
    let stopError;
    try { ptyProcess.kill(); } catch (error) { stopError = error; }
    const error = new Error(
      `Native Windows terminal startup did not confirm a process. The original generation remains recovery-only; inspect status and stop with expectedGenerationId=${session.generationId}, expectedStartedAtMs=${session.startedAtMs}.`,
      stopError ? { cause: stopError } : undefined
    );
    error.code = "EPTYSTARTUP";
    throw error;
  }
  return { status: "started", metadata: sessionMetadata(sessionName, session) };
}

let brokerDraining = false;
let brokerShutdownCommitted = false;
let inFlightOperationCount = 0;
const drainWaiters = new Set();

function notifyDrained() {
  if (inFlightOperationCount !== 0) return;
  for (const resolve of drainWaiters) resolve();
  drainWaiters.clear();
}

async function waitForOperationsToDrain() {
  if (inFlightOperationCount === 0) return;
  await new Promise((resolve) => drainWaiters.add(resolve));
}

async function beginBrokerShutdown() {
  if (brokerDraining) {
    const error = new Error("Windows broker shutdown is already in progress.");
    error.code = "ESHUTDOWN";
    throw error;
  }
  brokerDraining = true;
  try {
    await waitForOperationsToDrain();
    const running = [...sessions.values()].filter(
      (session) => !session.exited
    );
    if (running.length > 0) {
      throw new Error(
        "Refusing to shut down the Windows broker while managed Claude sessions are running."
      );
    }
    brokerShutdownCommitted = true;
    setImmediate(() => server.close(() => process.exit(0)));
    return { status: "shutting_down", pid: process.pid };
  } catch (error) {
    if (!brokerShutdownCommitted) brokerDraining = false;
    throw error;
  }
}

async function dispatchOperation(operation, payload) {
  if (operation === "shutdown") return beginBrokerShutdown();
  if (brokerDraining) {
    const error = new Error("Windows broker is draining for shutdown.");
    error.code = "ESHUTDOWN";
    throw error;
  }
  inFlightOperationCount += 1;
  try {
    return await handleOperation(operation, payload);
  } finally {
    inFlightOperationCount -= 1;
    notifyDrained();
  }
}

async function handleOperation(operation, payload) {
  if (operation === "ping") {
    return {
      protocol: WINDOWS_BROKER_PROTOCOL,
      version: WINDOWS_BROKER_VERSION,
      launchPolicyFingerprint,
      pid: process.pid,
    };
  }
  if (operation === "status" || operation === "list") {
    return {
      protocol: WINDOWS_BROKER_PROTOCOL,
      version: WINDOWS_BROKER_VERSION,
      launchPolicyFingerprint,
      pid: process.pid,
      managedSessions: [...sessions.entries()].map(([name, session]) => sessionMetadata(name, session)),
    };
  }
  const sessionName = String(payload.sessionName || "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionName)) throw new Error(`Invalid managed session name: ${sessionName}`);

  return withOperationLock(sessionName, async () => {
    if (payload.requireExactPair !== undefined && typeof payload.requireExactPair !== "boolean") {
      const error = new Error("requireExactPair must be a boolean.");
      error.code = "EINVAL";
      throw error;
    }
    // Do this under the same per-session lock as the operation, and before an
    // absent/exited session can be turned into a legacy name-only result. A
    // strict caller therefore never downgrades an exact-pair request into a
    // `not_running` or compatibility-cleanup response.
    if (payload.requireExactPair === true && EXACT_PAIR_OPERATIONS.has(operation)) {
      const session = sessions.get(sessionName);
      assertRequiredExactGeneration(sessionName, session, payload, operation);
    }
    if (operation === "acquireCleanupLease") {
      const session = sessions.get(sessionName);
      if (!session) return { status: "not_running" };
      assertRecoveryGeneration(sessionName, session, payload);
      const leaseId = String(payload.leaseId || "");
      if (!leaseId) {
        const error = new Error(
          "Compatibility cleanup requires a broker lease id."
        );
        error.code = "ELEASE";
        throw error;
      }
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      const lease = activeLease(session);
      if (lease && lease.id !== leaseId) {
        return {
          status: "busy",
          expiresAt: lease.expiresAt,
          generationId: session.generationId,
          startedAtMs: session.startedAtMs,
        };
      }
      session.lease = {
        id: leaseId,
        expiresAt:
          Date.now() +
          clampInteger(payload.ttlMs, 120000, 5000, 300000),
      };
      return {
        status: "acquired",
        expiresAt: session.lease.expiresAt,
        generationId: session.generationId,
        startedAtMs: session.startedAtMs,
      };
    }
    if (operation === "releaseCleanupLease") {
      const session = sessions.get(sessionName);
      assertOptionalExactGeneration(sessionName, session, payload);
      if (session?.lease?.id === payload.leaseId) session.lease = null;
      return { status: "released" };
    }
    if (operation === "cleanupStop") {
      const session = sessions.get(sessionName);
      if (!session) {
        return { status: "not_running", managedSession: sessionName };
      }
      assertRecoveryGeneration(sessionName, session, payload);
      assertMutationLease(session, payload.leaseId);
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      return stopSession(sessionName, {
        graceful: false,
        force: true,
        omitCapture: true,
      });
    }
    if (operation === "acquireLease") {
      const session = sessions.get(sessionName);
      if (!session || (session.exited && !payload.expectedGenerationId)) {
        if (payload.expectedGenerationId) {
          const error = new Error(
            `Managed session generation changed for ${sessionName}; refusing a stale lease acquisition.`
          );
          error.code = "ESTALE";
          throw error;
        }
        return { status: "not_running" };
      }
      // A caller holding the exact original pair may remove an exited
      // generation. This must not turn into a name-only lease on a replacement.
      if (session.exited && !Number.isSafeInteger(payload.expectedStartedAtMs)) {
        const error = new Error("An exited generation requires its exact start timestamp.");
        error.code = "EINVAL";
        throw error;
      }
      assertRecoveryGeneration(sessionName, session, payload);
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      const lease = activeLease(session);
      if (lease && lease.id !== payload.leaseId) {
        return {
          status: "busy",
          expiresAt: lease.expiresAt,
          generationId: session.generationId,
          startedAtMs: session.startedAtMs,
        };
      }
      session.lease = {
        id: String(payload.leaseId),
        expiresAt: Date.now() + clampInteger(payload.ttlMs, 120000, 5000, 300000),
      };
      return {
        status: "acquired",
        expiresAt: session.lease.expiresAt,
        generationId: session.generationId,
        startedAtMs: session.startedAtMs,
      };
    }
    if (operation === "releaseLease") {
      const session = sessions.get(sessionName);
      assertOptionalExactGeneration(sessionName, session, payload);
      if (session?.lease?.id === payload.leaseId) session.lease = null;
      return { status: "released" };
    }
    if (operation === "renewLease") {
      const session = sessions.get(sessionName);
      if (!session || session.exited) return { status: "not_running" };
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      const lease = activeLease(session);
      if (!lease || lease.id !== payload.leaseId) return { status: "lost" };
      lease.expiresAt =
        Date.now() + clampInteger(payload.ttlMs, 120000, 5000, 300000);
      return { status: "renewed", expiresAt: lease.expiresAt };
    }
    if (operation === "start") {
      const launch = validatedPtyLaunch(payload);
      const launchCwd = validatedLaunchCwd(payload);
      verifyNodePtyFix();
      const existing = sessions.get(sessionName);
      if (existing && !existing.exited) {
        return {
          status: "already_running",
          metadata: sessionMetadata(sessionName, existing),
          capture: await captureSession(existing, 100),
        };
      }
      if (existing) {
        await existing.renderer.dispose();
        sessions.delete(sessionName);
      }
      return startSession(sessionName, payload, launch, launchCwd);
    }
    if (operation === "replace") {
      const launch = validatedPtyLaunch(payload);
      const existing = sessions.get(sessionName);
      if (existing && !existing.exited) {
        assertRecoveryGeneration(sessionName, existing, payload);
      }
      if (existing && !existing.exited) assertMutationLease(existing, payload.leaseId);
      if (existing) {
        assertExpectedGeneration(
          sessionName,
          existing,
          payload.expectedStartedAtMs,
          payload.expectedGenerationId
        );
      }
      const launchCwd = validatedLaunchCwd(payload);
      const launchMetadata = validatedStartMetadata(payload, launch);
      // Fail deterministic dependency preflight before stopping an existing
      // generation, just as for invalid replacement launch metadata.
      verifyNodePtyFix();
      if (existing) {
        const stopResult = await stopSession(sessionName, {
          graceful: Boolean(payload.graceful),
          force: Boolean(payload.force),
        });
        if (!["stopped", "not_running"].includes(stopResult.status)) {
          return { status: "replace_failed", stopResult };
        }
      }
      return startSession(sessionName, payload, launch, launchCwd, launchMetadata);
    }

    const session = sessions.get(sessionName);
    if (!session) throw new Error(`No managed native Windows Claude session found: ${sessionName}`);

    if (operation === "conditionalMetadata") {
      if (
        !payload.expectedGenerationId ||
        !Number.isSafeInteger(payload.expectedStartedAtMs)
      ) {
        const error = new Error("Conditional metadata requires a complete generation binding.");
        error.code = "EINVAL";
        throw error;
      }
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      return { metadata: sessionMetadata(sessionName, session) };
    }
    if (operation === "conditionalStopMetadata") {
      if (!session.exited) assertMutationLease(session, payload.leaseId);
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      const boundIdentity = assertExpectedStopIdentity(sessionName, session, payload);
      return {
        metadata: sessionMetadata(sessionName, session),
        ...(boundIdentity ? { boundIdentity } : {}),
      };
    }
    if (operation === "capture") {
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      return {
        capture: await captureSession(session, payload.lines),
        ...(payload.includeCursorStyle === true
          ? { cursorLineStyle: await session.renderer.cursorLineStyle() }
          : {}),
      };
    }
    if (operation === "bindWorkflowSnapshotIdentity") {
      if (session.exited || session.recoveryOnly) {
        const error = new Error(
          "Workflow snapshot identity binding requires a healthy running managed session."
        );
        error.code = "ERECOVERY";
        throw error;
      }
      assertMutationLease(session, payload.leaseId);
      assertCompleteExpectedGeneration(
        sessionName,
        session,
        payload,
        "Workflow snapshot identity binding"
      );
      if (session.snapshotIdentityBinding) {
        const error = new Error(
          "Workflow snapshot identity is already bound for this managed session generation."
        );
        error.code = "EBOUND";
        throw error;
      }
      const requestedSessionId = payload.requestedSessionId;
      const resolvedSessionId = payload.resolvedSessionId;
      if (
        !session.freshSessionId ||
        requestedSessionId !== session.freshSessionId ||
        resolvedSessionId !== session.freshSessionId ||
        session.resolvedSessionId !== session.freshSessionId
      ) {
        const error = new Error(
          "Workflow snapshot identity binding requires the exact fresh launched Claude session id."
        );
        error.code = "ESESSIONIDENTITY";
        throw error;
      }
      if (
        typeof payload.logFileIdentity !== "string" ||
        payload.logFileIdentity.trim().length === 0
      ) {
        const error = new Error(
          "Workflow snapshot identity binding requires a stable nonempty log file identity."
        );
        error.code = "EINVAL";
        throw error;
      }
      session.snapshotIdentityBinding = {
        generationId: session.generationId,
        startedAtMs: session.startedAtMs,
        resolvedSessionId: session.resolvedSessionId,
        logFileIdentity: payload.logFileIdentity,
        mode: "fresh",
      };
      return {
        status: "bound",
        metadata: sessionMetadata(sessionName, session),
      };
    }
    if (operation === "updateMetadata") {
      assertMutationLease(session, payload.leaseId);
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      if (payload.resolvedSessionId) {
        const nextResolvedSessionId = String(payload.resolvedSessionId);
        if (
          session.snapshotIdentityBinding &&
          nextResolvedSessionId !== session.resolvedSessionId
        ) {
          const error = new Error(
            "Resolved Claude session id is immutable after workflow snapshot identity binding."
          );
          error.code = "EBOUND";
          throw error;
        }
        session.resolvedSessionId = nextResolvedSessionId;
      }
      if (payload.requestedPosture) session.requestedPosture = payload.requestedPosture;
      if (payload.resolvedPosture) session.resolvedPosture = payload.resolvedPosture;
      if (payload.launchEnvironment) {
        session.launchEnvironment = validatedLaunchEnvironment(
          payload.launchEnvironment
        );
      }
      if (payload.observedPosture) session.observedPosture = payload.observedPosture;
      return { status: "updated", metadata: sessionMetadata(sessionName, session) };
    }
    if (operation === "updateObservation") {
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      if (payload.observedPosture) {
        session.observedPosture = payload.observedPosture;
      }
      return {
        status: "updated",
        metadata: sessionMetadata(sessionName, session),
      };
    }
    if (operation === "stop") {
      assertRecoveryGeneration(sessionName, session, payload);
      if (!session.exited) assertMutationLease(session, payload.leaseId);
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      const boundIdentity = assertExpectedStopIdentity(sessionName, session, payload);
      const result = await stopSession(sessionName, payload);
      return {
        ...result,
        ...(boundIdentity && result.status === "stopped" && result.graceful === true
          ? { boundIdentity }
          : {}),
      };
    }
    if (!liveSession(sessionName)) {
      throw new Error(`Managed native Windows Claude session has exited: ${sessionName}`);
    }
    // A terminal fault or exit can arrive while this serialized operation is
    // awaiting pacing/renderer work. Recheck the captured generation and lease
    // after every await and immediately before every prompt/key write.
    const assertSendable = () => {
      if (sessions.get(sessionName) !== session) {
        const error = new Error(`Managed session generation changed for ${sessionName}; refusing a stale send.`);
        error.code = "ESTALE";
        throw error;
      }
      if (session.recoveryOnly || session.terminalErrorCode) {
        const error = new Error("Recovery-only session (after a terminal error, stop timeout or interrupted keyword send) accepts only an exact-generation stop.");
        error.code = "ERECOVERY";
        throw error;
      }
      if (session.exited) {
        throw new Error(`Managed native Windows Claude session has exited: ${sessionName}`);
      }
      assertExpectedGeneration(sessionName, session, payload.expectedStartedAtMs, payload.expectedGenerationId);
      assertMutationLease(session, payload.leaseId);
    };
    const writeToSession = (text) => {
      assertSendable();
      session.ptyProcess.write(text);
    };
    if (operation === "sendText") {
      assertSendable();
      if (payload.keywordPrefix !== undefined && typeof payload.keywordPrefix !== "boolean") {
        const error = new Error("keywordPrefix must be a boolean.");
        error.code = "EINVAL";
        throw error;
      }
      for (const field of ["bracketedPaste", "requireBracketedPaste"]) {
        if (payload[field] !== undefined && typeof payload[field] !== "boolean") {
          const error = new Error(`${field} must be a boolean.`);
          error.code = "EINVAL";
          throw error;
        }
      }
      if (payload.requireBracketedPaste && !payload.bracketedPaste) {
        const error = new Error("Strict framing requires bracketedPaste.");
        error.code = "EINVAL";
        throw error;
      }
      const prefixLength = payload.keywordPrefix ? workflowKeywordPrefixLength(payload.text) : 0;
      if (payload.bracketedPaste && !prefixLength) assertFramedPromptText(payload.text);
      const chunks = textChunks(prefixLength ? payload.text.slice(prefixLength) : payload.text, payload.chunkSize);
      const delayMs = clampInteger(payload.chunkDelayMs, DEFAULT_TEXT_CHUNK_DELAY_MS, 0, 250);
      // A keyword body must leave a real observation window between PTY
      // chunks so a bracketed-paste mode change reaches the renderer before the
      // next chunk. A 10 ms window was too short on loaded hosted Windows
      // runners; use the same window as the prefix settle.
      const keywordChunkDelayMs = prefixLength
        ? Math.max(delayMs, KEYWORD_MODE_OBSERVATION_MS)
        : delayMs;
      if (payload.bracketedPaste) {
        await session.renderer.flush();
        assertSendable();
      }
      let bracketedPasteUsed =
        Boolean(payload.bracketedPaste) && session.renderer.bracketedPasteMode;
      if (prefixLength && !bracketedPasteUsed) {
        const error = new Error("Keyword delivery requires active bracketed-paste support; no input was sent.");
        error.code = "EPASTEMODE";
        throw error;
      }
      if (payload.bracketedPaste && !bracketedPasteUsed &&
          (payload.requireBracketedPaste || /[\t\r\n]/.test(payload.text))) {
        const error = new Error("Bracketed paste is unavailable; no input was sent.");
        error.code = "EPASTEMODE";
        throw error;
      }
      if (prefixLength) {
        // Both segments and the final Enter stay inside one generation-bound
        // operation/lease. Only caller-selected, unchanged prefix bytes are literal.
        writeToSession(payload.text.slice(0, prefixLength));
        await sleep(DEFAULT_SUBMIT_SETTLE_MS);
        assertSendable();
        await session.renderer.flush();
        assertSendable();
        bracketedPasteUsed =
          Boolean(payload.bracketedPaste) && session.renderer.bracketedPasteMode;
        if (!bracketedPasteUsed) {
          session.recoveryOnly = true;
          const error = new Error(
            "Keyword prefix was sent, but bracketed-paste support changed before the body; no body or Enter was sent. This generation is recovery-only; inspect the composer before retrying."
          );
          error.code = "EPASTEMODE";
          throw error;
        }
      }
      if (bracketedPasteUsed) writeToSession("\x1b[200~");
      for (let index = 0; index < chunks.length; index += 1) {
        writeToSession(chunks[index]);
        if (prefixLength) {
          // Yield after every body chunk, including when the requested pacing
          // delay is zero, so pending terminal mode output is observed before
          // another chunk, a closing frame, or Enter can be sent.
          await sleep(keywordChunkDelayMs);
          assertSendable();
          await session.renderer.flush();
          assertSendable();
          if (!session.renderer.bracketedPasteMode) {
            session.recoveryOnly = true;
            const error = new Error(
              "Keyword body was partially sent, but bracketed-paste support changed; no later body, closing frame, or Enter was sent. This generation is recovery-only."
            );
            error.code = "EPASTEMODE";
            throw error;
          }
        } else if ((delayMs > 0 || bracketedPasteUsed) && index + 1 < chunks.length) {
          await sleep(delayMs);
          assertSendable();
          if (bracketedPasteUsed) {
            await session.renderer.flush();
            assertSendable();
            if (!session.renderer.bracketedPasteMode) {
              session.recoveryOnly = true;
              const error = new Error("Framed body was partially sent, but bracketed-paste support changed; no later body, closing frame, or Enter was sent. This generation is recovery-only.");
              error.code = "EPASTEMODE";
              throw error;
            }
          }
        }
      }
      if (bracketedPasteUsed) {
        await session.renderer.flush();
        assertSendable();
        if (!session.renderer.bracketedPasteMode) {
          session.recoveryOnly = true;
          const error = new Error(
            `${prefixLength ? "Keyword" : "Framed"} body was sent, but bracketed-paste support changed before the closing frame; no closing frame or Enter was sent. This generation is recovery-only.`
          );
          error.code = "EPASTEMODE";
          throw error;
        }
      }
      if (bracketedPasteUsed) writeToSession("\x1b[201~");
      if (payload.submit) {
        await sleep(clampInteger(payload.submitSettleMs, DEFAULT_SUBMIT_SETTLE_MS, 50, 500));
        assertSendable();
        if (bracketedPasteUsed) {
          await session.renderer.flush();
          assertSendable();
          if (!session.renderer.bracketedPasteMode) {
            session.recoveryOnly = true;
            const error = new Error(
              `${prefixLength ? "Keyword" : "Framed"} body and closing frame were sent, but bracketed-paste support changed before Enter; no Enter was sent. This generation is recovery-only.`
            );
            error.code = "EPASTEMODE";
            throw error;
          }
        }
        writeToSession("\r");
      }
      await sleep(400);
      assertSendable();
      return {
        status: "sent",
        bracketedPasteRequested: Boolean(payload.bracketedPaste),
        bracketedPasteUsed,
        ...(prefixLength ? { literalPrefixCharacters: prefixLength } : {}),
      };
    }
    if (operation === "sendKey") {
      assertSendable();
      writeToSession(keySequence(payload.key));
      await sleep(400);
      assertSendable();
      return { status: "sent" };
    }
    throw new Error(`Unsupported Windows broker operation: ${operation}`);
  });
}

const server = net.createServer((socket) => {
  socket.on("error", (error) => {
    reportBrokerError("client_socket_error", error, "ESOCKET");
    socket.destroy();
  });
  socket.setEncoding("utf8");
  socket.setTimeout(REQUEST_READ_TIMEOUT_MS);
  socket.on("timeout", () => socket.destroy());
  let request = "";
  let processing = false;
  socket.on("data", (chunk) => {
    request += chunk;
    if (Buffer.byteLength(request, "utf8") > MAX_REQUEST_BYTES) {
      socket.destroy();
      return;
    }
    const newline = request.indexOf("\n");
    if (newline < 0 || processing) return;
    processing = true;
    socket.setTimeout(0);
    void respond(request.slice(0, newline));
  });

  const respond = async (messageText) => {
    try {
      const message = JSON.parse(messageText);
      if (message.protocol !== WINDOWS_BROKER_PROTOCOL) throw new Error("Unsupported Windows broker protocol.");
      if (message.token !== brokerToken) throw new Error("Windows broker authentication failed.");
      const compatibleClient =
        message.clientVersion === WINDOWS_BROKER_VERSION &&
        message.launchPolicyFingerprint === launchPolicyFingerprint;
      if (
        !compatibleClient &&
        !COMPATIBILITY_INSPECTION_OPERATIONS.has(message.operation)
      ) {
        const error = new Error(
          "Windows broker build or Claude launch policy does not match this client."
        );
        error.code = "EBROKERUPGRADE";
        throw error;
      }
      const result = await dispatchOperation(
        message.operation,
        message.payload || {}
      );
      socket.end(`${JSON.stringify({ ok: true, result })}\n`);
    } catch (error) {
      socket.end(
        `${JSON.stringify({
          ok: false,
          code: error.code || "EBROKER",
          error: error.message,
        })}\n`
      );
    }
  };
});
server.maxConnections = MAX_BROKER_CONNECTIONS;

server.on("error", (error) => {
  process.stderr.write(`windows-broker: ${error.message}\n`);
  process.exit(1);
});

server.listen(pipeName);
