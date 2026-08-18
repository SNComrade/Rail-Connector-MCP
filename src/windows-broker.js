#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import { createTerminalRenderer } from "./terminal.js";
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
const REQUEST_READ_TIMEOUT_MS = 2000;
const MAX_BROKER_CONNECTIONS = 64;
const MAX_SLEEP_MS = 30_000;
const COMPATIBILITY_INSPECTION_OPERATIONS = new Set([
  "ping",
  "status",
  "list",
  "shutdown",
  "acquireCleanupLease",
  "releaseCleanupLease",
  "cleanupStop",
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
    blockers: [...new Set(value.blockers)],
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
    const expectedCommandLine = `/d /s /c "${innerCommandLine}"`;
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
    observedPosture: session.observedPosture ?? null,
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
    (expectedGenerationId &&
      String(expectedGenerationId) !== session.generationId) ||
    (!expectedGenerationId &&
      expectedStartedAtMs !== null &&
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

async function waitForExit(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!session.exited && Date.now() < deadline) await sleep(50);
  return session.exited;
}

async function forceKillProcessTree(pid) {
  await new Promise((resolve) => {
    const child = spawnChild(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" }
    );
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, 5000);
    child.once("error", finish);
    child.once("exit", finish);
  });
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
  if (!(await waitForExit(session, 1500))) {
    await forceKillProcessTree(session.pid);
  }
  if (!(await waitForExit(session, 4000))) {
    session.lease = null;
    return {
      status: "stop_timeout",
      managedSession: sessionName,
      ...(omitCapture ? {} : { capture }),
      note: "Claude did not confirm exit after ConPTY termination and taskkill /T /F. The session remains tracked and can be retried.",
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
  launchCwd = validatedLaunchCwd(payload)
) {
  const leaseId = typeof payload.leaseId === "string" ? payload.leaseId : "";
  if (!leaseId) {
    const error = new Error("Starting a managed session requires a broker lease id.");
    error.code = "ELEASE";
    throw error;
  }
  const { requestedCwd, canonicalCwd } = launchCwd;
  const renderer = createTerminalRenderer({
    cols: clampInteger(payload.cols, 140, 40, 400),
    rows: clampInteger(payload.rows, 40, 10, 200),
    scrollback: clampInteger(payload.scrollback, 4000, 100, 20000),
  });
  let ptyProcess;
  try {
    ptyProcess = pty.spawn(launch.command, launch.ptyArgs, {
      name: "xterm-256color",
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
    pid: ptyProcess.pid,
    args: launch.metadataArgs,
    requestedPosture: payload.requestedPosture ?? null,
    resolvedPosture: payload.resolvedPosture ?? null,
    launchEnvironment: validatedLaunchEnvironment(payload.launchEnvironment),
    resolvedSessionId: payload.resolvedSessionId ?? null,
    observedPosture: payload.observedPosture ?? null,
    lease: {
      id: leaseId,
      expiresAt:
        Date.now() + clampInteger(payload.leaseTtlMs, 120000, 5000, 300000),
    },
  };
  renderer.onData((data) => {
    if (!session.exited) session.ptyProcess.write(data);
  });
  renderer.onBinary((data) => {
    if (!session.exited) session.ptyProcess.write(data);
  });
  ptyProcess.onData((data) => {
    session.rawBuffer = trimRawBuffer(session.rawBuffer + data);
    void renderer.write(data);
  });
  ptyProcess.onExit(({ exitCode }) => {
    session.exitCode = exitCode;
    session.exited = true;
  });
  sessions.set(sessionName, session);
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
    if (operation === "acquireCleanupLease") {
      const session = sessions.get(sessionName);
      if (!session) return { status: "not_running" };
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
      if (session?.lease?.id === payload.leaseId) session.lease = null;
      return { status: "released" };
    }
    if (operation === "cleanupStop") {
      const session = sessions.get(sessionName);
      if (!session) {
        return { status: "not_running", managedSession: sessionName };
      }
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
      if (!session || session.exited) {
        if (payload.expectedGenerationId) {
          const error = new Error(
            `Managed session generation changed for ${sessionName}; refusing a stale lease acquisition.`
          );
          error.code = "ESTALE";
          throw error;
        }
        return { status: "not_running" };
      }
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
      if (session?.lease?.id === payload.leaseId) session.lease = null;
      return { status: "released" };
    }
    if (operation === "renewLease") {
      const session = sessions.get(sessionName);
      if (!session || session.exited) return { status: "not_running" };
      const lease = activeLease(session);
      if (!lease || lease.id !== payload.leaseId) return { status: "lost" };
      lease.expiresAt =
        Date.now() + clampInteger(payload.ttlMs, 120000, 5000, 300000);
      return { status: "renewed", expiresAt: lease.expiresAt };
    }
    if (operation === "start") {
      const launch = validatedPtyLaunch(payload);
      const launchCwd = validatedLaunchCwd(payload);
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
      if (existing) {
        const stopResult = await stopSession(sessionName, {
          graceful: Boolean(payload.graceful),
          force: Boolean(payload.force),
        });
        if (!["stopped", "not_running"].includes(stopResult.status)) {
          return { status: "replace_failed", stopResult };
        }
      }
      return startSession(sessionName, payload, launch, launchCwd);
    }

    const session = sessions.get(sessionName);
    if (!session) throw new Error(`No managed native Windows Claude session found: ${sessionName}`);

    if (operation === "capture") {
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      return { capture: await captureSession(session, payload.lines) };
    }
    if (operation === "updateMetadata") {
      assertMutationLease(session, payload.leaseId);
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      if (payload.resolvedSessionId) session.resolvedSessionId = String(payload.resolvedSessionId);
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
      if (!session.exited) assertMutationLease(session, payload.leaseId);
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      return stopSession(sessionName, payload);
    }
    if (!liveSession(sessionName)) {
      throw new Error(`Managed native Windows Claude session has exited: ${sessionName}`);
    }
    if (operation === "sendText") {
      assertMutationLease(session, payload.leaseId);
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      const chunks = textChunks(payload.text, payload.chunkSize);
      const delayMs = clampInteger(payload.chunkDelayMs, DEFAULT_TEXT_CHUNK_DELAY_MS, 0, 250);
      const bracketedPasteUsed =
        Boolean(payload.bracketedPaste) && session.renderer.bracketedPasteMode;
      if (bracketedPasteUsed) session.ptyProcess.write("\x1b[200~");
      for (let index = 0; index < chunks.length; index += 1) {
        session.ptyProcess.write(chunks[index]);
        if (delayMs > 0 && index + 1 < chunks.length) await sleep(delayMs);
      }
      if (bracketedPasteUsed) session.ptyProcess.write("\x1b[201~");
      if (payload.submit) {
        await sleep(clampInteger(payload.submitSettleMs, DEFAULT_SUBMIT_SETTLE_MS, 50, 500));
        session.ptyProcess.write("\r");
      }
      await sleep(400);
      return {
        status: "sent",
        bracketedPasteRequested: Boolean(payload.bracketedPaste),
        bracketedPasteUsed,
      };
    }
    if (operation === "sendKey") {
      assertMutationLease(session, payload.leaseId);
      assertExpectedGeneration(
        sessionName,
        session,
        payload.expectedStartedAtMs,
        payload.expectedGenerationId
      );
      session.ptyProcess.write(keySequence(payload.key));
      await sleep(400);
      return { status: "sent" };
    }
    throw new Error(`Unsupported Windows broker operation: ${operation}`);
  });
}

const server = net.createServer((socket) => {
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
