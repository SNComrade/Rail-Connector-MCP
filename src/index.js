#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  railConnectorStateDir,
  probeWindowsBroker,
  windowsBrokerCleanupRequest,
  windowsBrokerRequest,
} from "./windows-broker-client.js";

export { renderCapture } from "./terminal.js";

const execFileAsync = promisify(execFile);
const HOME = os.homedir();
const CLAUDE_CONFIG_DIR = path.resolve(
  process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude")
);
const DEFAULT_CWD = HOME;
const DEFAULT_MANAGED_SESSION = "rail-connector-managed";
const DEFAULT_REMOTE_NAME = "Rail-Connector";
export const SERVER_VERSION = "1.0.0-beta.2";
const IS_NATIVE_WINDOWS = process.platform === "win32";
const REMOTE_URL_RE = /https:\/\/claude\.ai\/code\/[A-Za-z0-9_:-]+/;
const DEFAULT_TEXT_CHUNK_SIZE = 2048;
const DEFAULT_TEXT_CHUNK_DELAY_MS = 10;
const DEFAULT_SUBMIT_RETRY_DELAY_MS = 1200;
const SUBMIT_RETRY_VISIBILITY_POLLS = 4;
const MCP_PROCESS_STARTED_AT = new Date().toISOString();
const MAX_SESSION_SUMMARY_BYTES = 25 * 1024 * 1024;
const SESSION_LIST_BYTE_BUDGET = 128 * 1024 * 1024;
const DEFAULT_SESSION_QUERY_SCAN_LIMIT = 200;
const SESSION_SUMMARY_HEAD_BYTES = 1024 * 1024;
const MIN_SESSION_SUMMARY_BYTES = 1024;
const CLAUDE_PERMISSION_MODES = ["default", "manual", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"];
const VERSION_SENSITIVE_PERMISSION_MODES = ["manual"];
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const ULTRACODE_SETTINGS_JSON = JSON.stringify({ ultracode: true });
const ULTRACODE_DIRECT_VERSION_FLOOR = [2, 1, 203];
const ULTRACODE_DOCUMENTATION_URL =
  "https://code.claude.com/docs/en/settings#available-settings";
const TMUX_LAUNCH_METADATA_OPTION = "@rail_connector_launch";
const ALLOWED_ROOTS_ENV = "RAIL_CONNECTOR_ALLOWED_ROOTS";
const CLAUDE_COMMAND_ENV = "RAIL_CONNECTOR_CLAUDE_PATH";
const TMUX_COMMAND_ENV = "RAIL_CONNECTOR_TMUX_PATH";
const BYPASS_POLICY_ENV = "RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS";
const BYPASS_ISOLATED_POLICY_VALUE = "I_UNDERSTAND_THIS_REQUIRES_ISOLATION";
const BYPASS_LOCAL_HOST_POLICY_VALUE = "I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS";
const ARCHIVE_STATE_VALUES = ["active", "archived", "all"];
const SESSION_ID_RE =
  /^(?:00000000-0000-0000-0000-000000000000|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/;
const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens"]);
const NO_ASSISTANT_CURSOR = "rail:no-assistant:v1";
const PORTABLE_WAIT_CURSOR_PREFIX = "rail:v2:";
const WAIT_ATTENTION_STATES = new Set([
  "exited",
  "limit_warning",
  "approval_required",
  "interrupted",
  "workspace_trust_required",
  "paste_pending",
]);
const WAIT_STRONG_ATTENTION_STATES = new Set([
  "exited",
  "approval_required",
  "interrupted",
  "workspace_trust_required",
]);
const SUBMIT_KEY_NAMES = new Set([
  "Enter",
  "Return",
  "C-m",
  "Ctrl-M",
  "C-j",
  "Ctrl-J",
  "KPEnter",
  "NumpadEnter",
]);
const MAX_TRANSCRIPT_ASSISTANT_CHARS = 128 * 1024;
const BROKER_LEASE_TTL_MS = 120000;
const BROKER_LEASE_RENEW_INTERVAL_MS = 30000;
const CLAUDE_CAPABILITY_CACHE_TTL_MS = 60 * 1000;
const MAX_CLAUDE_CAPABILITY_CACHE_ENTRIES = 8;
const CLAUDE_CHILD_ENVIRONMENT_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_DISABLE_WORKFLOWS",
];
const BROKER_UNAVAILABLE_CODES = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
]);
const PENDING_TURN_ANCHOR_TTL_MS = 15 * 60 * 1000;
const pendingTurnAnchors = new Map();

function brokerUnavailable(error) {
  return BROKER_UNAVAILABLE_CODES.has(error?.code);
}
const sessionOperationLocks = new Map();
const brokerMutationLeases = new Map();
const claudeCapabilityCache = new Map();

function text(data) {
  const value = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text: value }] };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withSessionOperationLock(sessionName, operation) {
  const previous = sessionOperationLocks.get(sessionName) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  sessionOperationLocks.set(sessionName, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sessionOperationLocks.get(sessionName) === current) sessionOperationLocks.delete(sessionName);
  }
}

function clampInteger(value, fallback, min, max) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function assertSafeSessionId(sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid Claude session id: ${sessionId}`);
  }
}

// Managed session names are used verbatim as tmux `-t` targets, where ':' and
// '.' (and '@') are session:window.pane / window-id separators. Restrict to a
// charset that is safe on both the tmux backend and the Windows Map key.
export function assertSafeManagedSessionName(name) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) {
    throw new Error(`Invalid managed session name: ${name}`);
  }
}

export function managedSessionName(input) {
  const name =
    input.tmuxSession && (!input.managedSession || input.managedSession === DEFAULT_MANAGED_SESSION)
      ? input.tmuxSession
      : input.managedSession ?? DEFAULT_MANAGED_SESSION;
  assertSafeManagedSessionName(name);
  return name;
}

function normalizeForPathCompare(value) {
  const resolved = fs.realpathSync.native?.(value) ?? fs.realpathSync(value);
  return IS_NATIVE_WINDOWS ? resolved.toLowerCase() : resolved;
}

function normalizeAbsoluteForPathCompare(value) {
  const resolved = path.resolve(value);
  return IS_NATIVE_WINDOWS ? resolved.toLowerCase() : resolved;
}

function pathIsWithinRoot(normalizedRoot, normalizedTarget) {
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function configuredCwdRoots() {
  const raw = process.env[ALLOWED_ROOTS_ENV];
  if (!raw) return null;
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

function cwdAllowedRoots() {
  const configured = configuredCwdRoots();
  if (configured === null) return null;
  const existing = configured.filter((entry) => {
    try {
      return fs.existsSync(entry) && fs.statSync(entry).isDirectory();
    } catch {
      return false;
    }
  });
  if (configured.length > 0 && existing.length === 0) {
    throw new Error(
      `${ALLOWED_ROOTS_ENV} is set, but none of its entries are existing directories. Fix or unset ${ALLOWED_ROOTS_ENV} before starting Rail Connector.`
    );
  }
  return existing;
}

export function resolveAllowedCwd(cwd = DEFAULT_CWD) {
  const resolved = path.resolve(cwd);
  if (!fs.existsSync(resolved)) {
    const error = new Error(`cwd does not exist: ${resolved}`);
    error.code = "ECWDUNAVAILABLE";
    throw error;
  }
  const roots = cwdAllowedRoots();
  if (roots === null) return resolved;

  const normalizedCwd = normalizeForPathCompare(resolved);
  const allowed = roots.some((root) => {
    const normalizedRoot = normalizeForPathCompare(root);
    return pathIsWithinRoot(normalizedRoot, normalizedCwd);
  });
  if (!allowed) {
    const error = new Error(
      `cwd is outside ${ALLOWED_ROOTS_ENV}: ${resolved}. Set ${ALLOWED_ROOTS_ENV} to allowed project root paths or use an allowed cwd.`
    );
    error.code = "EOUTOFSCOPE";
    throw error;
  }
  return resolved;
}

export function resolveAllowedManagedCwd(cwd, canonicalCwd) {
  const resolved = resolveAllowedCwd(cwd);
  if (!canonicalCwd) {
    const error = new Error(
      `cwd canonical provenance is unavailable: ${resolved}`
    );
    error.code = "ECWDPROVENANCE";
    throw error;
  }
  const currentCanonical = normalizeForPathCompare(resolved);
  const expectedCanonical = normalizeAbsoluteForPathCompare(canonicalCwd);
  if (currentCanonical !== expectedCanonical) {
    const error = new Error(
      `cwd canonical provenance changed: ${resolved}`
    );
    error.code = "ECWDPROVENANCE";
    throw error;
  }
  return resolved;
}

export function resolveAllowedPersistedCwd(cwd, canonicalCwd = null) {
  const resolved = path.resolve(cwd);
  if (fs.existsSync(resolved)) {
    return resolveAllowedManagedCwd(resolved, canonicalCwd);
  }
  return resolveAllowedCleanupCwd(resolved, canonicalCwd);
}

export function resolveAllowedCleanupCwd(cwd, canonicalCwd = null) {
  const resolved = path.resolve(cwd);
  const roots = cwdAllowedRoots();
  if (roots === null) return resolved;

  if (!canonicalCwd) {
    const error = new Error(
      `cwd canonical provenance is unavailable for cleanup: ${resolved}`
    );
    error.code = "ECWDPROVENANCE";
    throw error;
  }
  const normalizedCwd = normalizeAbsoluteForPathCompare(canonicalCwd);
  const allowed = roots.some((root) =>
    pathIsWithinRoot(normalizeForPathCompare(root), normalizedCwd)
  );
  if (!allowed) {
    const error = new Error(
      `cwd is outside ${ALLOWED_ROOTS_ENV}: ${resolved}. Set ${ALLOWED_ROOTS_ENV} to allowed project root paths or use an allowed cwd.`
    );
    error.code = "EOUTOFSCOPE";
    throw error;
  }
  return resolved;
}

export function projectDirFromCwd(cwd = DEFAULT_CWD) {
  const resolved = resolveAllowedCwd(cwd);
  const canonical =
    fs.realpathSync.native?.(resolved) ?? fs.realpathSync(resolved);
  const encoded = canonical.replace(/[^A-Za-z0-9]/g, "-");
  return path.join(CLAUDE_CONFIG_DIR, "projects", encoded);
}

function firstTextFromMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function createSessionSummaryState() {
  return {
    titleCandidates: {
      "ai-title": "",
      "agent-name": "",
      "custom-title": "",
    },
    remoteUrl: "",
    remoteUrlUpdatedAt: "",
    firstUserPrompt: "",
    lastUserPrompt: "",
    lastAssistantText: "",
    messageCount: 0,
    lastTimestamp: "",
    permissionMode: "",
    model: "",
    effort: "",
    workflowLaunchObserved: false,
    workflowLaunchStatus: "",
    workflowLaunchUpdatedAt: "",
    pendingWorkflowCount: null,
    pendingWorkflowUpdatedAt: "",
    activeWorkflowTaskIds: new Set(),
    unidentifiedPendingWorkflowCount: 0,
    searchTextParts: [],
  };
}

const WORKFLOW_LAUNCH_STATUSES = new Set([
  "async_launched",
  "launched",
  "running",
  "completed",
  "succeeded",
]);
const WORKFLOW_PENDING_LAUNCH_STATUSES = new Set([
  "async_launched",
  "launched",
  "running",
]);
const WORKFLOW_TERMINAL_RETRIEVAL_STATUSES = new Set([
  "success",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "interrupted",
]);
const WORKFLOW_TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "succeeded",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "interrupted",
]);

async function withManagedMutationLock(
  sessionName,
  operation,
  { allowMissingBackend = false } = {}
) {
  return withSessionOperationLock(sessionName, async () => {
    if (!IS_NATIVE_WINDOWS) return operation();
    const leaseId = randomUUID();
    const deadline = Date.now() + 30000;
    let leaseReservedForStart = false;
    let hasBrokerLease = false;
    let queuedGenerationId = null;
    for (;;) {
      let result;
      try {
        result = await windowsBrokerRequest(
          "acquireLease",
          {
            sessionName,
            leaseId,
            ttlMs: BROKER_LEASE_TTL_MS,
            expectedGenerationId: queuedGenerationId,
          },
          { startIfMissing: false }
        );
      } catch (error) {
        if (error?.code === "EBROKERUPGRADE" && allowMissingBackend) {
          result = await windowsBrokerRequest(
            "acquireLease",
            {
              sessionName,
              leaseId,
              ttlMs: BROKER_LEASE_TTL_MS,
              expectedGenerationId: queuedGenerationId,
            },
            { startIfMissing: true }
          );
        } else if (brokerUnavailable(error)) {
          if (allowMissingBackend) {
            brokerMutationLeases.set(sessionName, leaseId);
            leaseReservedForStart = true;
            hasBrokerLease = true;
          }
          break;
        } else {
          throw error;
        }
      }
      if (!queuedGenerationId && result.generationId) {
        queuedGenerationId = result.generationId;
      }
      if (result.status === "acquired") {
        brokerMutationLeases.set(sessionName, leaseId);
        hasBrokerLease = true;
        break;
      }
      if (result.status === "not_running") {
        if (allowMissingBackend) {
          brokerMutationLeases.set(sessionName, leaseId);
          leaseReservedForStart = true;
          hasBrokerLease = true;
        }
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for another MCP mutation workflow on ${sessionName}.`);
      }
      await sleep(150);
    }
    let renewalError = null;
    let renewalPromise = Promise.resolve();
    const renewalTimer = hasBrokerLease ? setInterval(() => {
      if (
        renewalError ||
        brokerMutationLeases.get(sessionName) !== leaseId
      ) {
        return;
      }
      renewalPromise = renewalPromise.then(async () => {
        try {
          const result = await windowsBrokerRequest(
            "renewLease",
            { sessionName, leaseId, ttlMs: BROKER_LEASE_TTL_MS },
            { startIfMissing: false, timeoutMs: 5000 }
          );
          if (
            result.status !== "renewed" &&
            !(leaseReservedForStart && result.status === "not_running")
          ) {
            const error = new Error(
              `Lost the cross-MCP mutation lease for ${sessionName}.`
            );
            error.code = "ELEASE";
            renewalError = error;
          } else if (result.status === "renewed") {
            leaseReservedForStart = false;
          }
        } catch (error) {
          renewalError = error;
        }
      });
    }, BROKER_LEASE_RENEW_INTERVAL_MS) : null;
    renewalTimer?.unref?.();
    try {
      const result = await operation();
      await renewalPromise;
      if (renewalError) throw renewalError;
      return result;
    } finally {
      if (renewalTimer) clearInterval(renewalTimer);
      await renewalPromise;
      if (brokerMutationLeases.get(sessionName) === leaseId) {
        brokerMutationLeases.delete(sessionName);
        try {
          await windowsBrokerRequest(
            "releaseLease",
            { sessionName, leaseId },
            { startIfMissing: false, timeoutMs: 5000 }
          );
        } catch {
          // The broker or session may have exited with the operation.
        }
      }
    }
  });
}

function currentSessionTitle(state) {
  for (const source of ["custom-title", "agent-name", "ai-title"]) {
    const title = state.titleCandidates[source];
    if (title) return { title, titleSource: source };
  }
  return { title: "", titleSource: "" };
}

function recordMatchesSession(record, expectedSessionId) {
  if (!expectedSessionId) return true;
  const primarySessionId = record.sessionId;
  if (
    primarySessionId !== null &&
    primarySessionId !== undefined &&
    primarySessionId !== ""
  ) {
    return primarySessionId === expectedSessionId;
  }
  const fallbackSessionId = record.session_id;
  return (
    fallbackSessionId === null ||
    fallbackSessionId === undefined ||
    fallbackSessionId === "" ||
    fallbackSessionId === expectedSessionId
  );
}

function conversationMessageFromRecord(record) {
  const role = record.message?.role;
  if (role !== "user" && role !== "assistant") return null;
  if (record.isMeta === true) return null;
  if (record.isSidechain === true) return null;
  if (role === "assistant" && record.message?.model === "<synthetic>") return null;
  const body = firstTextFromMessage(record.message);
  return body ? { role, body } : null;
}

function addSessionRecord(
  state,
  record,
  expectedSessionId = "",
  includeConversationText = true
) {
  if (!recordMatchesSession(record, expectedSessionId)) return;
  if (record.isSidechain === true) return;
  if (record.timestamp) state.lastTimestamp = record.timestamp;
  if (record.type === "ai-title" && typeof record.aiTitle === "string") {
    state.titleCandidates["ai-title"] = record.aiTitle.trim();
  }
  if (record.type === "agent-name" && typeof record.agentName === "string") {
    state.titleCandidates["agent-name"] = record.agentName.trim();
  }
  if (record.type === "custom-title" && typeof record.customTitle === "string") {
    state.titleCandidates["custom-title"] = record.customTitle.trim();
  }
  if (record.type === "system" && record.subtype === "bridge_status" && record.url) {
    state.remoteUrl = record.url;
    state.remoteUrlUpdatedAt = record.timestamp ?? "";
  }
  if (record.type === "permission-mode" && record.permissionMode) {
    state.permissionMode = String(record.permissionMode);
  }
  if (record.permissionMode) state.permissionMode = String(record.permissionMode);
  if (
    record.message?.role === "assistant" &&
    record.isMeta !== true &&
    record.isSidechain !== true &&
    record.message?.model !== "<synthetic>"
  ) {
    if (record.message?.model) state.model = String(record.message.model);
    if (record.effort) state.effort = String(record.effort);
  }
  const workflowResult = record.toolUseResult;
  if (
    workflowResult?.taskType === "local_workflow" &&
    typeof workflowResult.workflowName === "string" &&
    workflowResult.workflowName.trim() &&
    WORKFLOW_LAUNCH_STATUSES.has(workflowResult.status)
  ) {
    state.workflowLaunchObserved = true;
    state.workflowLaunchStatus = workflowResult.status;
    state.workflowLaunchUpdatedAt = record.timestamp ?? "";
    if (WORKFLOW_PENDING_LAUNCH_STATUSES.has(workflowResult.status)) {
      const workflowTaskId =
        typeof workflowResult.taskId === "string" && workflowResult.taskId
          ? workflowResult.taskId
          : "";
      if (workflowTaskId) state.activeWorkflowTaskIds.add(workflowTaskId);
      else state.unidentifiedPendingWorkflowCount += 1;
      state.pendingWorkflowCount = Math.max(
        state.pendingWorkflowCount ?? 0,
        state.activeWorkflowTaskIds.size +
          state.unidentifiedPendingWorkflowCount
      );
      state.pendingWorkflowUpdatedAt = record.timestamp ?? "";
    }
  }
  const pendingWorkflowCount =
    record.pendingWorkflowCount ?? workflowResult?.pendingWorkflowCount;
  if (Number.isInteger(pendingWorkflowCount) && pendingWorkflowCount >= 0) {
    state.pendingWorkflowCount = pendingWorkflowCount;
    state.pendingWorkflowUpdatedAt = record.timestamp ?? "";
    if (pendingWorkflowCount === 0) {
      state.activeWorkflowTaskIds.clear();
      state.unidentifiedPendingWorkflowCount = 0;
    }
  }
  const retrievedWorkflowTaskId =
    typeof workflowResult?.task?.task_id === "string"
      ? workflowResult.task.task_id
      : "";
  const retrievedWorkflowTaskStatus =
    typeof workflowResult?.task?.status === "string"
      ? workflowResult.task.status
      : "";
  if (
    retrievedWorkflowTaskId &&
    state.activeWorkflowTaskIds.has(retrievedWorkflowTaskId) &&
    WORKFLOW_TERMINAL_RETRIEVAL_STATUSES.has(workflowResult.retrieval_status) &&
    (!retrievedWorkflowTaskStatus ||
      WORKFLOW_TERMINAL_TASK_STATUSES.has(retrievedWorkflowTaskStatus))
  ) {
    state.activeWorkflowTaskIds.delete(retrievedWorkflowTaskId);
    state.pendingWorkflowCount = Math.max(
      state.activeWorkflowTaskIds.size +
        state.unidentifiedPendingWorkflowCount,
      Math.max(0, (state.pendingWorkflowCount ?? 1) - 1)
    );
    state.pendingWorkflowUpdatedAt = record.timestamp ?? "";
  }
  if (
    record.interruptedMessageId &&
    (state.pendingWorkflowCount > 0 ||
      state.activeWorkflowTaskIds.size > 0 ||
      state.unidentifiedPendingWorkflowCount > 0)
  ) {
    state.activeWorkflowTaskIds.clear();
    state.unidentifiedPendingWorkflowCount = 0;
    state.pendingWorkflowCount = 0;
    state.pendingWorkflowUpdatedAt = record.timestamp ?? "";
  }
  if (!includeConversationText) return;
  const conversationMessage = conversationMessageFromRecord(record);
  if (!conversationMessage) return;
  const { role, body } = conversationMessage;
  state.searchTextParts.push(body);
  if (role === "user") {
    state.messageCount += 1;
    if (!state.firstUserPrompt) state.firstUserPrompt = body;
    state.lastUserPrompt = body;
  }
  if (role === "assistant") {
    state.messageCount += 1;
    state.lastAssistantText = body;
  }
}

function sessionSummaryResult(
  file,
  stat,
  state,
  includeSnippets,
  includeRemoteUrl = false,
  includeFilePath = false
) {
  const { title, titleSource } = currentSessionTitle(state);
  const result = {
    sessionId: path.basename(file, ".jsonl"),
    titlePresent: Boolean(title),
    titleSource,
    remoteUrlPresent: Boolean(state.remoteUrl),
    modifiedAt: stat.mtime.toISOString(),
    size: stat.size,
    messageCount: state.messageCount,
    lastTimestamp: state.lastTimestamp,
    observedPermissionMode: state.permissionMode || null,
    observedModel: state.model || null,
    observedEffort: state.effort || null,
  };
  if (includeFilePath) result.file = file;
  if (includeRemoteUrl) {
    result.remoteUrl = state.remoteUrl;
    result.remoteUrlUpdatedAt = state.remoteUrlUpdatedAt;
  }
  if (includeSnippets) {
    result.title = title;
    result.firstUserPrompt = state.firstUserPrompt.slice(0, 500);
    result.lastUserPrompt = state.lastUserPrompt.slice(0, 1000);
    result.lastAssistantText = state.lastAssistantText.slice(0, 2000);
  }
  return result;
}

// Keep listing work bounded while retaining both early metadata and the latest
// messages from oversized JSONL logs. Sampled summaries are marked as partial.
async function readSessionSummarySegments(file, stat, maxBytes) {
  const handle = await fs.promises.open(file, "r");
  try {
    if (stat.size <= maxBytes) {
      if (stat.size === 0) return { segments: [""], bytesRead: 0, truncated: false };
      const buffer = Buffer.alloc(stat.size);
      const read = await handle.read(buffer, 0, stat.size, 0);
      return {
        segments: [buffer.subarray(0, read.bytesRead).toString("utf8")],
        bytesRead: read.bytesRead,
        truncated: false,
      };
    }

    const headBytes = Math.min(SESSION_SUMMARY_HEAD_BYTES, Math.max(1, Math.floor(maxBytes / 4)));
    const tailBytes = Math.max(1, maxBytes - headBytes);
    const headBuffer = Buffer.alloc(headBytes);
    const tailBuffer = Buffer.alloc(tailBytes);
    const headRead = await handle.read(headBuffer, 0, headBytes, 0);
    const tailStart = Math.max(0, stat.size - tailBytes);
    const tailRead = await handle.read(tailBuffer, 0, tailBytes, tailStart);
    const headText = headBuffer.subarray(0, headRead.bytesRead).toString("utf8");
    const tailText = tailBuffer.subarray(0, tailRead.bytesRead).toString("utf8");
    const headEnd = headText.lastIndexOf("\n");
    const tailStartLine = tailText.indexOf("\n");
    return {
      segments: [
        headEnd >= 0 ? headText.slice(0, headEnd + 1) : "",
        tailStartLine >= 0 ? tailText.slice(tailStartLine + 1) : "",
      ],
      bytesRead: headRead.bytesRead + tailRead.bytesRead,
      truncated: true,
    };
  } finally {
    await handle.close();
  }
}

async function summarizeSessionMetadata(metadata, includeSnippets, maxBytes, includeRemoteUrl = false) {
  const { file, stat } = metadata;
  const expectedSessionId = path.basename(file, ".jsonl");
  const readResult = await readSessionSummarySegments(file, stat, maxBytes);
  const state = createSessionSummaryState();
  let lineCount = 0;

  for (const segment of readResult.segments) {
    let offset = 0;
    while (offset <= segment.length) {
      let end = segment.indexOf("\n", offset);
      if (end < 0) end = segment.length;
      let line = segment.slice(offset, end);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) {
        try {
          addSessionRecord(state, JSON.parse(line), expectedSessionId);
        } catch {
          // Ignore partial/corrupt lines, including sampled chunk boundaries.
        }
        lineCount += 1;
        if (lineCount % 1000 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      if (end === segment.length) break;
      offset = end + 1;
    }
  }

  const summary = sessionSummaryResult(
    file,
    stat,
    state,
    includeSnippets,
    includeRemoteUrl,
    false
  );
  if (readResult.truncated) {
    summary.summaryTruncated = true;
    summary.summaryBytesRead = readResult.bytesRead;
    summary.summaryBytesSkipped = Math.max(0, stat.size - readResult.bytesRead);
    summary.messageCountIsPartial = true;
  }
  const { title } = currentSessionTitle(state);
  return {
    summary,
    bytesRead: readResult.bytesRead,
    searchText: [
      expectedSessionId,
      title,
      ...state.searchTextParts,
      state.remoteUrl,
      state.permissionMode,
      state.model,
      state.effort,
    ]
      .join("\n")
      .toLowerCase(),
  };
}

export async function inspectSessionFile(file, maxMessages) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing non-regular Claude session log: ${file}`);
  }
  const expectedSessionId = path.basename(file, ".jsonl");
  const readResult = await readSessionSummarySegments(file, stat, MAX_SESSION_SUMMARY_BYTES);
  const state = createSessionSummaryState();
  const messages = [];
  for (const segment of readResult.segments) {
    for (let line of segment.split("\n")) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (!recordMatchesSession(record, expectedSessionId)) continue;
        addSessionRecord(state, record, expectedSessionId);
        const conversationMessage = conversationMessageFromRecord(record);
        if (conversationMessage) {
          messages.push({
            role: conversationMessage.role,
            timestamp: record.timestamp ?? "",
            text: conversationMessage.body.slice(0, 4000),
          });
          if (messages.length > maxMessages) messages.shift();
        }
      } catch {
        // Ignore partial/corrupt lines and sampled boundaries.
      }
    }
  }
  const summary = sessionSummaryResult(file, stat, state, true, true, true);
  if (readResult.truncated) {
    summary.summaryTruncated = true;
    summary.summaryBytesRead = readResult.bytesRead;
    summary.summaryBytesSkipped = Math.max(0, stat.size - readResult.bytesRead);
    summary.messageCountIsPartial = true;
  }
  return { ...summary, recentMessages: messages };
}

function skippedSessionSummary(metadata, includeSnippets, includeRemoteUrl) {
  const summary = sessionSummaryResult(
    metadata.file,
    metadata.stat,
    createSessionSummaryState(),
    includeSnippets,
    includeRemoteUrl,
    false
  );
  summary.summarySkipped = true;
  summary.summarySkipReason = "scan_byte_budget_exhausted";
  summary.messageCountIsPartial = true;
  return summary;
}

async function listSessionFileMetadata(projectDir) {
  let entries;
  try {
    entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { projectDirExists: false, files: [] };
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".jsonl") || !entry.isFile() || entry.isSymbolicLink()) continue;
    const file = path.join(projectDir, entry.name);
    try {
      const stat = await fs.promises.stat(file);
      if (stat.isFile()) files.push({ file, stat });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.file.localeCompare(a.file));
  return { projectDirExists: true, files };
}

function archiveProjectKey(projectDir) {
  const normalized = path.resolve(projectDir);
  return createHash("sha256")
    .update(IS_NATIVE_WINDOWS ? normalized.toLowerCase() : normalized)
    .digest("hex");
}

function archiveMarkerPath(projectDir, sessionId, stateDir = railConnectorStateDir()) {
  assertSafeSessionId(sessionId);
  return path.join(stateDir, "archives", archiveProjectKey(projectDir), `${sessionId}.json`);
}

async function withArchiveMutationLock(marker, operation) {
  const lockFile = `${marker}.lock`;
  await fs.promises.mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10000;
  let handle;
  for (;;) {
    try {
      handle = await fs.promises.open(lockFile, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
      } catch (error) {
        await handle.close();
        handle = undefined;
        try {
          await fs.promises.unlink(lockFile);
        } catch {
          // Preserve the original write failure.
        }
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fs.promises.stat(lockFile);
        if (Date.now() - stat.mtimeMs > 60000) {
          await fs.promises.unlink(lockFile);
          continue;
        }
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for archive catalog lock: ${lockFile}`);
      }
      await sleep(25);
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    try {
      await fs.promises.unlink(lockFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export async function sessionArchiveInfo(projectDir, sessionId, stateDir = railConnectorStateDir()) {
  try {
    assertSafeSessionId(sessionId);
  } catch {
    return { archived: false, markerCorrupt: false };
  }
  const marker = archiveMarkerPath(projectDir, sessionId, stateDir);
  try {
    const parsed = JSON.parse(await fs.promises.readFile(marker, "utf8"));
    if (
      parsed?.schemaVersion !== 1 ||
      parsed.sessionId !== sessionId ||
      typeof parsed.projectDir !== "string" ||
      !parsed.projectDir ||
      archiveProjectKey(parsed.projectDir) !== archiveProjectKey(projectDir)
    ) {
      return { archived: false, markerCorrupt: true };
    }
    return {
      archived: true,
      archivedAt: parsed.archivedAt ?? "",
      markerCorrupt: false,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { archived: false, markerCorrupt: false };
    return { archived: false, markerCorrupt: true };
  }
}

export async function setSessionArchiveState(
  projectDir,
  sessionId,
  archived,
  stateDir = railConnectorStateDir()
) {
  assertSafeSessionId(sessionId);
  const marker = archiveMarkerPath(projectDir, sessionId, stateDir);
  return withArchiveMutationLock(marker, async () => {
    const transcript = path.join(projectDir, `${sessionId}.jsonl`);
    let transcriptStat;
    try {
      transcriptStat = await fs.promises.lstat(transcript);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`No Claude session log found: ${transcript}`);
      throw error;
    }
    if (!transcriptStat.isFile() || transcriptStat.isSymbolicLink()) {
      throw new Error(`Refusing non-regular Claude session log: ${transcript}`);
    }

    if (!archived) {
      try {
        await fs.promises.unlink(marker);
        return { status: "unarchived", sessionId, archived: false };
      } catch (error) {
        if (error.code === "ENOENT") return { status: "already_active", sessionId, archived: false };
        throw error;
      }
    }

    const existing = await sessionArchiveInfo(projectDir, sessionId, stateDir);
    if (existing.archived) {
      return {
        status: "already_archived",
        sessionId,
        archived: true,
        archivedAt: existing.archivedAt,
      };
    }
    if (existing.markerCorrupt) {
      try {
        await fs.promises.unlink(marker);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }

    const archivedAt = new Date().toISOString();
    const temporary = `${marker}.${process.pid}.${randomUUID()}.tmp`;
    const record = {
      schemaVersion: 1,
      sessionId,
      projectDir: path.resolve(projectDir),
      archivedAt,
    };
    await fs.promises.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    try {
      await fs.promises.rename(temporary, marker);
    } catch (error) {
      try {
        await fs.promises.unlink(temporary);
      } catch {
        // The atomic rename already consumed the temporary file.
      }
      throw error;
    }
    return { status: "archived", sessionId, archived: true, archivedAt };
  });
}

export async function listClaudeSessionSummaries(
  projectDir,
  {
    limit = 20,
    query,
    includeSnippets = false,
    includeRemoteUrls = false,
    scanLimit = DEFAULT_SESSION_QUERY_SCAN_LIMIT,
    maxSummaryBytes = MAX_SESSION_SUMMARY_BYTES,
    byteBudget = SESSION_LIST_BYTE_BUDGET,
    archiveState = "all",
    stateDir,
  } = {}
) {
  const safeLimit = clampInteger(limit, 20, 1, 100);
  const safeScanLimit = clampInteger(scanLimit, DEFAULT_SESSION_QUERY_SCAN_LIMIT, 1, 500);
  const safeMaxSummaryBytes = Number.isFinite(maxSummaryBytes)
    ? Math.max(MIN_SESSION_SUMMARY_BYTES, Math.floor(maxSummaryBytes))
    : MAX_SESSION_SUMMARY_BYTES;
  const safeByteBudget = Number.isFinite(byteBudget)
    ? Math.max(MIN_SESSION_SUMMARY_BYTES, Math.floor(byteBudget))
    : SESSION_LIST_BYTE_BUDGET;
  if (!ARCHIVE_STATE_VALUES.includes(archiveState)) {
    throw new Error(`Invalid archiveState: ${archiveState}`);
  }
  const needle = query ? String(query).toLowerCase() : "";
  const { projectDirExists, files } = await listSessionFileMetadata(projectDir);
  const extendedScan = Boolean(needle) || archiveState !== "all";
  const candidateLimit = extendedScan ? safeScanLimit : safeLimit;
  const candidates = files.slice(0, candidateLimit);
  const sessions = [];
  let bytesRead = 0;
  let filesExamined = 0;
  let summariesTruncated = 0;
  let summariesSkipped = 0;

  for (const metadata of candidates) {
    filesExamined += 1;
    const sessionId = path.basename(metadata.file, ".jsonl");
    const archiveInfo = await sessionArchiveInfo(
      projectDir,
      sessionId,
      stateDir ?? railConnectorStateDir()
    );
    const archiveMatches =
      archiveState === "all" ||
      (archiveState === "archived" && archiveInfo.archived) ||
      (archiveState === "active" && !archiveInfo.archived);
    if (!archiveMatches) continue;

    const remainingBytes = safeByteBudget - bytesRead;
    let summary;
    let searchText = "";
    if (remainingBytes < MIN_SESSION_SUMMARY_BYTES) {
      summary = skippedSessionSummary(metadata, includeSnippets, includeRemoteUrls);
      summariesSkipped += 1;
    } else {
      const result = await summarizeSessionMetadata(
        metadata,
        includeSnippets,
        Math.min(safeMaxSummaryBytes, remainingBytes),
        includeRemoteUrls
      );
      summary = result.summary;
      searchText = result.searchText;
      bytesRead += result.bytesRead;
      if (summary.summaryTruncated) summariesTruncated += 1;
    }

    summary.archived = archiveInfo.archived;
    if (archiveInfo.archivedAt) summary.archivedAt = archiveInfo.archivedAt;
    if (archiveInfo.markerCorrupt) summary.archiveMarkerCorrupt = true;

    if (!needle || searchText.includes(needle)) {
      sessions.push(summary);
      if (sessions.length >= safeLimit) break;
    }
  }

  const scanTruncated = filesExamined < files.length;
  const scanLimitReached =
    extendedScan &&
    sessions.length < safeLimit &&
    filesExamined >= candidateLimit &&
    scanTruncated;
  return {
    projectDirExists,
    totalSessionFiles: files.length,
    filesExamined,
    scanLimit: safeScanLimit,
    effectiveScanLimit: candidateLimit,
    scanTruncated,
    searchMayBeIncomplete:
      Boolean(needle) &&
      (scanLimitReached || summariesTruncated > 0 || summariesSkipped > 0),
    archiveFilterMayBeIncomplete:
      archiveState !== "all" && scanLimitReached,
    maxSummaryBytesPerFile: safeMaxSummaryBytes,
    byteBudget: safeByteBudget,
    bytesRead,
    summariesTruncated,
    summariesSkipped,
    sessions,
  };
}

function listSessionFiles(projectDir) {
  if (!fs.existsSync(projectDir)) return [];
  return fs
    .readdirSync(projectDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(projectDir, name))
    .filter((file) => {
      const stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink();
    });
}

function snapshotSessionLogs(cwd) {
  const projectDir = projectDirFromCwd(cwd);
  const files = listSessionFiles(projectDir)
    .map((file) => {
      const stat = fs.statSync(file);
      return { file, sessionId: path.basename(file, ".jsonl"), mtimeMs: stat.mtimeMs };
    })
    .filter((entry) => SESSION_ID_RE.test(entry.sessionId))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
  return {
    projectDir,
    sessionIds: files.map((entry) => entry.sessionId),
    latestSessionId: files[0]?.sessionId ?? null,
  };
}

export async function resolveClaudeSessionName(
  cwd,
  sessionName,
  projectDirOverride = null
) {
  const requested = String(sessionName).trim();
  if (!requested) throw new Error("resumeSessionName cannot be empty.");
  const projectDir = projectDirOverride ?? projectDirFromCwd(cwd);
  const { files } = await listSessionFileMetadata(projectDir);
  const candidates = files.slice(0, 500);
  const matches = [];
  let bytesRead = 0;
  let searchMayBeIncomplete = files.length > candidates.length;
  for (const metadata of candidates) {
    const remainingBytes = SESSION_LIST_BYTE_BUDGET - bytesRead;
    if (remainingBytes < MIN_SESSION_SUMMARY_BYTES) {
      searchMayBeIncomplete = true;
      break;
    }
    const summarized = await summarizeSessionMetadata(
      metadata,
      true,
      Math.min(MAX_SESSION_SUMMARY_BYTES, remainingBytes),
      false
    );
    bytesRead += summarized.bytesRead;
    if (summarized.summary.summaryTruncated) searchMayBeIncomplete = true;
    if (!SESSION_ID_RE.test(summarized.summary.sessionId)) continue;
    if (
      summarized.summary.title?.localeCompare(requested, undefined, {
        sensitivity: "accent",
      }) === 0
    ) {
      assertSafeSessionId(summarized.summary.sessionId);
      matches.push(summarized.summary);
      if (matches.length > 1) break;
    }
  }
  if (matches.length === 0) {
    const suffix = searchMayBeIncomplete ? " The bounded search may be incomplete." : "";
    throw new Error(`No Claude session has the exact title: ${requested}.${suffix}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple Claude sessions have the exact title ${requested}; resume by UUID instead: ${matches
        .map((session) => session.sessionId)
        .join(", ")}`
    );
  }
  if (searchMayBeIncomplete) {
    throw new Error(
      `Cannot prove that Claude session title ${requested} is unique within the bounded catalog scan; resume by UUID instead.`
    );
  }
  return matches[0].sessionId;
}

export async function startedSessionSummary(
  cwd,
  {
    expectedSessionId,
    forkSession,
    beforeSnapshot,
    startedAtMs,
    remoteUrl = "",
    projectDirOverride = null,
  }
) {
  const projectDir = projectDirOverride ?? projectDirFromCwd(cwd);
  let file = null;
  let ambiguous = false;
  if (expectedSessionId && !forkSession) {
    const candidate = path.join(projectDir, `${expectedSessionId}.jsonl`);
    if (fs.existsSync(candidate)) file = candidate;
  } else if (forkSession) {
    const beforeIds = new Set(beforeSnapshot?.sessionIds ?? []);
    const candidates = listSessionFiles(projectDir)
      .map((candidate) => ({ file: candidate, stat: fs.statSync(candidate) }))
      .filter(
        ({ file: candidate, stat }) =>
          SESSION_ID_RE.test(path.basename(candidate, ".jsonl")) &&
          !beforeIds.has(path.basename(candidate, ".jsonl")) &&
          stat.mtimeMs >= startedAtMs - 5000
      )
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.file.localeCompare(a.file));
    if (remoteUrl && candidates.length > 0) {
      const matches = [];
      for (const candidate of candidates) {
        const summarized = await summarizeSessionMetadata(
          candidate,
          false,
          MAX_SESSION_SUMMARY_BYTES,
          true
        );
        if (summarized.summary.remoteUrl === remoteUrl) matches.push(candidate.file);
      }
      if (matches.length === 1) file = matches[0];
      else if (matches.length > 1 || candidates.length > 1) ambiguous = true;
    } else if (candidates.length > 1) {
      ambiguous = true;
    }
  }
  if (!file) return { summary: null, ambiguous };
  const stat = await fs.promises.stat(file);
  const result = await summarizeSessionMetadata({ file, stat }, false, MAX_SESSION_SUMMARY_BYTES, true);
  result.summary.file = file;
  return { summary: result.summary, ambiguous: false };
}

async function waitForStartedSessionSummary(cwd, options, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let result = { summary: null, ambiguous: false };
  while (Date.now() <= deadline) {
    result = await startedSessionSummary(cwd, options);
    if (result.summary) return { ...result, bindingStatus: "resolved" };
    await sleep(200);
  }
  return {
    ...result,
    bindingStatus: result.ambiguous ? "ambiguous" : "pending",
  };
}

export function assertSafeClaudeCliValue(label, value) {
  const normalized = String(value);
  if (!normalized) throw new Error(`${label} cannot be empty.`);
  if (normalized.startsWith("-")) {
    throw new Error(`${label} cannot start with '-' because Claude would parse it as another CLI option.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} cannot contain control characters.`);
  }
  return normalized;
}

function normalizedStringList(value, label) {
  if (!value) return "";
  const values = Array.isArray(value) ? value : [value];
  const normalized = values
    .map((item) => String(item).trim())
    .filter(Boolean);
  for (const item of normalized) {
    assertSafeClaudeCliValue(label, item);
    for (const commaPart of item.split(",")) {
      if (commaPart.trim().startsWith("-")) {
        throw new Error(`${label} entries cannot start with '-' because Claude would parse them as CLI options.`);
      }
    }
  }
  return normalized.join(",");
}

function pushOptionalArg(args, flag, value) {
  if (value) args.push(`${flag}=${assertSafeClaudeCliValue(flag, value)}`);
}

function pushOptionalListArg(args, flag, value, label) {
  const normalized = normalizedStringList(value, label);
  if (normalized) args.push(`${flag}=${normalized}`);
}

export function claudeArgs({
  sessionId,
  newSessionId,
  continueLatest,
  forkSession,
  remoteName,
  sessionTitle,
  permissionMode,
  model,
  effort,
  ultracode,
  ultracodeMechanism = "effort",
  confirmUltracode,
  confirmBypassPermissions,
  allowedTools,
  disallowedTools,
  tools,
  safeMode,
  bare,
  axScreenReader,
}) {
  if (sessionId && continueLatest) throw new Error("sessionId and continueLatest are mutually exclusive.");
  if (newSessionId && (sessionId || continueLatest)) {
    throw new Error("newSessionId cannot be combined with sessionId or continueLatest.");
  }
  if (forkSession && !sessionId && !continueLatest) {
    throw new Error("forkSession requires sessionId or continueLatest.");
  }
  if (safeMode && ["bypassPermissions", "dontAsk"].includes(permissionMode)) {
    throw new Error("safeMode cannot be combined with bypassPermissions or dontAsk.");
  }
  if (!CLAUDE_PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`Unsupported Claude permission mode: ${permissionMode}`);
  }
  if (effort && !CLAUDE_EFFORT_LEVELS.includes(effort)) {
    throw new Error(`Unsupported Claude effort: ${effort}`);
  }
  if (permissionMode === "bypassPermissions" && !confirmBypassPermissions) {
    throw new Error("bypassPermissions requires confirmBypassPermissions=true.");
  }
  if (ultracode && !confirmUltracode) {
    throw new Error("Ultracode requires confirmUltracode=true because it enables xhigh effort and dynamic workflows.");
  }
  if (ultracode && effort) {
    throw new Error("ultracode cannot be combined with effort; Ultracode selects xhigh internally.");
  }
  if (ultracode && safeMode) {
    throw new Error("ultracode cannot be combined with safeMode because safe mode disables workflows.");
  }
  if (ultracode && !["settings", "effort"].includes(ultracodeMechanism)) {
    throw new Error(`Unsupported Ultracode launch mechanism: ${ultracodeMechanism}`);
  }
  assertSafeClaudeCliValue("remoteName", remoteName);
  if (sessionTitle) assertSafeClaudeCliValue("sessionTitle", sessionTitle);
  if (model) assertSafeClaudeCliValue("model", model);

  const args = [];
  if (continueLatest) args.push("--continue");
  if (sessionId) args.push("--resume", sessionId);
  if (newSessionId) args.push("--session-id", newSessionId);
  if (forkSession) args.push("--fork-session");
  pushOptionalArg(args, "--model", model);
  pushOptionalArg(args, "--effort", effort);
  if (ultracode && ultracodeMechanism === "effort") args.push("--effort=ultracode");
  if (ultracode && ultracodeMechanism === "settings") args.push(`--settings=${ULTRACODE_SETTINGS_JSON}`);
  pushOptionalListArg(args, "--allowedTools", allowedTools, "allowedTools");
  pushOptionalListArg(args, "--disallowedTools", disallowedTools, "disallowedTools");
  pushOptionalListArg(args, "--tools", tools, "tools");
  if (safeMode) args.push("--safe-mode");
  if (bare) args.push("--bare");
  if (axScreenReader) args.push("--ax-screen-reader");
  pushOptionalArg(args, "--name", sessionTitle);
  args.push(`--remote-control=${remoteName}`, `--permission-mode=${permissionMode}`);
  return args;
}

export function requestedLaunchPosture({
  permissionMode,
  requestedPermissionMode,
  model,
  effort,
  ultracode = false,
  ultracodeMechanism = "effort",
  confirmBypassPermissions = false,
  bypassPolicyMode,
}) {
  const requestedMode = requestedPermissionMode ?? permissionMode;
  return {
    permissionMode: requestedMode,
    model: model ?? null,
    effort: ultracode ? "xhigh" : effort ?? null,
    ultracode: Boolean(ultracode),
    ultracodeMechanism: ultracode ? ultracodeMechanism : null,
    bypassPermissionsAcknowledged:
      requestedMode === "bypassPermissions" ? Boolean(confirmBypassPermissions) : null,
    bypassPermissionsPolicyMode:
      requestedMode === "bypassPermissions" ? bypassPolicyMode ?? bypassPolicyStatus().mode : null,
  };
}

export function resolvedLaunchPosture(options) {
  return {
    ...requestedLaunchPosture({
      ...options,
      requestedPermissionMode: options.permissionMode,
    }),
    permissionMode: options.permissionMode,
  };
}

export function bypassPolicyStatus(env = process.env) {
  const value = env[BYPASS_POLICY_ENV];
  const mode =
    value === BYPASS_ISOLATED_POLICY_VALUE
      ? "isolated"
      : value === BYPASS_LOCAL_HOST_POLICY_VALUE
        ? "local_host_acknowledged"
        : "disabled";
  return {
    enabled: mode !== "disabled",
    mode,
    environment: BYPASS_POLICY_ENV,
    configured: typeof value === "string" && value.length > 0,
    recognized: mode !== "disabled",
    acceptedValues: {
      localHost: BYPASS_LOCAL_HOST_POLICY_VALUE,
      isolated: BYPASS_ISOLATED_POLICY_VALUE,
    },
    requiresConfirmation: true,
    requiresPolicyAcknowledgement: true,
    readAtProcessStart: true,
    relaunchRequiredAfterChange: true,
  };
}

export function ultracodeEnvironmentStatus(
  env = process.env,
  evidenceScope = "mcp_process_environment"
) {
  const effortOverride =
    typeof env.CLAUDE_CODE_EFFORT_LEVEL === "string"
      ? env.CLAUDE_CODE_EFFORT_LEVEL.trim().toLowerCase()
      : "";
  const workflowsDisabled = env.CLAUDE_CODE_DISABLE_WORKFLOWS === "1";
  const blockers = [];
  if (effortOverride && effortOverride !== "xhigh") {
    blockers.push("non_xhigh_effort_override");
  }
  if (workflowsDisabled) blockers.push("workflows_disabled");
  const status = blockers.length ? "blocking" : "compatible";
  const launchSnapshot = evidenceScope === "claude_child_launch_environment";
  return {
    status,
    evidenceScope,
    effortOverrideStatus: !effortOverride
      ? "unset"
      : effortOverride === "xhigh"
        ? "compatible_xhigh"
        : "blocking_non_xhigh",
    workflowsDisabled,
    blockers,
    note:
      status === "blocking"
        ? launchSnapshot
          ? "The captured Claude child launch environment contains an override that prevents the requested UltraCode workflow posture."
          : "The MCP process environment contains an override that prevents the requested UltraCode workflow posture."
        : launchSnapshot
          ? "No blocking UltraCode override was present in the captured Claude child launch environment. Claude settings can still differ."
          : "No blocking UltraCode override was found in the MCP process environment. Claude settings or child-process configuration can still differ.",
  };
}

export function claudeChildLaunchEnvironmentStatus(env = process.env) {
  return ultracodeEnvironmentStatus(
    env,
    "claude_child_launch_environment"
  );
}

export function tmuxChildEnvironmentArgs(env = process.env) {
  return CLAUDE_CHILD_ENVIRONMENT_KEYS.flatMap((name) => [
    "-e",
    `${name}=${typeof env[name] === "string" ? env[name] : ""}`,
  ]).concat(["-e", "FORCE_COLOR=1"]);
}

export function assertBypassPolicy(permissionMode, env = process.env) {
  const policy = bypassPolicyStatus(env);
  if (permissionMode !== "bypassPermissions") return policy;
  if (!policy.enabled) {
    throw new Error(
      `bypassPermissions is disabled by policy. Set ${BYPASS_POLICY_ENV} to either ${BYPASS_LOCAL_HOST_POLICY_VALUE} for an explicitly acknowledged local development host or ${BYPASS_ISOLATED_POLICY_VALUE} for an isolated environment. Per-call confirmBypassPermissions=true is still required. The policy is read from the MCP process environment at startup; changing registration requires a newly spawned MCP process, usually through a fresh Codex task or a targeted Codex app-server reload.`
    );
  }
  return policy;
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1] ?? null;
  const withEquals = args.find((value) => value.startsWith(`${flag}=`));
  return withEquals ? withEquals.slice(flag.length + 1) : null;
}

export function requestedLaunchPostureFromArgs(args = []) {
  let ultracode = argValue(args, "--effort") === "ultracode";
  let ultracodeMechanism = ultracode ? "effort" : null;
  const settingsValue = argValue(args, "--settings");
  if (settingsValue) {
    try {
      if (JSON.parse(settingsValue)?.ultracode === true) {
        ultracode = true;
        ultracodeMechanism = "settings";
      }
    } catch {
      // Unknown settings payload; leave the experimental posture unobserved.
    }
  }
  const permissionMode = argValue(args, "--permission-mode");
  return {
    permissionMode,
    model: argValue(args, "--model"),
    effort: ultracode ? "xhigh" : argValue(args, "--effort"),
    ultracode,
    ultracodeMechanism,
    bypassPermissionsAcknowledged: null,
    bypassPermissionsPolicyMode:
      permissionMode === "bypassPermissions" ? bypassPolicyStatus().mode : null,
  };
}

export function compareLaunchMetadata(existing, requested) {
  if (!existing?.args || !requested?.args || !existing.cwd || !requested.cwd) {
    return { comparison: "unknown", launchMismatch: null };
  }
  const argsMismatch = JSON.stringify(existing.args) !== JSON.stringify(requested.args);
  const normalizeCwd = (value) => {
    try {
      return normalizeForPathCompare(value);
    } catch {
      return null;
    }
  };
  const existingCwd = normalizeCwd(existing.cwd);
  const requestedCwd = normalizeCwd(requested.cwd);
  if (!existingCwd || !requestedCwd) return { comparison: "unknown", launchMismatch: null };
  const cwdMismatch = existingCwd !== requestedCwd;
  return {
    comparison: argsMismatch || cwdMismatch ? "mismatch" : "match",
    launchMismatch: argsMismatch || cwdMismatch,
  };
}

export function resolveTmuxCommand() {
  const configured = process.env[TMUX_COMMAND_ENV];
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(`${TMUX_COMMAND_ENV} must be an absolute executable path: ${configured}`);
    }
    const resolved = resolveCommandFromPath(configured);
    if (!resolved) throw new Error(`${TMUX_COMMAND_ENV} does not point to an executable file: ${configured}`);
    return resolved;
  }
  const resolved = resolveCommandFromPath("tmux");
  if (!resolved) {
    throw new Error(`Unable to resolve tmux from PATH entries or ${TMUX_COMMAND_ENV}.`);
  }
  return resolved;
}

async function tmux(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(resolveTmuxCommand(), args, {
      timeout: options.timeoutMs ?? 15000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 8,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message,
      code: error.code,
    };
  }
}

async function tmuxWithInput(args, input, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveTmuxCommand(), args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, stdout: "", stderr: error.message, code: error.code });
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Process already exited.
      }
      finish({
        ok: false,
        stdout: Buffer.concat(stdout).toString(),
        stderr: "tmux input timed out",
        code: "ETIMEDOUT",
      });
    }, options.timeoutMs ?? 15000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      finish({
        ok: false,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString() || error.message,
        code: error.code,
      });
    });
    child.on("close", (code) => {
      finish({
        ok: code === 0,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        code,
      });
    });
    child.stdin.end(String(input));
  });
}

async function tmuxExists(sessionName) {
  const result = await tmux(["has-session", "-t", sessionName], { timeoutMs: 5000 });
  return result.ok;
}

async function tmuxCapture(sessionName, lines = 120) {
  const metadata = await requireManagedTmuxSession(sessionName);
  const result = await tmux(["capture-pane", "-t", metadata.paneId, "-p", "-S", `-${lines}`], {
    timeoutMs: 10000,
    maxBuffer: 1024 * 1024 * 4,
  });
  if (!result.ok) throw new Error(result.stderr || `tmux capture failed for ${sessionName}`);
  return result.stdout;
}

function createLaunchMetadata({
  cwd,
  args,
  startedAtMs,
  launchOptions,
  launchEnvironment,
  resolvedSessionId = null,
}) {
  return {
    schemaVersion: 4,
    cwd,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    args,
    requestedPosture: requestedLaunchPosture(launchOptions),
    resolvedPosture: resolvedLaunchPosture(launchOptions),
    launchEnvironment,
    resolvedSessionId,
    observedPosture: null,
  };
}

const launchPostureSchemaV2 = z
  .object({
    permissionMode: z.enum(CLAUDE_PERMISSION_MODES),
    model: z.string().max(128).nullable(),
    effort: z.enum(CLAUDE_EFFORT_LEVELS).nullable(),
    ultracode: z.boolean(),
    ultracodeMechanism: z.enum(["settings", "effort"]).nullable(),
    bypassPermissionsAcknowledged: z.boolean().nullable(),
  })
  .strict();

const launchPostureSchemaV3 = launchPostureSchemaV2.extend({
  bypassPermissionsPolicyMode: z.enum(["disabled", "isolated", "local_host_acknowledged"]).nullable(),
});

const launchMetadataSchemaV2 = z
  .object({
    schemaVersion: z.literal(2),
    cwd: z.string().min(1),
    startedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Invalid start timestamp."),
    paneId: z.string().regex(/^%\d+$/),
    pid: z.number().int().positive(),
    args: z.array(z.string().max(4096)).max(200),
    requestedPosture: launchPostureSchemaV2,
  })
  .strict();

const launchMetadataSchemaV3 = z
  .object({
    schemaVersion: z.literal(3),
    cwd: z.string().min(1),
    startedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "Invalid start timestamp."),
    startedAtMs: z.number().int().positive().optional(),
    paneId: z.string().regex(/^%\d+$/),
    pid: z.number().int().positive(),
    args: z.array(z.string().max(4096)).max(200),
    requestedPosture: launchPostureSchemaV3,
    resolvedPosture: launchPostureSchemaV3,
    resolvedSessionId: z.string().uuid().nullable(),
    observedPosture: z
      .object({
        permissionMode: z.string().nullable(),
        model: z.string().nullable(),
        effort: z.string().nullable(),
        ultracode: z.boolean().nullable(),
        evidence: z.record(z.string(), z.string()),
      })
      .nullable(),
  })
  .strict();

const launchEnvironmentSchema = z
  .object({
    status: z.enum(["compatible", "blocking"]),
    evidenceScope: z.literal("claude_child_launch_environment"),
    effortOverrideStatus: z.enum([
      "unset",
      "compatible_xhigh",
      "blocking_non_xhigh",
    ]),
    workflowsDisabled: z.boolean(),
    blockers: z
      .array(z.enum(["non_xhigh_effort_override", "workflows_disabled"]))
      .max(2),
    note: z.string().max(512),
  })
  .strict();

const launchMetadataSchemaV4 = launchMetadataSchemaV3.extend({
  schemaVersion: z.literal(4),
  launchEnvironment: launchEnvironmentSchema,
});

export function validateLaunchMetadata(value) {
  const parsed = z
    .union([
      launchMetadataSchemaV2,
      launchMetadataSchemaV3,
      launchMetadataSchemaV4,
    ])
    .safeParse(value);
  if (!parsed.success) return null;
  try {
    const cwd = resolveAllowedCwd(parsed.data.cwd);
    return {
      ...parsed.data,
      startedAtMs: parsed.data.startedAtMs ?? Date.parse(parsed.data.startedAt),
      cwd,
    };
  } catch {
    return null;
  }
}

function launchPostureV3(posture) {
  if (!posture) return posture;
  return {
    ...posture,
    bypassPermissionsPolicyMode:
      posture.bypassPermissionsPolicyMode ?? null,
  };
}

export function upgradeLaunchMetadataToV3(metadata, updates = {}) {
  const requestedPosture = launchPostureV3(
    updates.requestedPosture ?? metadata.requestedPosture
  );
  return {
    ...metadata,
    schemaVersion: 3,
    startedAtMs: metadata.startedAtMs ?? Date.parse(metadata.startedAt),
    requestedPosture,
    resolvedPosture: launchPostureV3(
      updates.resolvedPosture ??
        metadata.resolvedPosture ??
        requestedPosture
    ),
    resolvedSessionId:
      updates.resolvedSessionId ?? metadata.resolvedSessionId ?? null,
    observedPosture:
      updates.observedPosture ?? metadata.observedPosture ?? null,
  };
}

export function upgradeLaunchMetadataToV4(metadata, updates = {}) {
  const upgraded = upgradeLaunchMetadataToV3(metadata, updates);
  const launchEnvironment =
    updates.launchEnvironment ?? metadata.launchEnvironment ?? null;
  if (!launchEnvironment) {
    throw new Error(
      "Launch-time Claude child environment provenance is unavailable."
    );
  }
  return {
    ...upgraded,
    schemaVersion: 4,
    launchEnvironment,
  };
}

function updatedLaunchMetadata(metadata, updates = {}) {
  if (metadata.schemaVersion === 4 || updates.launchEnvironment) {
    return upgradeLaunchMetadataToV4(metadata, updates);
  }
  return upgradeLaunchMetadataToV3(metadata, updates);
}

async function readTmuxLaunchMetadata(sessionName) {
  const result = await tmux(["show-options", "-t", sessionName, "-v", TMUX_LAUNCH_METADATA_OPTION], {
    timeoutMs: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (!result.ok || !result.stdout.trim()) return null;
  try {
    return validateLaunchMetadata(JSON.parse(result.stdout.trim()));
  } catch {
    return null;
  }
}

async function writeTmuxLaunchMetadata(sessionName, metadata) {
  const result = await tmux(
    ["set-option", "-t", sessionName, TMUX_LAUNCH_METADATA_OPTION, JSON.stringify(metadata)],
    { timeoutMs: 5000, maxBuffer: 1024 * 1024 }
  );
  return result.ok ? "" : result.stderr || "Unable to store tmux launch metadata.";
}

async function tmuxPaneIdentity(target) {
  const result = await tmux(
    ["display-message", "-p", "-t", target, "#{session_name}|#{pane_id}|#{pane_pid}"],
    { timeoutMs: 5000, maxBuffer: 1024 * 1024 }
  );
  if (!result.ok) return null;
  const [sessionName, paneId, pidText, ...extra] = result.stdout.trim().split("|");
  const pid = Number.parseInt(pidText, 10);
  if (
    extra.length > 0 ||
    !sessionName ||
    !/^%\d+$/.test(paneId ?? "") ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    return null;
  }
  return { sessionName, paneId, pid };
}

async function managedTmuxMetadata(sessionName) {
  const metadata = await readTmuxLaunchMetadata(sessionName);
  if (!metadata) return null;
  const identity = await tmuxPaneIdentity(metadata.paneId);
  if (
    !identity ||
    identity.sessionName !== sessionName ||
    identity.paneId !== metadata.paneId ||
    identity.pid !== metadata.pid
  ) {
    return null;
  }
  return metadata;
}

function sameTmuxLaunchGeneration(current, expected) {
  return Boolean(
    current &&
      current.startedAtMs === expected.startedAtMs &&
      current.paneId === expected.paneId &&
      current.pid === expected.pid
  );
}

async function killOwnedTmuxSession(sessionName, expectedMetadata, details = {}) {
  if (!(await tmuxExists(sessionName))) {
    return { status: "stopped", managedSession: sessionName, ...details };
  }
  const currentMetadata = await readTmuxLaunchMetadata(sessionName);
  if (!sameTmuxLaunchGeneration(currentMetadata, expectedMetadata)) {
    const error = new Error(
      `Managed session generation changed for ${sessionName}; refusing to terminate a replacement tmux session.`
    );
    error.code = "ESTALE";
    throw error;
  }
  const killed = await tmux(["kill-session", "-t", sessionName], { timeoutMs: 10000 });
  if (!killed.ok && (await tmuxExists(sessionName))) {
    throw new Error(killed.stderr || `Unable to stop managed tmux session ${sessionName}.`);
  }
  if (await tmuxExists(sessionName)) {
    return {
      status: "stop_timeout",
      managedSession: sessionName,
      note: "tmux still reports the managed session after kill-session.",
    };
  }
  return { status: "stopped", managedSession: sessionName, ...details };
}

async function managedWindowsBrokerSession(
  sessionName,
  { allowMissingCwdForStop = false } = {}
) {
  const status = await probeWindowsBroker();
  if (status && status.compatible === false) {
    const error = new Error(
      "Windows broker build or Claude launch policy does not match this MCP process. " +
        "If the prior broker still owns active sessions, stop them from the Codex task that started them; otherwise retry so the idle broker can upgrade automatically."
    );
    error.code = "EBROKERUPGRADE";
    throw error;
  }
  const session = status?.managedSessions?.find(
    (candidate) => candidate.name === sessionName
  );
  if (!session) return null;
  try {
    return {
      ...session,
      cwd: allowMissingCwdForStop
        ? resolveAllowedPersistedCwd(session.cwd, session.canonicalCwd)
        : resolveAllowedManagedCwd(session.cwd, session.canonicalCwd),
    };
  } catch (error) {
    if (
      ["EOUTOFSCOPE", "ECWDPROVENANCE", "ECWDUNAVAILABLE"].includes(
        error?.code
      )
    ) {
      const scopedError = new Error(
        error.code === "ECWDUNAVAILABLE"
          ? "Managed session workspace is unavailable."
          : "Managed session is outside this MCP process's allowed workspace scope."
      );
      scopedError.code = error.code;
      throw scopedError;
    }
    throw error;
  }
}

async function forceCleanupIncompatibleWindowsBrokerSession(
  sessionName,
  brokerStatus
) {
  if (brokerStatus?.protocol !== 1) {
    const error = new Error(
      "The active Windows broker uses an unsupported protocol and cannot be cleaned up from this MCP process."
    );
    error.code = "EBROKERUPGRADE";
    throw error;
  }
  const session = brokerStatus.managedSessions?.find(
    (candidate) => candidate.name === sessionName
  );
  if (!session) {
    return { status: "not_running", managedSession: sessionName };
  }
  try {
    resolveAllowedCleanupCwd(session.cwd, session.canonicalCwd);
  } catch (error) {
    if (
      ["EOUTOFSCOPE", "ECWDPROVENANCE", "ECWDUNAVAILABLE"].includes(
        error?.code
      )
    ) {
      const scopedError = new Error(
        error.code === "ECWDUNAVAILABLE"
          ? "Managed session workspace is unavailable."
          : "Managed session is outside this MCP process's allowed workspace scope."
      );
      scopedError.code = error.code;
      throw scopedError;
    }
    throw error;
  }

  const leaseId = randomUUID();
  const deadline = Date.now() + 30000;
  let acquired = false;
  try {
    for (;;) {
      const lease = await windowsBrokerCleanupRequest(
        "acquireCleanupLease",
        {
          sessionName,
          leaseId,
          ttlMs: BROKER_LEASE_TTL_MS,
          expectedStartedAtMs: session.startedAtMs,
          expectedGenerationId: session.generationId,
        },
        { timeoutMs: 5000 }
      );
      if (lease.status === "not_running") {
        return { status: "not_running", managedSession: sessionName };
      }
      if (lease.status === "acquired") {
        acquired = true;
        break;
      }
      if (Date.now() >= deadline) {
        const error = new Error(
          `Timed out waiting for another MCP mutation workflow on ${sessionName}.`
        );
        error.code = "ELEASE";
        throw error;
      }
      await sleep(150);
    }
    const result = await windowsBrokerCleanupRequest(
      "cleanupStop",
      {
        sessionName,
        leaseId,
        expectedStartedAtMs: session.startedAtMs,
        expectedGenerationId: session.generationId,
      },
      { timeoutMs: 20000 }
    );
    return {
      ...result,
      compatibilityCleanup: true,
      terminalCaptureRead: false,
      graceful: false,
    };
  } catch (error) {
    if (
      error?.code === "EBROKERUPGRADE" ||
      (error?.code === "EBROKER" &&
        /Unsupported Windows broker operation/i.test(error.message || ""))
    ) {
      const upgradeError = new Error(
        "The active broker predates compatibility cleanup. Stop its sessions from the Codex task that started them, then retry the upgrade."
      );
      upgradeError.code = "EBROKERUPGRADE";
      throw upgradeError;
    }
    if (brokerUnavailable(error)) {
      return { status: "not_running", managedSession: sessionName };
    }
    throw error;
  } finally {
    if (acquired) {
      try {
        await windowsBrokerCleanupRequest(
          "releaseCleanupLease",
          { sessionName, leaseId },
          { timeoutMs: 5000 }
        );
      } catch {
        // A successful cleanup removes the session before lease release.
      }
    }
  }
}

async function backendLaunchMetadata(sessionName) {
  if (IS_NATIVE_WINDOWS) {
    const session = await managedWindowsBrokerSession(sessionName);
    if (!session) return null;
    return {
      schemaVersion: session.launchEnvironment ? 4 : 3,
      cwd: session.cwd,
      startedAt: session.startedAt,
      startedAtMs: session.startedAtMs ?? Date.parse(session.startedAt),
      generationId: session.generationId ?? null,
      pid: session.pid ?? null,
      args: session.args,
      requestedPosture: session.requestedPosture ?? requestedLaunchPostureFromArgs(session.args),
      resolvedPosture: session.resolvedPosture ?? requestedLaunchPostureFromArgs(session.args),
      ...(session.launchEnvironment
        ? { launchEnvironment: session.launchEnvironment }
        : {}),
      resolvedSessionId: session.resolvedSessionId ?? null,
      observedPosture: session.observedPosture ?? null,
      exited: Boolean(session.exited),
      exitCode: session.exitCode ?? null,
    };
  }
  return managedTmuxMetadata(sessionName);
}

export function publicLaunchMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return metadata;
  const { observedPosture: _legacyObservedPosture, ...publicMetadata } = metadata;
  return publicMetadata;
}

async function backendUpdateMetadata(
  sessionName,
  updates,
  expectedStartedAtMs = null,
  expectedGenerationId = null
) {
  if (IS_NATIVE_WINDOWS) {
    const updateKeys = Object.keys(updates).filter(
      (key) => updates[key] !== undefined
    );
    const observationOnly =
      updateKeys.length > 0 &&
      updateKeys.every((key) => key === "observedPosture");
    return windowsBrokerRequest(
      observationOnly ? "updateObservation" : "updateMetadata",
      {
        sessionName,
        ...updates,
        expectedStartedAtMs,
        expectedGenerationId,
        leaseId: observationOnly
          ? undefined
          : brokerMutationLeases.get(sessionName),
      }
    );
  }
  const metadata = await requireManagedTmuxSession(sessionName);
  if (
    expectedStartedAtMs !== null &&
    expectedStartedAtMs !== undefined &&
    Number(expectedStartedAtMs) !== metadata.startedAtMs
  ) {
    const error = new Error(
      `Managed session generation changed for ${sessionName}; refusing stale metadata update.`
    );
    error.code = "ESTALE";
    throw error;
  }
  const updated = updatedLaunchMetadata(metadata, updates);
  const error = await writeTmuxLaunchMetadata(metadata.paneId, updated);
  if (error) throw new Error(error);
  return { status: "updated", metadata: updated };
}

async function requireManagedTmuxSession(sessionName) {
  assertSafeManagedSessionName(sessionName);
  if (!(await tmuxExists(sessionName))) {
    const error = new Error(`No managed tmux Claude session found: ${sessionName}`);
    error.code = "ENOENT";
    throw error;
  }
  const metadata = await managedTmuxMetadata(sessionName);
  if (!metadata) {
    throw new Error(
      `Refusing to operate on tmux session ${sessionName}: it has no valid Rail Connector ownership metadata and pane identity.`
    );
  }
  return metadata;
}

export function mergeObservedPosture(prior = {}, observed = {}) {
  const fields = ["permissionMode", "model", "effort", "ultracode"];
  const merged = {
    permissionMode: prior?.permissionMode ?? null,
    model: prior?.model ?? null,
    effort: prior?.effort ?? null,
    ultracode: prior?.ultracode ?? null,
    evidence: {},
  };
  for (const field of fields) {
    if (
      merged[field] !== null &&
      merged[field] !== undefined &&
      prior?.evidence?.[field]
    ) {
      merged.evidence[field] = prior.evidence[field];
    }
  }
  for (const field of fields) {
    if (observed?.[field] !== null && observed?.[field] !== undefined) {
      merged[field] = observed[field];
      if (observed?.evidence?.[field]) {
        merged.evidence[field] = observed.evidence[field];
      } else {
        delete merged.evidence[field];
      }
    }
  }
  return merged;
}

export function trustedSessionLogPosture(observed = {}) {
  const trusted = {
    permissionMode: null,
    model: null,
    effort: null,
    ultracode: null,
    evidence: {},
  };
  for (const field of ["permissionMode", "model", "effort", "ultracode"]) {
    const evidence = observed?.evidence?.[field];
    if (
      evidence === "claude_session_log" &&
      observed?.[field] !== null &&
      observed?.[field] !== undefined
    ) {
      trusted[field] = observed[field];
      trusted.evidence[field] = evidence;
    }
  }
  return trusted;
}

async function managedPostureReport(
  sessionName,
  signals,
  metadata = null,
  transcriptObserved = null
) {
  const currentMetadata = metadata ?? (await backendLaunchMetadata(sessionName));
  if (!IS_NATIVE_WINDOWS && currentMetadata?.schemaVersion === 2) {
    try {
      await backendUpdateMetadata(
        sessionName,
        {},
        currentMetadata.startedAtMs,
        currentMetadata.generationId
      );
    } catch {
      // Reporting remains available if a legacy tmux metadata upgrade races.
    }
  }
  const currentTranscriptObserved =
    transcriptObserved ?? (await sessionRuntimeObservation(currentMetadata));
  return launchPostureReport(
    currentMetadata?.requestedPosture ?? null,
    currentMetadata?.resolvedPosture ?? currentMetadata?.requestedPosture ?? null,
    signals,
    currentTranscriptObserved,
    { launchEnvironment: currentMetadata?.launchEnvironment ?? null }
  );
}

async function assertManagedMutationPolicy(sessionName) {
  const metadata = await backendLaunchMetadata(sessionName);
  const permissionMode =
    metadata?.resolvedPosture?.permissionMode ??
    metadata?.requestedPosture?.permissionMode ??
    null;
  if (permissionMode === "bypassPermissions") assertBypassPolicy(permissionMode);
  return metadata;
}

async function tmuxManagedSessions() {
  const listed = await tmux(["list-sessions", "-F", "#{session_name}"], { timeoutMs: 5000 });
  if (!listed.ok) return [];
  const sessions = [];
  for (const name of listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const metadata = await managedTmuxMetadata(name);
    if (metadata) sessions.push({ name, ...metadata, exited: false, exitCode: null });
  }
  return sessions;
}

function lastLines(value, lines) {
  return value.split(/\r?\n/).slice(-lines).join("\n");
}

function compactWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function compactTerminalWhitespace(value) {
  return value.replace(/^[ \t\u2502\u2503\u2551]+/gm, "").replace(/\s+/g, " ").trim();
}

function promptSnippets(value) {
  const compact = compactWhitespace(value);
  if (compact.length <= 80) return compact ? [compact] : [];
  return [compact.slice(0, 80), compact.slice(-80)];
}

const BUSY_CAPTURE_PATTERN =
  "esc to interrupt|ctrl-c to cancel|thinking with \\w+ effort";
const BUSY_CAPTURE_MATCH_RE = new RegExp(BUSY_CAPTURE_PATTERN, "gi");
const BUSY_STATUS_LINE_MATCH_RE =
  /(?:^|\n)[ \t\u2502\u2503\u2551]*[✢✳✶✻✽✦]\s*[^\r\n]{1,200}?(?:…|\.{3})(?=$|[ \t]*\(\s*\d)/gmu;
const BUSY_TIMED_STATUS_LINE_MATCH_RE =
  /(?:^|\n)[ \t\u2502\u2503\u2551]*[^\r\n]{1,200}?(?:…|\.{3})[ \t]*(?=\(\s*(?:\d+h[ \t]*)?(?:\d+m[ \t]*)?\d+s[ \t]*·)/gmu;
const COMPLETE_CAPTURE_MATCH_RE =
  /(?:^|\n)[ \t\u2502\u2503\u2551]*(?:[✢✻✽●○]\s*)?[A-Z][\p{L}\p{M}-]+ for (?:\d+h[ \t]*)?(?:\d+m[ \t]*)?\d+s(?=$|[ \t]*(?:[>/?]|plan mode|○|\/rc))/gmu;
const COMPLETE_INLINE_CAPTURE_MATCH_RE =
  /[✢✻✽●○]\s*[A-Z][\p{L}\p{M}-]+ for (?:\d+h[ \t]*)?(?:\d+m[ \t]*)?\d+s(?=$|[ \t]*(?:[>/?]|plan mode|○|\/rc|←))/gmu;
const DYNAMIC_WORKFLOW_WAIT_MATCH_RE =
  /(?:^|\n)[ \t\u2502\u2503\u2551]*(?:[✢✳✶✻✽✦][ \t]*)?Waiting for(?:[ \t]+[1-9]\d*[ \t]+background agents?[ \t]+and)?[ \t]+([1-9]\d*)[ \t]+dynamic workflows?[ \t]+to finish[ \t]*(?=$|\r?\n)/gmu;
const SESSION_LIMIT_RE =
  /(?:^|\n)(?![^\n]*\bno\s+(?:real\s+)?(?:session|usage)\s+limit)[^\n]*(?:(?:session|usage)\s+limit\s+(?:warning|reached|reset|resets?|soon|remaining)|limit\s+(?:warning|reached|reset|resets?))/i;
const APPROVAL_QUESTION_RE =
  /(?:^|\n).*(?:do you want to (?:proceed|allow|continue)|allow (?:this )?(?:command|tool|action)|approve (?:this )?(?:command|tool|action))/i;
const APPROVAL_CHOICE_RE =
  /(?:^|\n).*(?:yes,? and don'?t ask again|no,? and tell claude what to do differently)/i;
const PASTE_PLACEHOLDER_RE =
  /(?:^|\n).*\[Pasted text #\d+(?: \+\d+ lines)?\]/i;
const INTERRUPTED_PROMPT_RE = /(?:^|\n).*Interrupted\s*[·-]\s*What should Claude do instead\?/i;
const WORKSPACE_TRUST_QUESTION_RE =
  /(?:do you trust the files in this (?:folder|workspace|directory)|trust this (?:workspace|folder|directory)|is this a project you created or one you trust)/i;
const WORKSPACE_TRUST_YES_RE = /(?:yes,?\s+i trust|yes,?\s+proceed)/i;
const WORKSPACE_TRUST_NO_RE = /(?:no,?\s+exit|no,?\s+cancel)/i;
const EFFORT_INDICATOR_RE =
  /(?:^|\n)(?![ \t\u2502\u2503\u2551]*>)[ \t\u2502\u2503\u2551]*(?:Current effort level|Effort level):\s*(ultracode|low|medium|high|xhigh|max)\b/gi;
const EFFORT_SET_RE =
  /(?:^|\n)[ \t\u2502\u2503\u2551]*⎿\s*Set effort level to\s+(ultracode|low|medium|high|xhigh|max)\b/gi;
const ULTRACODE_STATUS_RE =
  /(?:^|\n)[ \t\u2502\u2503\u2551]*[✦✧]\s*ultracode\s*·\s*xhigh effort\s*\+\s*dynamic workflows/gi;
const ULTRACODE_UNAVAILABLE_RE =
  /(?:^|\n)(?![ \t\u2502\u2503\u2551]*>)[ \t\u2502\u2503\u2551]*(?:Error:\s*)?(?:Ultracode needs dynamic workflows enabled|Ultracode runs at xhigh effort, which is restricted)/i;
const PERMISSION_INDICATOR_RE =
  /(?:^|\n)[ \t\u2502\u2503\u2551]*(?:(manual|default|plan|acceptEdits|auto|dontAsk|bypassPermissions)\s+mode\s+on|Permission mode:\s*(manual|default|plan|acceptEdits|auto|dontAsk|bypassPermissions))\b/gi;

function activeInputLineText(line) {
  let index = 0;
  while (index < line.length) {
    const code = line.charCodeAt(index);
    if (code !== 0x09 && code !== 0x20 && (code < 0x2500 || code > 0x257f)) break;
    index += 1;
  }
  if (line[index] !== ">" && line[index] !== "❯") return null;
  index += 1;
  while (line[index] === " " || line[index] === "\t") index += 1;
  return line.slice(index);
}

function activeInputSlice(capture) {
  const lines = lastLines(String(capture), 12).split(/\r?\n/);
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - 8); index -= 1) {
    const line = lines[index];
    if (activeInputLineText(line) === null) continue;
    return [line, ...lines.slice(index + 1)].join("\n");
  }
  return "";
}

function activeInputFirstLine(capture) {
  const activeInput = activeInputSlice(capture);
  if (!activeInput) return "";
  const firstLine = activeInput.split(/\r?\n/, 1)[0] ?? "";
  return (activeInputLineText(firstLine) ?? "")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .trim();
}

function captureWithoutPromptText(capture) {
  return String(capture).replace(
    /^([ \t\u2502\u2503\u2551]*(?:>|❯))(?!(?:[ \t]*(?:\d+[.)]|yes\b|no\b))).*$/gim,
    "$1"
  );
}

function remoteUrlFromCapture(capture) {
  const matches = String(capture).match(new RegExp(REMOTE_URL_RE.source, "g"));
  return matches?.at(-1) ?? "";
}

// If a prompt is still visible in Claude's active input area after Enter, the
// terminal did not submit it. This is more precise than searching the whole
// capture because submitted prompts can remain visible in the transcript.
export function activeInputContainsText(capture, value) {
  const snippets = promptSnippets(value);
  if (snippets.length === 0) return false;
  const activeInput = activeInputSlice(capture);
  if (!activeInput) return false;
  const compactInput = compactTerminalWhitespace(activeInput);
  return snippets.some((snippet) => compactInput.includes(snippet));
}

function lastMatchIndex(value, pattern) {
  let last = -1;
  for (const match of value.matchAll(pattern)) {
    if (typeof match.index === "number") last = match.index;
  }
  return last;
}

function lastMatchEnd(value, pattern) {
  let last = -1;
  for (const match of value.matchAll(pattern)) {
    if (typeof match.index === "number") {
      last = match.index + match[0].length;
    }
  }
  return last;
}

function activeTuiControlRegion(capture, lines = 80) {
  const recent = captureWithoutPromptText(lastLines(capture, lines));
  const phaseBoundary = Math.max(
    lastMatchEnd(recent, BUSY_CAPTURE_MATCH_RE),
    lastMatchEnd(recent, BUSY_STATUS_LINE_MATCH_RE),
    lastMatchEnd(recent, BUSY_TIMED_STATUS_LINE_MATCH_RE),
    lastMatchEnd(recent, DYNAMIC_WORKFLOW_WAIT_MATCH_RE),
    lastMatchEnd(recent, COMPLETE_CAPTURE_MATCH_RE),
    lastMatchEnd(recent, COMPLETE_INLINE_CAPTURE_MATCH_RE)
  );
  return phaseBoundary >= 0 ? recent.slice(phaseBoundary) : recent;
}

function likelyBusyFromCapture(capture) {
  const signalCapture = captureWithoutPromptText(capture);
  const busyIndex = Math.max(
    lastMatchIndex(signalCapture, BUSY_CAPTURE_MATCH_RE),
    lastMatchIndex(signalCapture, BUSY_STATUS_LINE_MATCH_RE),
    lastMatchIndex(signalCapture, BUSY_TIMED_STATUS_LINE_MATCH_RE),
    lastMatchIndex(signalCapture, DYNAMIC_WORKFLOW_WAIT_MATCH_RE)
  );
  if (busyIndex === -1) return false;

  const completeIndex = Math.max(
    lastMatchIndex(signalCapture, COMPLETE_CAPTURE_MATCH_RE),
    lastMatchIndex(signalCapture, COMPLETE_INLINE_CAPTURE_MATCH_RE)
  );
  return completeIndex === -1 || completeIndex < busyIndex;
}

function terminalWorkflowActivityFromCapture(capture) {
  const signalCapture = captureWithoutPromptText(capture);
  let waitIndex = -1;
  let pendingCount = null;
  for (const match of signalCapture.matchAll(DYNAMIC_WORKFLOW_WAIT_MATCH_RE)) {
    if (typeof match.index === "number" && match.index >= waitIndex) {
      waitIndex = match.index;
      pendingCount = Number(match[1]);
    }
  }
  const completeIndex = Math.max(
    lastMatchIndex(signalCapture, COMPLETE_CAPTURE_MATCH_RE),
    lastMatchIndex(signalCapture, COMPLETE_INLINE_CAPTURE_MATCH_RE)
  );
  const pending =
    waitIndex >= 0 &&
    Number.isInteger(pendingCount) &&
    pendingCount > 0 &&
    (completeIndex < 0 || completeIndex < waitIndex);
  return {
    pending,
    pendingCount: pending ? pendingCount : null,
    evidence: pending ? "terminal_heuristic" : "",
  };
}

function sessionLimitWarningFromCapture(capture) {
  return SESSION_LIMIT_RE.test(activeTuiControlRegion(capture, 40));
}

function approvalRequiredFromCapture(capture) {
  const recent = activeTuiControlRegion(capture, 40);
  return (
    APPROVAL_QUESTION_RE.test(recent) &&
    APPROVAL_CHOICE_RE.test(recent)
  );
}

function pastePlaceholderFromCapture(capture) {
  return (
    PASTE_PLACEHOLDER_RE.test(activeInputSlice(capture)) ||
    PASTE_PLACEHOLDER_RE.test(activeTuiControlRegion(capture, 40))
  );
}

function interruptedPromptFromCapture(capture) {
  return INTERRUPTED_PROMPT_RE.test(activeTuiControlRegion(capture, 40));
}

function workspaceTrustPromptFromCapture(capture) {
  const recent = activeTuiControlRegion(capture, 40);
  return (
    WORKSPACE_TRUST_QUESTION_RE.test(recent) &&
    WORKSPACE_TRUST_YES_RE.test(recent) &&
    WORKSPACE_TRUST_NO_RE.test(recent)
  );
}

function permissionModeFromCapture(capture) {
  const recent = activeTuiControlRegion(capture, 80);
  let mode = "";
  for (const match of recent.matchAll(PERMISSION_INDICATOR_RE)) {
    mode = (match[1] || match[2] || "").trim();
  }
  return mode;
}

function effortEventFromCapture(capture) {
  const recentCapture = activeTuiControlRegion(capture, 80);
  let event = null;
  for (const match of recentCapture.matchAll(EFFORT_INDICATOR_RE)) {
    if (!event || match.index >= event.index) {
      event = { kind: "active", effort: match[1].toLowerCase(), index: match.index };
    }
  }
  for (const match of recentCapture.matchAll(EFFORT_SET_RE)) {
    if (!event || match.index >= event.index) {
      event = { kind: "active", effort: match[1].toLowerCase(), index: match.index };
    }
  }
  for (const match of recentCapture.matchAll(ULTRACODE_STATUS_RE)) {
    if (!event || match.index >= event.index) {
      event = { kind: "active", effort: "ultracode", index: match.index };
    }
  }
  const unavailablePattern = new RegExp(ULTRACODE_UNAVAILABLE_RE.source, "gi");
  for (const match of recentCapture.matchAll(unavailablePattern)) {
    if (!event || match.index >= event.index) {
      event = { kind: "unavailable", effort: "", index: match.index };
    }
  }
  return event;
}

export function captureSignals(capture) {
  const recentCapture = lastLines(capture, 80);
  const likelyBusy = likelyBusyFromCapture(recentCapture);
  const terminalWorkflowActivity = terminalWorkflowActivityFromCapture(recentCapture);
  const sessionLimitWarning = sessionLimitWarningFromCapture(capture);
  const approvalRequired = approvalRequiredFromCapture(capture);
  const pastePlaceholder = pastePlaceholderFromCapture(capture);
  const interruptedPrompt = interruptedPromptFromCapture(capture);
  const workspaceTrustPrompt = workspaceTrustPromptFromCapture(capture);
  const effortEvent = effortEventFromCapture(capture);
  const effortIndicator = effortEvent?.kind === "active" ? effortEvent.effort : "";
  const ultracodeActive = effortIndicator === "ultracode";
  const ultracodeUnavailable = effortEvent?.kind === "unavailable";
  const permissionModeIndicator = permissionModeFromCapture(capture);
  const activeInputHasText = activeInputFirstLine(capture).trim().length > 0;
  const exited = /^\[managed session exited,/m.test(capture);
  let state = "idle";
  if (exited) state = "exited";
  else if (approvalRequired) state = "approval_required";
  else if (interruptedPrompt) state = "interrupted";
  else if (workspaceTrustPrompt) state = "workspace_trust_required";
  else if (sessionLimitWarning) state = "limit_warning";
  else if (pastePlaceholder) state = "paste_pending";
  else if (activeInputHasText) state = "awaiting_input";
  else if (likelyBusy) state = "busy";
  return {
    remoteUrl: remoteUrlFromCapture(capture),
    likelyBusy,
    sessionLimitWarning,
    approvalRequired,
    pastePlaceholder,
    interruptedPrompt,
    workspaceTrustPrompt,
    effortIndicator,
    effortEvidence: effortEvent ? "terminal_heuristic" : "",
    ultracodeActive,
    ultracodeUnavailable,
    permissionModeIndicator,
    permissionModeEvidence: permissionModeIndicator ? "terminal_heuristic" : "",
    activeInputHasText,
    workflowPending: terminalWorkflowActivity.pending,
    workflowPendingCount: terminalWorkflowActivity.pendingCount,
    workflowPendingEvidence: terminalWorkflowActivity.evidence,
    workflowPendingObservedAt: "",
    state,
  };
}

export function signalsWithWorkflowActivity(signals = {}, workflowActivity = {}) {
  const baseState = signals.state || "idle";
  const logPendingCount = Number.isInteger(workflowActivity.pendingCount)
    ? workflowActivity.pendingCount
    : null;
  const logPending = logPendingCount !== null && logPendingCount > 0;
  const terminalPending = signals.workflowPending === true;
  const workflowPending = logPending || terminalPending;
  const workflowPendingEvidence = logPending
    ? workflowActivity.evidence || "claude_session_log"
    : terminalPending
      ? signals.workflowPendingEvidence || "terminal_heuristic"
      : logPendingCount !== null
        ? workflowActivity.evidence || "claude_session_log"
        : "";
  const workflowPendingCount = logPending
    ? logPendingCount
    : terminalPending
      ? signals.workflowPendingCount
      : logPendingCount;
  return {
    ...signals,
    likelyBusy: Boolean(signals.likelyBusy || workflowPending),
    workflowPending,
    workflowPendingCount,
    workflowPendingEvidence,
    workflowPendingObservedAt: logPendingCount !== null
      ? workflowActivity.pendingObservedAt || workflowActivity.lastObservedAt || ""
      : signals.workflowPendingObservedAt || "",
    state:
      workflowPending && baseState === "idle"
        ? "busy"
        : baseState,
  };
}

function emptyWorkflowActivity() {
  return {
    state: "not_observed",
    launchObserved: false,
    launchStatus: null,
    pendingCount: null,
    pendingObservedAt: "",
    lastObservedAt: "",
    evidence: "",
    triggerAttribution: "unknown",
  };
}

function environmentCategoryFingerprint(environment) {
  if (!environment) return "";
  return JSON.stringify({
    status: environment.status,
    effortOverrideStatus: environment.effortOverrideStatus,
    workflowsDisabled: environment.workflowsDisabled,
    blockers: environment.blockers,
  });
}

function assessUltracodePosture(
  requested,
  resolved,
  signals,
  priorObserved,
  launchEnvironment = null
) {
  const requestedUltracode = Boolean(requested?.ultracode ?? resolved?.ultracode);
  const runtimeEffort = priorObserved.effort || null;
  const terminalEffort = signals.effortIndicator || null;
  const workflowActivity = priorObserved.workflowActivity ?? emptyWorkflowActivity();
  const currentMcpEnvironment = ultracodeEnvironmentStatus();
  const environmentComparison = !launchEnvironment
    ? "launch_not_recorded"
    : environmentCategoryFingerprint(launchEnvironment) ===
        environmentCategoryFingerprint(currentMcpEnvironment)
      ? "match"
      : "different";
  const sessionUltracodeObserved =
    priorObserved.ultracode === true &&
    priorObserved.evidence?.ultracode === "claude_session_log";
  const conflictSources = [];
  for (const [source, effort] of [
    ["claude_session_log", runtimeEffort],
    ["terminal_heuristic", terminalEffort],
  ]) {
    if (requestedUltracode && effort && !["xhigh", "ultracode"].includes(effort)) {
      conflictSources.push({ source, effort });
    }
  }

  let status = "not_requested";
  let note = "UltraCode was not requested for this managed launch.";
  if (requestedUltracode) {
    status = "requested_unconfirmed";
    note = "The UltraCode launch request was resolved, but no independent runtime or workflow evidence is available yet.";
    if (launchEnvironment?.status === "blocking" && !sessionUltracodeObserved) {
      status = "environment_blocked";
      note = "The captured Claude child launch environment contains an override that blocks UltraCode workflow behavior.";
    } else if (conflictSources.length) {
      status = "conflicting_effort_evidence";
      note = "A bound runtime or terminal effort indicator conflicts with the requested UltraCode posture.";
    } else if (sessionUltracodeObserved) {
      status = "runtime_setting_observed";
      note = "An explicit UltraCode session-log indicator was observed.";
    } else if (signals.ultracodeUnavailable) {
      status = "rejected_terminal_heuristic";
      note = "Current terminal output appears to reject UltraCode. The terminal classification is heuristic evidence.";
    } else if (signals.ultracodeActive) {
      status = "terminal_indicator_heuristic";
      note = "Terminal output resembles an explicit UltraCode indicator, but terminal evidence is heuristic and does not authenticate runtime state.";
    } else if (workflowActivity.launchObserved || workflowActivity.pendingCount > 0) {
      status = "workflow_activity_observed";
      note = "Claude workflow activity was observed, but the session log does not attribute that activity specifically to UltraCode.";
    } else if (runtimeEffort === "xhigh" || terminalEffort === "xhigh") {
      status = "xhigh_correlated_unconfirmed";
      note = "xhigh effort is consistent with UltraCode, but xhigh alone does not prove that UltraCode workflow orchestration is active.";
    }
  }

  return {
    requested: requestedUltracode,
    launchMechanism: requestedUltracode
      ? resolved?.ultracodeMechanism ?? requested?.ultracodeMechanism ?? null
      : null,
    launchStatus: requestedUltracode ? "request_resolved_for_launch" : "not_requested",
    runtimeEffort,
    terminalEffort,
    workflowActivity,
    workflowTriggerAttribution: "unknown",
    environment: launchEnvironment ?? currentMcpEnvironment,
    launchEnvironment,
    currentMcpEnvironment,
    environmentComparison,
    conflict: conflictSources.length > 0,
    conflictSources,
    status,
    note,
  };
}

export function launchPostureReport(
  requested,
  resolved = requested,
  signals = {},
  priorObserved = {},
  { launchEnvironment = null } = {}
) {
  const priorPermissionMode = priorObserved.permissionMode || null;
  const priorEffort = priorObserved.effort || null;
  const priorUltracode =
    (priorObserved.ultracode === true || priorObserved.ultracode === false) &&
    priorObserved.evidence?.ultracode === "claude_session_log"
      ? priorObserved.ultracode
      : null;
  const observed = {
    permissionMode: priorPermissionMode || signals.permissionModeIndicator || null,
    model: priorObserved.model || null,
    effort: priorEffort || signals.effortIndicator || null,
    ultracode:
      priorUltracode !== null
        ? priorUltracode
        : signals.ultracodeActive
          ? true
          : signals.ultracodeUnavailable
            ? false
            : null,
    evidence: {
      permissionMode: priorPermissionMode
        ? priorObserved.evidence?.permissionMode || "observed"
        : signals.permissionModeIndicator
          ? "terminal_heuristic"
          : "",
      model: priorObserved.evidence?.model ?? "",
      effort: priorEffort
        ? priorObserved.evidence?.effort || "observed"
        : signals.effortIndicator
          ? "terminal_heuristic"
          : "",
      ultracode:
        priorUltracode !== null
          ? priorObserved.evidence?.ultracode || "observed"
          : signals.ultracodeActive || signals.ultracodeUnavailable
            ? "terminal_heuristic"
            : "",
    },
  };
  let verification = "requested_only";
  let note = "Launch values are requested CLI arguments, not confirmed effective runtime state.";
  const evidenceValues = Object.values(observed.evidence).filter(Boolean);
  if (evidenceValues.some((value) => value === "claude_session_log")) {
    verification = "session_log_observed";
    note =
      "Observed fields come from Claude's local session log when available; any remaining terminal-derived fields are identified separately as heuristics.";
  } else if (signals.ultracodeUnavailable) {
    verification = "ultracode_rejected_terminal_heuristic";
    note =
      "Terminal output appears to reject Ultracode, but mixed terminal text is heuristic evidence and must not be treated as authenticated runtime state.";
  } else if (requested?.ultracode && signals.ultracodeActive) {
    verification = "ultracode_observed_terminal_heuristic";
    note =
      "Terminal output resembles the Ultracode indicator. This is heuristic evidence only; model, permission mode, and effective Ultracode state remain unverified.";
  } else if (signals.effortIndicator) {
    verification = "effort_observed_terminal_heuristic";
    note = "Terminal output resembles an effort indicator, but effective effort, model, and permission mode remain unverified.";
  }
  return {
    requested: requested ?? null,
    resolved: resolved ?? requested ?? null,
    observed,
    verification,
    verificationByField: {
      permissionMode: observed.permissionMode ? observed.evidence.permissionMode || "observed" : "requested_only",
      model: observed.model ? observed.evidence.model || "observed" : "requested_only",
      effort: observed.effort ? observed.evidence.effort || "observed" : "requested_only",
      ultracode: observed.ultracode !== null ? observed.evidence.ultracode || "observed" : "requested_only",
    },
    ultracodeAssessment: assessUltracodePosture(
      requested,
      resolved,
      signals,
      priorObserved,
      launchEnvironment
    ),
    note,
  };
}

export function startupReadiness({ stillRunning, signals, remoteUrl, needsWorkspaceTrust, requestedUltracode }) {
  if (!stillRunning || signals.state === "exited") {
    return {
      status: "exited_during_startup",
      note: "Claude exited before Remote Control readiness could be confirmed.",
    };
  }
  if (needsWorkspaceTrust) {
    return {
      status: "needs_workspace_trust",
      note: "Workspace trust is still awaiting an explicit decision.",
    };
  }
  if (!remoteUrl) {
    return {
      status: "remote_control_not_ready",
      note: "The Claude process is running, but no Remote Control URL was tied to this managed session.",
    };
  }
  if (requestedUltracode && signals.ultracodeUnavailable) {
    return {
      status: "ultracode_attention_required",
      note: "Terminal output heuristically resembles an Ultracode rejection; inspect the live session.",
    };
  }
  return { status: "started", note: "" };
}

export function submitPreflightReason(signals) {
  if (signals.workflowPending) return "workflow_pending";
  if (signals.state === "exited") return "exited";
  if (signals.state === "limit_warning") return "limit_warning";
  if (signals.state === "approval_required") return "approval_required";
  if (signals.state === "interrupted") return "interrupted";
  if (signals.state === "workspace_trust_required") return "workspace_trust_required";
  if (signals.state === "busy") return "busy";
  if (signals.state === "paste_pending") return "paste_pending";
  if (signals.state === "awaiting_input") return "active_input_not_empty";
  return "";
}

export function lifecycleBlockReason(signals) {
  if (signals.workflowPending) return "workflow_pending";
  return signals.state === "idle" ? "" : signals.state;
}

export function submitResultStatus(signals, capture, promptText, { wasBusyBeforeSubmit = false } = {}) {
  if (signals.state === "exited") return { status: "exited", reason: "exited" };
  if (signals.state === "limit_warning") return { status: "needs_attention", reason: "limit_warning" };
  if (signals.state === "approval_required") return { status: "approval_required", reason: "approval_required" };
  if (signals.state === "interrupted") return { status: "needs_attention", reason: "interrupted" };
  if (signals.state === "workspace_trust_required") {
    return { status: "needs_attention", reason: "workspace_trust_required" };
  }
  if (signals.state === "paste_pending") return { status: "stuck_paste", reason: "paste_pending" };
  if (activeInputContainsText(capture, promptText)) {
    return {
      status: wasBusyBeforeSubmit ? "needs_attention" : "stuck_paste",
      reason: wasBusyBeforeSubmit ? "submitted_while_busy_active_input" : "active_input_not_submitted",
    };
  }
  if (signals.state === "busy") return { status: "submitted", reason: "" };
  if (signals.state === "awaiting_input") return { status: "needs_attention", reason: "active_input_not_empty" };
  return { status: "submitted", reason: "" };
}

export function textChunks(value, chunkSize) {
  const textValue = String(value);
  const safeChunkSize = clampInteger(chunkSize, DEFAULT_TEXT_CHUNK_SIZE, 256, 8192);
  const chunks = [];
  for (let start = 0; start < textValue.length; ) {
    let end = Math.min(textValue.length, start + safeChunkSize);
    if (
      end < textValue.length &&
      end > start &&
      /[\uD800-\uDBFF]/.test(textValue[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(textValue[end])
    ) {
      end -= 1;
    }
    chunks.push(textValue.slice(start, end));
    start = end;
  }
  return chunks;
}

// Translate the friendly key aliases this server accepts into tmux's canonical
// key-table names so a key like "Ctrl-C" or "Backspace" presses the real key on
// the tmux backend instead of being typed as literal characters.
function tmuxKeyName(key) {
  const names = {
    Return: "Enter",
    "C-m": "Enter",
    "Ctrl-M": "Enter",
    "C-j": "Enter",
    "Ctrl-J": "Enter",
    KPEnter: "Enter",
    NumpadEnter: "Enter",
    Esc: "Escape",
    "Ctrl-C": "C-c",
    "Ctrl-D": "C-d",
    Backspace: "BSpace",
  };
  return names[key] ?? key;
}

export function keySubmitsComposer(key) {
  return SUBMIT_KEY_NAMES.has(String(key));
}

async function backendExists(sessionName) {
  if (IS_NATIVE_WINDOWS) {
    const session = await managedWindowsBrokerSession(sessionName);
    return Boolean(session && !session.exited);
  }
  if (!(await tmuxExists(sessionName))) return false;
  return Boolean(await managedTmuxMetadata(sessionName));
}

async function backendCapture(sessionName, lines = 120, expectedMetadata = null) {
  if (IS_NATIVE_WINDOWS) {
    const session =
      expectedMetadata ?? (await managedWindowsBrokerSession(sessionName));
    if (!session) {
      const error = new Error(
        `No managed native Windows Claude session found: ${sessionName}`
      );
      error.code = "ENOENT";
      throw error;
    }
    const result = await windowsBrokerRequest(
      "capture",
      {
        sessionName,
        lines,
        expectedStartedAtMs: session.startedAtMs,
        expectedGenerationId: session.generationId,
      },
      { startIfMissing: false }
    );
    return result.capture;
  }
  return tmuxCapture(sessionName, lines);
}

async function backendStopUnlocked(sessionName, { graceful = false, force = true } = {}) {
  if (IS_NATIVE_WINDOWS) {
    try {
      const session = await managedWindowsBrokerSession(sessionName, {
        allowMissingCwdForStop: true,
      });
      if (!session) {
        return { status: "not_running", managedSession: sessionName };
      }
      const cleanupOnly = !fs.existsSync(session.cwd);
      return await windowsBrokerRequest(
        "stop",
        {
          sessionName,
          graceful,
          force,
          omitCapture: cleanupOnly,
          expectedStartedAtMs: session.startedAtMs,
          expectedGenerationId: session.generationId,
          leaseId: brokerMutationLeases.get(sessionName),
        },
        { startIfMissing: false, timeoutMs: 20000 }
      );
    } catch (error) {
      if (brokerUnavailable(error)) {
        return { status: "not_running", managedSession: sessionName };
      }
      throw error;
    }
  }
  if (!(await tmuxExists(sessionName))) return { status: "not_running", managedSession: sessionName };
  const initialMetadata = await requireManagedTmuxSession(sessionName);
  if (graceful) {
    await backendSendText(sessionName, "/exit", true);
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (!(await tmuxExists(sessionName))) {
        return { status: "stopped", managedSession: sessionName, graceful: true };
      }
      const paneIdentity = await tmuxPaneIdentity(initialMetadata.paneId);
      if (
        !paneIdentity ||
        paneIdentity.sessionName !== sessionName ||
        paneIdentity.paneId !== initialMetadata.paneId ||
        paneIdentity.pid !== initialMetadata.pid
      ) {
        return killOwnedTmuxSession(sessionName, initialMetadata, {
          graceful: true,
          cleanedRemainingPanes: true,
        });
      }
      await sleep(100);
    }
    if (!force) {
      return {
        status: "graceful_stop_timeout",
        managedSession: sessionName,
        note: "Claude did not exit after /exit. Retry with force=true only after confirming the session can be terminated.",
      };
    }
  }
  return killOwnedTmuxSession(sessionName, initialMetadata);
}

async function backendCleanupStopUnlocked(sessionName) {
  if (!IS_NATIVE_WINDOWS) {
    return backendStopUnlocked(sessionName, {
      graceful: false,
      force: true,
    });
  }
  const brokerStatus = await probeWindowsBroker();
  if (brokerStatus?.compatible === false) {
    const error = new Error(
      "Windows broker build or Claude launch policy does not match this MCP process."
    );
    error.code = "EBROKERUPGRADE";
    throw error;
  }
  const session = brokerStatus?.managedSessions?.find(
    (candidate) => candidate.name === sessionName
  );
  if (!session) {
    return { status: "not_running", managedSession: sessionName };
  }
  try {
    resolveAllowedCleanupCwd(session.cwd, session.canonicalCwd);
  } catch (error) {
    if (
      ["EOUTOFSCOPE", "ECWDPROVENANCE", "ECWDUNAVAILABLE"].includes(
        error?.code
      )
    ) {
      const scopedError = new Error(
        "Managed session is outside this MCP process's allowed cleanup scope."
      );
      scopedError.code = error.code;
      throw scopedError;
    }
    throw error;
  }
  try {
    return await windowsBrokerRequest(
      "stop",
      {
        sessionName,
        graceful: false,
        force: true,
        omitCapture: true,
        expectedStartedAtMs: session.startedAtMs,
        expectedGenerationId: session.generationId,
        leaseId: brokerMutationLeases.get(sessionName),
      },
      { startIfMissing: false, timeoutMs: 20000 }
    );
  } catch (error) {
    if (brokerUnavailable(error)) {
      return { status: "not_running", managedSession: sessionName };
    }
    throw error;
  }
}

async function backendSendText(sessionName, value, submit, options = {}) {
  const chunkSize = options.chunkSize ?? DEFAULT_TEXT_CHUNK_SIZE;
  const chunkDelayMs = options.chunkDelayMs ?? DEFAULT_TEXT_CHUNK_DELAY_MS;
  if (IS_NATIVE_WINDOWS) {
    const session =
      options.metadata ?? (await managedWindowsBrokerSession(sessionName));
    if (!session || session.exited) {
      const error = new Error(
        `No running managed native Windows Claude session found: ${sessionName}`
      );
      error.code = "ENOENT";
      throw error;
    }
    const textValue = String(value);
    const chunkCount = Math.max(1, Math.ceil(textValue.length / chunkSize));
    const estimatedMs =
      Math.max(0, chunkCount - 1) * chunkDelayMs +
      (submit ? options.submitSettleMs ?? 100 : 0) +
      5000;
    return windowsBrokerRequest(
      "sendText",
      {
        sessionName,
        text: textValue,
        submit: Boolean(submit),
        bracketedPaste: Boolean(options.bracketedPaste),
        chunkSize,
        chunkDelayMs,
        submitSettleMs: options.submitSettleMs ?? 100,
        expectedStartedAtMs: session.startedAtMs,
        expectedGenerationId: session.generationId,
        leaseId: brokerMutationLeases.get(sessionName),
      },
      { timeoutMs: Math.max(30000, estimatedMs) }
    );
  }
  const metadata = await requireManagedTmuxSession(sessionName);
  const textValue = String(value);
  const bufferName = `rail-${process.pid}-${randomUUID().replaceAll("-", "")}`;
  const loaded = await tmuxWithInput(["load-buffer", "-b", bufferName, "-"], textValue, { timeoutMs: 15000 });
  if (!loaded.ok) throw new Error(loaded.stderr || `Unable to load tmux paste buffer for ${sessionName}.`);
  const pasteArgs = ["paste-buffer", "-r", "-d", "-b", bufferName, "-t", metadata.paneId];
  if (options.bracketedPaste) pasteArgs.splice(1, 0, "-p");
  const pasted = await tmux(pasteArgs, { timeoutMs: 15000 });
  if (!pasted.ok) {
    await tmux(["delete-buffer", "-b", bufferName], { timeoutMs: 5000 });
    throw new Error(pasted.stderr || `Unable to paste text into managed tmux session ${sessionName}.`);
  }
  if (submit) {
    await sleep(options.submitSettleMs ?? 100);
    const submitted = await tmux(["send-keys", "-t", metadata.paneId, "Enter"], { timeoutMs: 5000 });
    if (!submitted.ok) throw new Error(submitted.stderr || `Unable to submit text in managed tmux session ${sessionName}.`);
  }
  await sleep(500);
  return {
    status: "sent",
    bracketedPasteRequested: Boolean(options.bracketedPaste),
    bracketedPasteUsed: Boolean(options.bracketedPaste),
  };
}

async function backendSendKey(sessionName, key, expectedMetadata = null) {
  if (IS_NATIVE_WINDOWS) {
    const session =
      expectedMetadata ?? (await managedWindowsBrokerSession(sessionName));
    if (!session || session.exited) {
      const error = new Error(
        `No running managed native Windows Claude session found: ${sessionName}`
      );
      error.code = "ENOENT";
      throw error;
    }
    await windowsBrokerRequest("sendKey", {
      sessionName,
      key,
      expectedStartedAtMs: session.startedAtMs,
      expectedGenerationId: session.generationId,
      leaseId: brokerMutationLeases.get(sessionName),
    });
    return;
  }
  const metadata = await requireManagedTmuxSession(sessionName);
  const sent = await tmux(["send-keys", "-t", metadata.paneId, tmuxKeyName(key)], { timeoutMs: 5000 });
  if (!sent.ok) throw new Error(sent.stderr || `Unable to send key to managed tmux session ${sessionName}.`);
  await sleep(500);
}

export async function recentSessionRecords(
  metadata,
  maxBytes = 2 * 1024 * 1024
) {
  if (!metadata?.cwd || !metadata?.resolvedSessionId) return [];
  const resolvedSessionId = String(metadata.resolvedSessionId);
  if (!SESSION_ID_RE.test(resolvedSessionId)) return [];
  const file = path.join(
    projectDirFromCwd(metadata.cwd),
    `${resolvedSessionId}.jsonl`
  );
  let stat;
  try {
    stat = await fs.promises.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return [];
  const bytes = Math.min(stat.size, maxBytes);
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, Math.max(0, stat.size - bytes));
    let value = buffer.subarray(0, bytesRead).toString("utf8");
    if (bytes < stat.size) {
      const newline = value.indexOf("\n");
      value = newline >= 0 ? value.slice(newline + 1) : "";
    }
    const records = [];
    for (const line of value.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (recordMatchesSession(record, metadata.resolvedSessionId)) records.push(record);
      } catch {
        // Ignore an incomplete trailing line while Claude is appending.
      }
    }
    return records;
  } finally {
    await handle.close();
  }
}

export function runtimeObservationFromRecords(records, metadata = {}) {
  const state = createSessionSummaryState();
  for (const record of records) addRuntimeObservationRecord(state, record, metadata);
  return runtimeObservationFromState(state);
}

function addRuntimeObservationRecord(state, record, metadata = {}) {
  const launchStartedAtMs = Number(metadata?.startedAtMs);
  if (Number.isFinite(launchStartedAtMs)) {
    const recordTimestampMs = Date.parse(record.timestamp ?? "");
    if (
      !Number.isFinite(recordTimestampMs) ||
      recordTimestampMs < launchStartedAtMs - 5000
    ) {
      return;
    }
  }
  addSessionRecord(state, record, metadata?.resolvedSessionId, false);
}

function runtimeObservationFromState(state) {
  const ultracodeObserved = state.effort === "ultracode" ? true : null;
  const workflowActivityObserved =
    state.workflowLaunchObserved || state.pendingWorkflowCount !== null;
  const workflowState = state.workflowLaunchObserved
    ? state.pendingWorkflowCount > 0
      ? "pending"
      : "launch_observed"
    : state.pendingWorkflowCount > 0
      ? "pending_without_launch_record"
      : state.pendingWorkflowCount === 0
        ? "idle_count_observed"
        : "not_observed";
  return {
    permissionMode: state.permissionMode || null,
    model: state.model || null,
    effort: state.effort || null,
    ultracode: ultracodeObserved,
    workflowActivity: {
      state: workflowState,
      launchObserved: state.workflowLaunchObserved,
      launchStatus: state.workflowLaunchStatus || null,
      pendingCount: state.pendingWorkflowCount,
      pendingObservedAt: state.pendingWorkflowUpdatedAt || "",
      lastObservedAt:
        state.pendingWorkflowUpdatedAt || state.workflowLaunchUpdatedAt || "",
      evidence: workflowActivityObserved ? "claude_session_log" : "",
      triggerAttribution: "unknown",
    },
    evidence: {
      permissionMode: state.permissionMode ? "claude_session_log" : "",
      model: state.model ? "claude_session_log" : "",
      effort: state.effort ? "claude_session_log" : "",
      ultracode: ultracodeObserved === true ? "claude_session_log" : "",
    },
  };
}

const runtimeObservationCache = new Map();
const runtimeObservationLoads = new Map();
const MAX_RUNTIME_OBSERVATION_CACHE_ENTRIES = 128;
const RUNTIME_OBSERVATION_READ_BYTES = 256 * 1024;

function runtimeObservationLogFile(metadata) {
  if (!metadata?.cwd || !metadata?.resolvedSessionId) return "";
  const resolvedSessionId = String(metadata.resolvedSessionId);
  if (!SESSION_ID_RE.test(resolvedSessionId)) return "";
  return path.join(projectDirFromCwd(metadata.cwd), `${resolvedSessionId}.jsonl`);
}

function runtimeObservationCacheKey(metadata, file) {
  return [
    file,
    metadata?.resolvedSessionId ?? "",
    Number(metadata?.startedAtMs) || 0,
  ].join("\0");
}

function newRuntimeObservationCacheEntry(stat) {
  return {
    fileIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
    offset: 0,
    remainder: "",
    decoder: new StringDecoder("utf8"),
    state: createSessionSummaryState(),
  };
}

async function loadRuntimeObservation(metadata, file, key) {
  let stat;
  try {
    stat = await fs.promises.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return runtimeObservationFromState(createSessionSummaryState());
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return runtimeObservationFromState(createSessionSummaryState());
  }

  const fileIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  let entry = runtimeObservationCache.get(key);
  if (
    !entry ||
    entry.fileIdentity !== fileIdentity ||
    stat.size < entry.offset
  ) {
    entry = newRuntimeObservationCacheEntry(stat);
  }

  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.alloc(RUNTIME_OBSERVATION_READ_BYTES);
    while (entry.offset < stat.size) {
      const requestedBytes = Math.min(buffer.length, stat.size - entry.offset);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        requestedBytes,
        entry.offset
      );
      if (bytesRead <= 0) break;
      entry.offset += bytesRead;
      entry.remainder += entry.decoder.write(buffer.subarray(0, bytesRead));
      const lines = entry.remainder.split(/\r?\n/);
      entry.remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        try {
          addRuntimeObservationRecord(entry.state, JSON.parse(line), metadata);
        } catch {
          // Ignore malformed records without discarding later append-only evidence.
        }
      }
    }
  } finally {
    await handle.close();
  }

  runtimeObservationCache.delete(key);
  runtimeObservationCache.set(key, entry);
  while (runtimeObservationCache.size > MAX_RUNTIME_OBSERVATION_CACHE_ENTRIES) {
    runtimeObservationCache.delete(runtimeObservationCache.keys().next().value);
  }
  return runtimeObservationFromState(entry.state);
}

export async function sessionRuntimeObservation(metadata) {
  const file = runtimeObservationLogFile(metadata);
  if (!file) return runtimeObservationFromState(createSessionSummaryState());
  const key = runtimeObservationCacheKey(metadata, file);
  const prior = runtimeObservationLoads.get(key) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(() => loadRuntimeObservation(metadata, file, key));
  runtimeObservationLoads.set(key, current);
  try {
    return await current;
  } finally {
    if (runtimeObservationLoads.get(key) === current) runtimeObservationLoads.delete(key);
  }
}

async function promptAcknowledgedInSession(
  sessionName,
  promptText,
  sinceMs,
  expectedMetadata = null
) {
  const metadata =
    expectedMetadata ?? (await backendLaunchMetadata(sessionName));
  for (const record of await recentSessionRecords(metadata)) {
    if (
      record.message?.role !== "user" ||
      record.isMeta === true ||
      record.isSidechain === true
    ) {
      continue;
    }
    const timestampMs = Date.parse(record.timestamp ?? "");
    if (!Number.isFinite(timestampMs) || timestampMs < sinceMs - 2000) continue;
    if (firstTextFromMessage(record.message) === String(promptText)) return true;
  }
  return false;
}

async function managedSessionTitle(metadata) {
  const state = createSessionSummaryState();
  for (const record of await recentSessionRecords(metadata)) {
    addSessionRecord(state, record, metadata?.resolvedSessionId);
  }
  return currentSessionTitle(state);
}

export function transcriptSnapshotFromRecords(records, resolvedSessionId = null) {
  let lastUser = null;
  let lastAssistant = null;
  let lastUserIndex = -1;
  let lastAssistantIndex = -1;
  for (const [recordIndex, record] of records.entries()) {
    if (!recordMatchesSession(record, resolvedSessionId)) continue;
    const conversationMessage = conversationMessageFromRecord(record);
    if (!conversationMessage) continue;
    const { role, body } = conversationMessage;
    if (role === "user") {
      lastUserIndex = recordIndex;
      lastUser = {
        cursor: record.uuid || record.promptId || record.timestamp || "",
        timestamp: record.timestamp ?? "",
        text: body.slice(0, 4000),
      };
    }
    if (role === "assistant") {
      lastAssistantIndex = recordIndex;
      lastAssistant = {
        cursor: record.uuid || record.message?.id || record.timestamp || "",
        timestamp: record.timestamp ?? "",
        text: body.slice(0, MAX_TRANSCRIPT_ASSISTANT_CHARS),
        textLength: body.length,
        textTruncated: body.length > MAX_TRANSCRIPT_ASSISTANT_CHARS,
        stopReason: record.message?.stop_reason ?? null,
        model: record.message?.model ?? null,
        effort: record.effort ?? null,
      };
    }
  }
  const turnComplete =
    Boolean(
      lastAssistant?.cursor &&
        TERMINAL_STOP_REASONS.has(String(lastAssistant.stopReason || ""))
    ) &&
    (lastUserIndex < 0 || lastAssistantIndex > lastUserIndex);
  return {
    resolvedSessionId,
    lastUser,
    lastAssistant,
    turnComplete,
  };
}

export function waitTurnDecision({
  afterCursor,
  baselineTranscript = {},
  transcript = {},
  signals = {},
  requireNewTurn = false,
  submittedAfterMs = null,
}) {
  const assistantCursor = transcript.lastAssistant?.cursor || "";
  const userCursor = transcript.lastUser?.cursor || "";
  const assistantChanged = Boolean(
    assistantCursor &&
      assistantCursor !== (baselineTranscript.lastAssistant?.cursor || "")
  );
  const userChanged = Boolean(
    userCursor &&
      userCursor !== (baselineTranscript.lastUser?.cursor || "")
  );
  const explicitCursorChanged = Boolean(
    afterCursor && assistantCursor && assistantCursor !== afterCursor
  );
  const assistantTimestampMs = Date.parse(
    transcript.lastAssistant?.timestamp ?? ""
  );
  const assistantAfterSubmission = Boolean(
    submittedAfterMs !== null &&
      submittedAfterMs !== undefined &&
      Number.isFinite(Number(submittedAfterMs)) &&
      Number.isFinite(assistantTimestampMs) &&
      assistantTimestampMs >= Number(submittedAfterMs) - 2000
  );
  if (WAIT_STRONG_ATTENTION_STATES.has(signals.state)) {
    return { status: "needs_attention", evidence: signals.state };
  }
  if (signals.workflowPending) {
    if (WAIT_ATTENTION_STATES.has(signals.state)) {
      return { status: "needs_attention", evidence: signals.state };
    }
    return { status: "wait", evidence: "workflow_pending" };
  }
  if (
    transcript.turnComplete &&
    (afterCursor
      ? explicitCursorChanged &&
        (!requireNewTurn || userChanged || assistantAfterSubmission)
      : assistantChanged &&
        (!requireNewTurn || userChanged || assistantAfterSubmission))
  ) {
    return {
      status: "completed",
      evidence: afterCursor ? "after_cursor_changed" : "new_transcript_record",
      attention: WAIT_ATTENTION_STATES.has(signals.state)
        ? signals.state
        : "",
    };
  }
  if (WAIT_ATTENTION_STATES.has(signals.state)) {
    return { status: "needs_attention", evidence: signals.state };
  }
  if (
    !afterCursor &&
    !requireNewTurn &&
    transcript.turnComplete &&
    signals.state === "idle"
  ) {
    return { status: "completed", evidence: "latest_settled_turn" };
  }
  return { status: "wait", evidence: "" };
}

function transcriptCursorBaseline(transcript = {}) {
  return {
    lastUser: transcript.lastUser?.cursor
      ? { cursor: transcript.lastUser.cursor }
      : null,
    lastAssistant: transcript.lastAssistant?.cursor
      ? { cursor: transcript.lastAssistant.cursor }
      : null,
  };
}

export function createPortableWaitCursor(
  transcript = {},
  metadata = {},
  submittedAfterMs = Date.now()
) {
  const payload = {
    a: transcript.lastAssistant?.cursor || "",
    u: transcript.lastUser?.cursor || "",
    t: Number(submittedAfterMs),
    s: metadata?.resolvedSessionId || "",
    g: metadata?.generationId || "",
  };
  return `${PORTABLE_WAIT_CURSOR_PREFIX}${Buffer.from(
    JSON.stringify(payload),
    "utf8"
  ).toString("base64url")}`;
}

export function parsePortableWaitCursor(value) {
  const cursor = String(value || "");
  if (!cursor.startsWith(PORTABLE_WAIT_CURSOR_PREFIX)) {
    return {
      portable: false,
      assistantCursor: cursor || NO_ASSISTANT_CURSOR,
      userCursor: "",
      submittedAfterMs: null,
      resolvedSessionId: "",
      generationId: "",
    };
  }
  try {
    const payload = JSON.parse(
      Buffer.from(
        cursor.slice(PORTABLE_WAIT_CURSOR_PREFIX.length),
        "base64url"
      ).toString("utf8")
    );
    for (const field of ["a", "u", "s", "g"]) {
      if (
        typeof payload[field] !== "string" ||
        payload[field].length > 128
      ) {
        throw new Error(`invalid ${field}`);
      }
    }
    if (!Number.isFinite(payload.t) || payload.t <= 0) {
      throw new Error("invalid t");
    }
    return {
      portable: true,
      assistantCursor: payload.a || NO_ASSISTANT_CURSOR,
      userCursor: payload.u,
      submittedAfterMs: payload.t,
      resolvedSessionId: payload.s,
      generationId: payload.g,
    };
  } catch {
    const error = new Error(
      "afterCursor is not a valid Rail Connector wait cursor."
    );
    error.code = "EINVAL";
    throw error;
  }
}

function waitAfterCursor(transcript, metadata, submittedAfterMs) {
  return createPortableWaitCursor(
    transcript,
    metadata,
    submittedAfterMs
  );
}

function pendingTurnAnchor(
  metadata,
  baselineTranscript,
  submittedAfterMs = Date.now()
) {
  return {
    startedAtMs: metadata.startedAtMs,
    generationId: metadata.generationId ?? null,
    afterCursor: waitAfterCursor(
      baselineTranscript,
      metadata,
      submittedAfterMs
    ),
    baselineTranscript: transcriptCursorBaseline(baselineTranscript),
    submittedAfterMs,
    createdAtMs: Date.now(),
  };
}

function rememberedTurnAnchor(sessionName) {
  const anchor = pendingTurnAnchors.get(sessionName) ?? null;
  if (
    anchor &&
    Date.now() - (anchor.createdAtMs ?? 0) > PENDING_TURN_ANCHOR_TTL_MS
  ) {
    pendingTurnAnchors.delete(sessionName);
    return null;
  }
  return anchor;
}

function submitResultStartedTurn(result) {
  return Boolean(
    result.transcriptAcknowledged ||
      result.status === "submitted" ||
      result.status === "approval_required" ||
      (result.status === "needs_attention" &&
        [
          "limit_warning",
          "interrupted",
          "workspace_trust_required",
        ].includes(result.reason))
  );
}

async function sessionTranscriptSnapshot(metadata) {
  return transcriptSnapshotFromRecords(
    await recentSessionRecords(metadata),
    metadata?.resolvedSessionId ?? null
  );
}

export async function runSubmitPrompt(
  input,
  {
    capture = backendCapture,
    sendText = backendSendText,
    sendKey = backendSendKey,
    delay = sleep,
    promptAcknowledged = promptAcknowledgedInSession,
    runtimeObservation = async () => ({ workflowActivity: emptyWorkflowActivity() }),
  } = {}
) {
  const sessionName = managedSessionName(input);
  const requestedPasteMode = input.pasteMode ?? "auto";
  const lines = clampInteger(input.lines, 160, 20, 1000);
  const submitRetries = clampInteger(input.submitRetries, 1, 0, 2);
  const retryDelayMs = clampInteger(input.retryDelayMs, DEFAULT_SUBMIT_RETRY_DELAY_MS, 250, 5000);
  const chunkSize = clampInteger(input.chunkSize, DEFAULT_TEXT_CHUNK_SIZE, 256, 8192);
  const chunkDelayMs = clampInteger(input.chunkDelayMs, DEFAULT_TEXT_CHUNK_DELAY_MS, 0, 100);
  const bracketedPaste = requestedPasteMode === "bracketed" || requestedPasteMode === "auto";
  const observedSignals = async (captureText) => {
    const observation = await runtimeObservation();
    return signalsWithWorkflowActivity(
      captureSignals(captureText),
      observation?.workflowActivity
    );
  };
  let capturedText = await capture(sessionName, lines);
  const preflightSignals = await observedSignals(capturedText);
  const preflightReason = submitPreflightReason(preflightSignals);
  if (preflightReason && !input.force) {
    return {
      status: "preflight_blocked",
      reason: preflightReason,
      managedSession: sessionName,
      forceUsed: false,
      pasteMode: bracketedPaste ? "bracketed" : "literal",
      requestedPasteMode,
      retriesUsed: 0,
      capture: capturedText,
      signals: preflightSignals,
    };
  }

  const submittedAtMs = Date.now();
  const sendResult = await sendText(sessionName, input.text, true, {
    bracketedPaste,
    chunkSize,
    chunkDelayMs,
  });
  const bracketedPasteUsed =
    sendResult?.bracketedPasteUsed === undefined
      ? bracketedPaste
      : Boolean(sendResult.bracketedPasteUsed);

  let retriesUsed = 0;
  let transcriptAcknowledged = await promptAcknowledged(sessionName, input.text, submittedAtMs);
  capturedText = await capture(sessionName, lines);
  retryLoop: for (let i = 0; i < submitRetries && !transcriptAcknowledged; i += 1) {
    let retryReady = false;
    for (let poll = 0; poll < SUBMIT_RETRY_VISIBILITY_POLLS; poll += 1) {
      await delay(retryDelayMs);
      capturedText = await capture(sessionName, lines);
      const signals = await observedSignals(capturedText);
      transcriptAcknowledged =
        transcriptAcknowledged || (await promptAcknowledged(sessionName, input.text, submittedAtMs));
      if (
        transcriptAcknowledged ||
        (signals.likelyBusy && !activeInputContainsText(capturedText, input.text)) ||
        signals.approvalRequired ||
        signals.sessionLimitWarning ||
        signals.interruptedPrompt ||
        signals.workspaceTrustPrompt
      ) {
        break retryLoop;
      }
      if (signals.pastePlaceholder || activeInputContainsText(capturedText, input.text)) {
        retryReady = true;
        break;
      }
    }
    if (!retryReady) break;
    await sendKey(sessionName, "Enter");
    retriesUsed += 1;
  }

  capturedText = await capture(sessionName, lines);
  const signals = await observedSignals(capturedText);
  transcriptAcknowledged =
    transcriptAcknowledged || (await promptAcknowledged(sessionName, input.text, submittedAtMs));
  const result = transcriptAcknowledged
    ? { status: "submitted", reason: "" }
    : submitResultStatus(signals, capturedText, input.text, {
        wasBusyBeforeSubmit: preflightSignals.state === "busy",
      });
  return {
    status: result.status,
    reason: result.reason || undefined,
    managedSession: sessionName,
    forceUsed: Boolean(input.force && preflightReason),
    forcedPastReason:
      input.force && preflightReason ? preflightReason : undefined,
    pasteMode: bracketedPasteUsed ? "bracketed" : "literal",
    requestedPasteMode,
    bracketedPasteRequested: bracketedPaste,
    bracketedPasteUsed,
    retriesUsed,
    transcriptAcknowledged,
    capture: capturedText,
    signals,
  };
}

// Poll the capture until a marker appears or the timeout elapses, instead of
// guessing a fixed sleep. Returns the last capture seen either way.
async function pollCapture(
  sessionName,
  matcher,
  {
    timeoutMs,
    intervalMs = 250,
    lines = 140,
    expectedMetadata = null,
  }
) {
  const deadline = Date.now() + timeoutMs;
  let pane = "";
  for (;;) {
    try {
      pane = await backendCapture(
        sessionName,
        lines,
        expectedMetadata
      );
    } catch {
      // Session may have just died; keep the last good capture.
    }
    if (matcher(pane) || Date.now() >= deadline) return pane;
    await sleep(intervalMs);
  }
}

function cliOptionBlock(helpOutput, flag) {
  const start = helpOutput.indexOf(flag);
  if (start < 0) return "";
  const remainder = helpOutput.slice(start + flag.length);
  const nextOption = remainder.search(/\n {2}(?:-[A-Za-z],\s*)?--[A-Za-z]/);
  return nextOption < 0
    ? helpOutput.slice(start, start + 1200)
    : helpOutput.slice(start, start + flag.length + nextOption);
}

function optionBlockLists(block, value) {
  return new RegExp(`(?:^|[\\s,(\"])${value}(?:$|[\\s,)\"])`, "i").test(block);
}

function quotedOptionChoices(block) {
  return [...block.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((match) => match[1]);
}

function claudeVersionAtLeast(versionOutput, required) {
  const match = String(versionOutput).match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const current = match.slice(1).map(Number);
  for (let index = 0; index < required.length; index += 1) {
    if (current[index] > required[index]) return true;
    if (current[index] < required[index]) return false;
  }
  return true;
}

function probeExitOutcome(probe, prefix = "") {
  const key = (name) =>
    prefix ? `${prefix}${name[0].toUpperCase()}${name.slice(1)}` : name;
  const attempted = probe[key("attempted")] === true;
  const succeeded = probe[key("succeeded")];
  const explicitExitCode = probe[key("exitCode")];
  const exitCode = Number.isInteger(explicitExitCode)
    ? explicitExitCode
    : succeeded === true
      ? 0
      : succeeded === false
        ? 1
        : null;
  const timedOut = probe[key("timedOut")] === true;
  const terminated =
    probe[key("terminated")] === true ||
    typeof probe[key("signal")] === "string";
  const completed =
    attempted && !timedOut && !terminated && Number.isInteger(exitCode);
  return {
    attempted,
    completed,
    exitCode,
    timedOut,
    terminated,
    accepted: completed && exitCode === 0,
    rejected: completed && exitCode !== 0,
  };
}

function ultracodeProbeStatus(probe = {}) {
  const attempted = probe.attempted === true;
  const output = [probe.stdout, probe.stderr, probe.error]
    .filter((value) => typeof value === "string")
    .join("\n");
  const controlOutput = [probe.controlStdout, probe.controlStderr, probe.controlError]
    .filter((value) => typeof value === "string")
    .join("\n");
  const validOutcome = probeExitOutcome(probe);
  const controlOutcome = probeExitOutcome(probe, "control");
  const rejectionTextMatched =
    /(?:unknown|invalid|unsupported)\s+--effort\s+value[^\r\n]*ultracode/i.test(
      output
    );
  const controlRejectionTextMatched =
    /(?:unknown|invalid|unsupported)\s+--effort\s+value[^\r\n]*rail-invalid-probe/i.test(
      controlOutput
    );
  const rejected = validOutcome.rejected;
  const controlAttempted = controlOutcome.attempted;
  const controlRejected = controlOutcome.rejected;
  const accepted = validOutcome.accepted && controlRejected;
  const excluded =
    validOutcome.timedOut ||
    validOutcome.terminated ||
    controlOutcome.timedOut ||
    controlOutcome.terminated;
  return {
    attempted,
    accepted,
    rejected,
    controlAttempted,
    controlRejected,
    exitCode: validOutcome.exitCode,
    controlExitCode: controlOutcome.exitCode,
    validProbeCompleted: validOutcome.completed,
    controlProbeCompleted: controlOutcome.completed,
    timedOut: validOutcome.timedOut,
    controlTimedOut: controlOutcome.timedOut,
    terminated: validOutcome.terminated,
    controlTerminated: controlOutcome.terminated,
    rejectionTextMatched,
    controlRejectionTextMatched,
    evidenceBasis: "exit_status_calibrated",
    result: !attempted
      ? "not_run"
      : excluded
        ? "inconclusive"
      : accepted
        ? "accepted"
        : rejected
          ? "rejected"
          : "inconclusive",
  };
}

export function parseClaudeCapabilities(
  versionOutput,
  helpOutput,
  command = "claude",
  ultracodeProbe = {}
) {
  const effortBlock = cliOptionBlock(helpOutput, "--effort <level>");
  const permissionBlock = cliOptionBlock(helpOutput, "--permission-mode <mode>");
  const advertisedEffortLevels = CLAUDE_EFFORT_LEVELS.filter((level) => optionBlockLists(effortBlock, level));
  const advertisedUltracode = optionBlockLists(effortBlock, "ultracode");
  if (advertisedUltracode) advertisedEffortLevels.push("ultracode");
  const quotedPermissionModes = quotedOptionChoices(permissionBlock);
  const advertisedPermissionModes = quotedPermissionModes.length
    ? [...new Set(quotedPermissionModes)]
    : CLAUDE_PERMISSION_MODES.filter((mode) => optionBlockLists(permissionBlock, mode));
  const settingsFlagAvailable = helpOutput.includes("--settings <file-or-json>");
  const versionSupportsDirectUltracode = claudeVersionAtLeast(
    versionOutput,
    ULTRACODE_DIRECT_VERSION_FLOOR
  );
  const argumentProbe = ultracodeProbeStatus(ultracodeProbe);
  const directUltracodeAvailable =
    !argumentProbe.rejected &&
    (advertisedUltracode || argumentProbe.accepted || versionSupportsDirectUltracode);
  const ultracodeLaunchMechanism = directUltracodeAvailable
    ? "effort_flag"
    : settingsFlagAvailable
      ? "experimental_session_settings"
      : "unavailable";
  let capabilityStatus = "unavailable";
  if (argumentProbe.rejected) capabilityStatus = "rejected";
  else if (advertisedUltracode) capabilityStatus = "advertised";
  else if (argumentProbe.accepted) capabilityStatus = "accepted_unadvertised";
  else if (versionSupportsDirectUltracode) {
    capabilityStatus = argumentProbe.attempted
      ? "officially_supported_probe_inconclusive"
      : "officially_supported_unprobed";
  } else if (settingsFlagAvailable) capabilityStatus = "experimental_settings_only";

  let supportSource = "unavailable";
  if (argumentProbe.rejected) supportSource = "parser_probe_rejected";
  else if (advertisedUltracode) supportSource = "help_advertised";
  else if (argumentProbe.accepted) supportSource = "parser_probe";
  else if (versionSupportsDirectUltracode) supportSource = "official_version_contract";
  else if (settingsFlagAvailable) supportSource = "experimental_settings";
  const bypassPolicy = bypassPolicyStatus();
  return {
    available: true,
    command,
    version: versionOutput.trim(),
    advertised: {
      effortLevels: advertisedEffortLevels,
      permissionModes: advertisedPermissionModes,
      settingsFlag: settingsFlagAvailable,
      remoteControlFlag: helpOutput.includes("--remote-control"),
      safeModeFlag: helpOutput.includes("--safe-mode"),
    },
    mcp: {
      effortLevels: [...CLAUDE_EFFORT_LEVELS],
      permissionModes: [...CLAUDE_PERMISSION_MODES],
      versionSensitivePermissionModes: [...VERSION_SENSITIVE_PERMISSION_MODES],
      bypassPermissionsRequiresConfirmation: true,
      bypassPermissionsEnabled: bypassPolicy.enabled,
      bypassPermissionsPolicyMode: bypassPolicy.mode,
      bypassPermissionsPolicyConfigured: bypassPolicy.configured,
      bypassPermissionsPolicyRecognized: bypassPolicy.recognized,
      bypassPermissionsPolicyAcceptedValues: bypassPolicy.acceptedValues,
      bypassPermissionsRequiresPolicyAcknowledgement: true,
      bypassPermissionsPolicyEnvironment: BYPASS_POLICY_ENV,
      bypassPermissionsPolicyReadAtProcessStart: true,
      bypassPermissionsPolicyRelaunchRequiredAfterChange: true,
    },
    ultracode: {
      advertisedAsEffort: advertisedUltracode,
      supportedByInstalledVersion: versionSupportsDirectUltracode,
      directLaunchVersionFloor: ULTRACODE_DIRECT_VERSION_FLOOR.join("."),
      documentationUrl: ULTRACODE_DOCUMENTATION_URL,
      capabilityStatus,
      supportSource,
      argumentProbe,
      environment: ultracodeEnvironmentStatus(),
      mcpLaunchRequestAvailable: directUltracodeAvailable,
      experimentalSessionSettingsRequestAvailable: !directUltracodeAvailable && settingsFlagAvailable,
      launchMechanism: ultracodeLaunchMechanism,
      accountAndPolicyStatus: "unverified_no_authoritative_runtime_state",
      note: argumentProbe.rejected
        ? "The calibrated parser probe rejected --effort=ultracode. Help advertisement and version coverage remain provenance only and do not override that rejection."
        : directUltracodeAvailable
        ? "The installed Claude CLI accepts or is covered by the documented direct UltraCode effort request, so the MCP uses --effort=ultracode. Acceptance, runtime effort, and workflow evidence are reported separately."
        : settingsFlagAvailable
          ? "The installed Claude CLI exposes generic session settings but does not advertise Ultracode. The MCP can make an explicitly confirmed experimental settings request, but support and activation remain unverified."
          : "The installed Claude CLI exposes no supported Ultracode launch path.",
    },
  };
}

function existingExecutable(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCommandFromPath(
  command,
  {
    platform = process.platform,
    pathValue = process.env.PATH ?? "",
    pathExtValue = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
  } = {}
) {
  const requested = String(command);
  if (path.isAbsolute(requested)) {
    return existingExecutable(requested, platform) ? normalizeForPathCompare(requested) : "";
  }

  const pathEntries = String(pathValue)
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry && path.isAbsolute(entry));
  const requestedExtension = path.extname(requested);
  let extensions = [""];
  if (platform === "win32" && !requestedExtension) {
    const configured = String(pathExtValue)
      .split(";")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    extensions = [...new Set([".exe", ".cmd", ".bat", ".com", ...configured])];
  }

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory, `${requested}${extension}`);
      if (existingExecutable(candidate, platform)) return normalizeForPathCompare(candidate);
    }
  }
  return "";
}

function resolveClaudeCommand() {
  const configured = process.env[CLAUDE_COMMAND_ENV];
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(`${CLAUDE_COMMAND_ENV} must be an absolute executable path: ${configured}`);
    }
    const resolved = resolveCommandFromPath(configured);
    if (!resolved) throw new Error(`${CLAUDE_COMMAND_ENV} does not point to an executable file: ${configured}`);
    return resolved;
  }
  const resolved = resolveCommandFromPath("claude");
  if (!resolved) {
    throw new Error(
      `Unable to resolve Claude from PATH entries. Install Claude Code in this OS context or set ${CLAUDE_COMMAND_ENV} to its absolute executable path.`
    );
  }
  return resolved;
}

function windowsCommandLineValue(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function windowsPtyLaunchDescriptor(
  command,
  args,
  { platform = process.platform, env = process.env } = {}
) {
  const commandArgs = (args || []).map(String);
  if (
    platform === "win32" &&
    [".cmd", ".bat"].includes(path.extname(String(command)).toLowerCase())
  ) {
    const commandProcessor =
      env.ComSpec ||
      (env.SystemRoot ? path.join(env.SystemRoot, "System32", "cmd.exe") : "cmd.exe");
    const commandLine = [
      windowsCommandLineValue(command),
      ...commandArgs.map(windowsCommandLineValue),
    ].join(" ");
    return {
      command: commandProcessor,
      args: [],
      commandLine: `/d /s /c "${commandLine}"`,
      metadataCommand: String(command),
      metadataArgs: commandArgs,
    };
  }
  return {
    command: String(command),
    args: commandArgs,
    metadataCommand: String(command),
    metadataArgs: commandArgs,
  };
}

async function execClaudeCommand(command, args, options) {
  if (IS_NATIVE_WINDOWS && [".cmd", ".bat"].includes(path.extname(command).toLowerCase())) {
    const commandProcessor =
      process.env.ComSpec ||
      (process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "cmd.exe") : "cmd.exe");
    const commandLine = [windowsCommandLineValue(command), ...args.map(windowsCommandLineValue)].join(" ");
    return execFileAsync(commandProcessor, ["/d", "/s", "/c", `"${commandLine}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return execFileAsync(command, args, options);
}

async function runClaudeArgumentProbe(command, args) {
  try {
    const result = await execClaudeCommand(command, args, {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return {
      attempted: true,
      succeeded: true,
      exitCode: 0,
      timedOut: false,
      terminated: false,
      signal: null,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const timedOut = error?.code === "ETIMEDOUT" || error?.killed === true;
    return {
      attempted: true,
      succeeded: false,
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      timedOut,
      terminated: Boolean(error?.signal),
      signal: typeof error?.signal === "string" ? error.signal : null,
      stdout: error?.stdout,
      stderr: error?.stderr,
      error: error?.message,
    };
  }
}

function claudeCapabilityCacheKey(command) {
  let executableIdentity = "unavailable";
  try {
    const stat = fs.statSync(command);
    executableIdentity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    // The uncached inspection reports an unreadable executable.
  }
  const environment = ultracodeEnvironmentStatus();
  const policy = bypassPolicyStatus();
  return createHash("sha256")
    .update(
      JSON.stringify({
        command: normalizeForPathCompare(command),
        executableIdentity,
        environment: environmentCategoryFingerprint(environment),
        bypassPolicyMode: policy.mode,
      })
    )
    .digest("hex");
}

async function inspectClaudeCapabilitiesUncached(command) {
  try {
    const [versionResult, helpResult, ultracodeProbe, ultracodeControlProbe] = await Promise.all([
      execClaudeCommand(command, ["--version"], { timeout: 10000, maxBuffer: 1024 * 1024 }),
      execClaudeCommand(command, ["--help"], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 }),
      runClaudeArgumentProbe(command, ["--effort=ultracode", "--version"]),
      runClaudeArgumentProbe(command, [
        "--effort=rail-invalid-probe",
        "--version",
      ]),
    ]);
    return parseClaudeCapabilities(versionResult.stdout, helpResult.stdout, command, {
      ...ultracodeProbe,
      controlAttempted: ultracodeControlProbe.attempted,
      controlSucceeded: ultracodeControlProbe.succeeded,
      controlExitCode: ultracodeControlProbe.exitCode,
      controlTimedOut: ultracodeControlProbe.timedOut,
      controlTerminated: ultracodeControlProbe.terminated,
      controlSignal: ultracodeControlProbe.signal,
      controlStdout: ultracodeControlProbe.stdout,
      controlStderr: ultracodeControlProbe.stderr,
      controlError: ultracodeControlProbe.error,
    });
  } catch (error) {
    const policy = bypassPolicyStatus();
    return {
      available: false,
      command,
      error: error.stderr || error.message,
      mcp: {
        effortLevels: [...CLAUDE_EFFORT_LEVELS],
        permissionModes: [...CLAUDE_PERMISSION_MODES],
        versionSensitivePermissionModes: [...VERSION_SENSITIVE_PERMISSION_MODES],
        bypassPermissionsRequiresConfirmation: true,
        bypassPermissionsEnabled: policy.enabled,
        bypassPermissionsPolicyMode: policy.mode,
        bypassPermissionsPolicyConfigured: policy.configured,
        bypassPermissionsPolicyRecognized: policy.recognized,
        bypassPermissionsPolicyAcceptedValues: policy.acceptedValues,
        bypassPermissionsRequiresPolicyAcknowledgement: true,
        bypassPermissionsPolicyEnvironment: BYPASS_POLICY_ENV,
        bypassPermissionsPolicyReadAtProcessStart: true,
        bypassPermissionsPolicyRelaunchRequiredAfterChange: true,
      },
    };
  }
}

async function inspectClaudeCapabilities(command = resolveClaudeCommand()) {
  const key = claudeCapabilityCacheKey(command);
  const now = Date.now();
  const cached = claudeCapabilityCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  if (cached) claudeCapabilityCache.delete(key);

  const promise = inspectClaudeCapabilitiesUncached(command);
  claudeCapabilityCache.set(key, {
    expiresAt: now + CLAUDE_CAPABILITY_CACHE_TTL_MS,
    promise,
  });
  for (const [cacheKey, entry] of claudeCapabilityCache) {
    if (entry.expiresAt <= now) claudeCapabilityCache.delete(cacheKey);
  }
  while (claudeCapabilityCache.size > MAX_CLAUDE_CAPABILITY_CACHE_ENTRIES) {
    claudeCapabilityCache.delete(claudeCapabilityCache.keys().next().value);
  }
  return promise;
}

export function resolveLaunchOptionsFromCapabilities(options, capabilities) {
  const needsUltracodeInspection = options.ultracode && !options.ultracodeMechanism;
  const needsEffortInspection = Boolean(options.effort);
  if (capabilities.available === false) {
    throw new Error(`Claude capability inspection failed: ${capabilities.error}`);
  }
  if (
    needsUltracodeInspection &&
    capabilities.ultracode?.environment?.status === "blocking"
  ) {
    throw new Error(
      `The MCP process environment blocks UltraCode: ${capabilities.ultracode.environment.blockers.join(", ")}. Remove the blocking Claude override and restart the MCP process.`
    );
  }
  if (needsEffortInspection && !capabilities.advertised?.effortLevels?.includes(options.effort)) {
    throw new Error(`The installed Claude CLI does not advertise effort level ${options.effort}.`);
  }
  const requestedPermissionMode = options.requestedPermissionMode ?? options.permissionMode ?? "default";
  const advertisedPermissionModes = capabilities.advertised?.permissionModes ?? [];
  let permissionMode = requestedPermissionMode;
  if (requestedPermissionMode === "default") {
    if (advertisedPermissionModes.includes("default")) permissionMode = "default";
    else if (advertisedPermissionModes.includes("manual")) permissionMode = "manual";
    else throw new Error("The installed Claude CLI advertises neither default nor manual permission mode.");
  } else if (requestedPermissionMode === "manual") {
    if (advertisedPermissionModes.includes("manual")) permissionMode = "manual";
    else if (advertisedPermissionModes.includes("default")) permissionMode = "default";
    else throw new Error("The installed Claude CLI advertises neither manual nor default permission mode.");
  } else if (!advertisedPermissionModes.includes(requestedPermissionMode)) {
    throw new Error(`The installed Claude CLI does not advertise permission mode ${requestedPermissionMode}.`);
  }
  const resolved = { ...options, requestedPermissionMode, permissionMode };
  if (!needsUltracodeInspection) return resolved;
  const ultracodeMechanism =
    capabilities.ultracode?.launchMechanism === "effort_flag"
      ? "effort"
      : capabilities.ultracode?.launchMechanism === "experimental_session_settings"
        ? "settings"
        : null;
  if (!ultracodeMechanism) {
    throw new Error("The installed Claude CLI exposes no supported or explicitly confirmed experimental Ultracode launch path.");
  }
  return { ...resolved, ultracodeMechanism };
}

async function prepareLaunchOptions(options, claudeCommand) {
  return {
    ...resolveLaunchOptionsFromCapabilities(options, await inspectClaudeCapabilities(claudeCommand)),
    claudeCommand,
  };
}

async function backendStartUnlocked({
  sessionName,
  cwd,
  killExisting,
  forceKillExisting = false,
  ...launchOptions
}) {
  const resolvedCwd = resolveAllowedCwd(cwd);
  const canonicalResolvedCwd =
    fs.realpathSync.native?.(resolvedCwd) ?? fs.realpathSync(resolvedCwd);
  assertBypassPolicy(launchOptions.permissionMode);
  const claudeCommand = resolveClaudeCommand();
  const preparedLaunchOptions = await prepareLaunchOptions(launchOptions, claudeCommand);
  const rawSessionExists = IS_NATIVE_WINDOWS ? await backendExists(sessionName) : await tmuxExists(sessionName);
  let windowsReplacement = null;
  let replacementAudit = {
    forceUsed: false,
    workflowInterrupted: false,
  };
  if (rawSessionExists) {
    if (!IS_NATIVE_WINDOWS) await requireManagedTmuxSession(sessionName);
    const existing = await backendLaunchMetadata(sessionName);
    if (!killExisting) {
      const requestedArgs = claudeArgs(preparedLaunchOptions);
      const requestedMetadata = {
        cwd: resolvedCwd,
        args: requestedArgs,
        requestedPosture: requestedLaunchPosture(preparedLaunchOptions),
        resolvedPosture: resolvedLaunchPosture(preparedLaunchOptions),
      };
      const comparison = compareLaunchMetadata(existing, requestedMetadata);
      const note =
        comparison.comparison === "mismatch"
          ? "The existing managed session was launched with a different cwd or posture. Inspect both requested postures; pass killExisting=true only after confirming replacement."
          : comparison.comparison === "unknown"
            ? "The existing managed session has no readable launch metadata, so its posture cannot be compared. Inspect the capture before replacing it."
            : "The existing managed session matches the requested launch arguments.";
      return {
        status: "already_running",
        capture: await backendCapture(sessionName, 80, existing),
        existingSession: publicLaunchMetadata(existing),
        existingRequestedPosture: existing?.requestedPosture ?? null,
        existingResolvedPosture: existing?.resolvedPosture ?? existing?.requestedPosture ?? null,
        requestedArgs,
        requestedPosture: requestedMetadata.requestedPosture,
        launchMismatch: comparison.launchMismatch,
        launchComparison: comparison.comparison,
        note,
      };
    }
    const existingCapture = await backendCapture(
      sessionName,
      120,
      existing
    );
    const existingObservation = await sessionRuntimeObservation(existing);
    const existingSignals = signalsWithWorkflowActivity(
      captureSignals(existingCapture),
      existingObservation.workflowActivity
    );
    const replacementBlockReason = lifecycleBlockReason(existingSignals);
    if (replacementBlockReason && !forceKillExisting) {
      throw new Error(
        `Refusing to replace managed session ${sessionName} (${replacementBlockReason}). Wait for it to become idle or pass forceKillExisting=true after reviewing the capture.`
      );
    }
    replacementAudit = {
      forceUsed: Boolean(forceKillExisting && replacementBlockReason),
      workflowInterrupted: Boolean(
        forceKillExisting && existingSignals.workflowPending
      ),
    };
    if (IS_NATIVE_WINDOWS) {
      windowsReplacement = {
        graceful: !replacementBlockReason,
        force: forceKillExisting,
        expectedStartedAtMs: existing?.startedAtMs ?? null,
        expectedGenerationId: existing?.generationId ?? null,
      };
    } else {
      const stopResult = await backendStopUnlocked(sessionName, {
        graceful: !replacementBlockReason,
        force: forceKillExisting,
      });
      if (stopResult.status !== "stopped" && stopResult.status !== "not_running") {
        throw new Error(`Unable to replace managed session ${sessionName}: ${stopResult.status}.`);
      }
    }
  }

  const sessionLogSnapshot = snapshotSessionLogs(resolvedCwd);
  const args = claudeArgs(preparedLaunchOptions);
  const startedAtMs = Date.now();
  const childEnvironment = {
    ...process.env,
    CLAUDE_CONFIG_DIR,
    FORCE_COLOR: "1",
  };
  const launchEnvironment =
    claudeChildLaunchEnvironmentStatus(childEnvironment);
  const launchMetadata = createLaunchMetadata({
    cwd: resolvedCwd,
    args,
    startedAtMs,
    launchOptions: preparedLaunchOptions,
    launchEnvironment,
    resolvedSessionId:
      preparedLaunchOptions.newSessionId ??
      (!preparedLaunchOptions.forkSession ? preparedLaunchOptions.sessionId ?? null : null),
  });
  if (IS_NATIVE_WINDOWS) {
    const brokerOperation = windowsReplacement ? "replace" : "start";
    const ptyLaunch = windowsPtyLaunchDescriptor(claudeCommand, args);
    const brokerResult = await windowsBrokerRequest(brokerOperation, {
      sessionName,
      ...ptyLaunch,
      cols: 140,
      rows: 40,
      cwd: resolvedCwd,
      canonicalCwd: canonicalResolvedCwd,
      env: childEnvironment,
      requestedPosture: launchMetadata.requestedPosture,
      resolvedPosture: launchMetadata.resolvedPosture,
      launchEnvironment,
      resolvedSessionId: launchMetadata.resolvedSessionId,
      expectedStartedAtMs:
        windowsReplacement?.expectedStartedAtMs ?? undefined,
      expectedGenerationId:
        windowsReplacement?.expectedGenerationId ?? undefined,
      leaseId: brokerMutationLeases.get(sessionName),
      leaseTtlMs: BROKER_LEASE_TTL_MS,
      graceful: windowsReplacement?.graceful ?? false,
      force: windowsReplacement?.force ?? false,
    });
    if (brokerResult.status === "replace_failed") {
      throw new Error(
        `Unable to replace managed session ${sessionName}: ${brokerResult.stopResult?.status ?? "unknown"}.`
      );
    }
    if (brokerResult.status === "already_running") {
      return {
        status: "already_running",
        capture: brokerResult.capture,
        existingSession: publicLaunchMetadata(brokerResult.metadata),
        existingRequestedPosture: brokerResult.metadata?.requestedPosture ?? null,
        existingResolvedPosture: brokerResult.metadata?.resolvedPosture ?? null,
        requestedArgs: args,
        requestedPosture: launchMetadata.requestedPosture,
        launchMismatch: null,
        launchComparison: "race_detected",
        note: "Another MCP process started this managed session before this launch completed.",
      };
    }
    return {
      status: "started",
      capture: "",
      startedAtMs: brokerResult.metadata?.startedAtMs ?? startedAtMs,
      generationId: brokerResult.metadata?.generationId ?? null,
      args,
      launchMetadata,
      sessionLogSnapshot,
      replacementAudit,
    };
  }

  const started = await tmux(
    [
      "new-session",
      "-d",
      ...tmuxChildEnvironmentArgs(childEnvironment),
      "-s",
      sessionName,
      "-c",
      resolvedCwd,
      claudeCommand,
      ...args,
    ],
    { timeoutMs: 10000 }
  );
  if (!started.ok) throw new Error(started.stderr || "Failed to start tmux session");
  const paneIdentity = await tmuxPaneIdentity(sessionName);
  if (!paneIdentity || paneIdentity.sessionName !== sessionName) {
    await tmux(["kill-session", "-t", sessionName], { timeoutMs: 5000 });
    throw new Error("Unable to establish tmux pane identity for the managed Claude session.");
  }
  launchMetadata.paneId = paneIdentity.paneId;
  launchMetadata.pid = paneIdentity.pid;
  const metadataError = await writeTmuxLaunchMetadata(sessionName, launchMetadata);
  if (metadataError) {
    await tmux(["kill-session", "-t", sessionName], { timeoutMs: 5000 });
    throw new Error(`Unable to establish tmux session ownership: ${metadataError}`);
  }
  return {
    status: "started",
    capture: "",
    startedAtMs,
    args,
    launchMetadata,
    sessionLogSnapshot,
    replacementAudit,
  };
}

async function backendStart(options) {
  return backendStartUnlocked(options);
}

async function activeClaudeAgents(command = resolveClaudeCommand()) {
  try {
    const result = await execClaudeCommand(command, ["agents", "--json", "--all"], {
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((agent) => agent && Number.isInteger(agent.pid))
      .map((agent) => ({
        pid: agent.pid,
        cwd: typeof agent.cwd === "string" ? agent.cwd : "",
        kind: typeof agent.kind === "string" ? agent.kind : "",
        startedAt: Number.isFinite(agent.startedAt) ? agent.startedAt : null,
        sessionId: typeof agent.sessionId === "string" ? agent.sessionId : null,
        name: typeof agent.name === "string" ? agent.name : "",
      }));
  } catch {
    return [];
  }
}

async function processStatus(managedPids = []) {
  const safePids = managedPids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (safePids.length === 0) return "";
  try {
    const managedPidList = safePids.join(",");
    const processCommand = IS_NATIVE_WINDOWS
      ? [
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Get-Process -Id @(${managedPidList}) -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | Format-Table -AutoSize | Out-String`,
          ],
        ]
      : ["ps", ["-p", managedPidList, "-o", "pid=,comm="]];
    const result = await execFileAsync(processCommand[0], processCommand[1], { timeout: 5000 });
    return result.stdout;
  } catch (error) {
    return error.stdout ?? error.message;
  }
}

const server = new McpServer({
  name: "rail-connector-mcp",
  version: SERVER_VERSION,
});

const claudeToolRuleSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (value) =>
      !/[\u0000-\u001f\u007f]/.test(value) &&
      value.split(",").every((entry) => entry.trim() && !entry.trim().startsWith("-")),
    "Claude tool rules cannot contain control characters or entries beginning with '-'."
  );
const claudeToolListSchema = z
  .union([claudeToolRuleSchema, z.array(claudeToolRuleSchema.max(200)).min(1).max(50)])
  .optional();

server.registerTool(
  "list_claude_sessions",
  {
    description:
      "List local native Claude Code session logs for a project directory. Returns metadata by default; prompt/output snippets are optional.",
    inputSchema: {
      cwd: z.string().default(DEFAULT_CWD).describe("Project directory whose Claude sessions should be listed."),
      limit: z.number().int().min(1).max(100).default(20),
      query: z
        .string()
        .optional()
        .describe(
          "Case-insensitive search over session id, title, transcript text, URL, and observed posture. Matching does not disclose snippets or URL values unless their include flags are enabled."
        ),
      includeSnippets: z
        .boolean()
        .default(false)
        .describe("Include title and prompt/output snippets from local Claude logs. Defaults to false for metadata-only privacy."),
      includeRemoteUrls: z
        .boolean()
        .default(false)
        .describe("Include sensitive Remote Control URL values. Defaults to false; metadata reports only whether one exists."),
      scanLimit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(DEFAULT_SESSION_QUERY_SCAN_LIMIT)
        .describe("Maximum recent log files to inspect for search or archive filtering. The response reports when this bound is reached."),
      archiveState: z
        .enum(ARCHIVE_STATE_VALUES)
        .default("active")
        .describe("Filter the MCP-local archive catalog: active (default), archived, or all."),
    },
  },
  async ({ cwd, limit, query, includeSnippets, includeRemoteUrls, scanLimit, archiveState }) => {
    const projectDir = projectDirFromCwd(cwd);
    const result = await listClaudeSessionSummaries(projectDir, {
      limit,
      query,
      includeSnippets,
      includeRemoteUrls,
      scanLimit,
      archiveState,
    });
    return text({ platform: process.platform, projectDir, ...result });
  }
);

server.registerTool(
  "get_claude_session",
  {
    description:
      "Inspect a local native Claude Code session log by id. Returns recent user/assistant text and any Remote Control URL recorded in the log.",
    inputSchema: {
      sessionId: z.string(),
      cwd: z.string().default(DEFAULT_CWD),
      maxMessages: z.number().int().min(1).max(50).default(12),
    },
  },
  async ({ sessionId, cwd, maxMessages }) => {
    assertSafeSessionId(sessionId);
    const file = path.join(projectDirFromCwd(cwd), `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`No session log found: ${file}`);
    const result = await inspectSessionFile(file, maxMessages);
    const archive = await sessionArchiveInfo(projectDirFromCwd(cwd), sessionId);
    return text({ ...result, ...archive });
  }
);

server.registerTool(
  "start_remote_control",
  {
    description:
      "Start or resume a native Claude Code session with Remote Control enabled. Windows sessions are owned by a persistent per-user broker so Codex tasks can reconnect after refresh; Linux/macOS sessions use tmux.",
    inputSchema: {
      sessionId: z.string().optional().describe("Existing Claude session id to resume. Omit to start a fresh session."),
      resumeSessionName: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("Exact Claude conversation title to resolve to a UUID before launch."),
      newSessionId: z
        .string()
        .optional()
        .describe("Optional UUID to assign to a new Claude conversation. Do not combine with sessionId or continueLatest."),
      continueLatest: z
        .boolean()
        .default(false)
        .describe("Resolve the latest local conversation for this cwd to an exact UUID, then resume it."),
      forkSession: z
        .boolean()
        .default(false)
        .describe("Fork when resuming or continuing, using Claude's --fork-session. Requires sessionId or continueLatest."),
      cwd: z.string().default(DEFAULT_CWD).describe(`Project directory. If ${ALLOWED_ROOTS_ENV} is set, cwd must be inside one of those roots.`),
      managedSession: z.string().default(DEFAULT_MANAGED_SESSION).describe("Managed terminal session name."),
      tmuxSession: z.string().optional().describe("Deprecated alias for managedSession."),
      remoteName: z
        .string()
        .regex(/^[A-Za-z0-9 _.:@-]{1,64}$/)
        .refine((value) => !value.startsWith("-"), "Remote name cannot begin with '-'.")
        .default(DEFAULT_REMOTE_NAME)
        .describe("Remote Control display name. This does not rename the Claude conversation."),
      sessionTitle: z
        .string()
        .regex(/^[A-Za-z0-9 _.:@()#-]{1,80}$/)
        .refine((value) => !value.startsWith("-"), "Session title cannot begin with '-'.")
        .optional()
        .describe("Optional title for a new Claude conversation. Use rename_claude_session after launch for later changes."),
      permissionMode: z
        .enum(CLAUDE_PERMISSION_MODES)
        .default("default")
        .describe(
          `Semantic Claude permission mode. default resolves to the installed CLI's default/manual alias. bypassPermissions also requires confirmBypassPermissions and an acknowledged ${BYPASS_POLICY_ENV} policy.`
        ),
      model: z
        .string()
        .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
        .refine((value) => !value.startsWith("-"), "Model cannot begin with '-'.")
        .optional()
        .describe("Optional Claude model alias or full model name passed as --model."),
      effort: z.enum(CLAUDE_EFFORT_LEVELS).optional().describe("Optional Claude effort passed as --effort."),
      ultracode: z
        .boolean()
        .default(false)
        .describe(
          "Request session-scoped Ultracode. The MCP prefers an advertised effort value; generic settings are experimental and unverified. Do not combine with effort or safeMode."
        ),
      confirmUltracode: z
        .boolean()
        .default(false)
        .describe("Required with ultracode=true to acknowledge xhigh effort and dynamic workflow orchestration."),
      confirmBypassPermissions: z
        .boolean()
        .default(false)
        .describe(
          `Per-call acknowledgement required with bypassPermissions; the MCP process must separately acknowledge either local-host or isolated use through ${BYPASS_POLICY_ENV}.`
        ),
      allowedTools: claudeToolListSchema.describe("Optional Claude --allowedTools list. This pre-approves tools; it does not replace --tools."),
      disallowedTools: claudeToolListSchema.describe("Optional Claude --disallowedTools list. This denies specific tools."),
      tools: claudeToolListSchema.describe("Optional Claude --tools list. This controls the available built-in tool set."),
      safeMode: z.boolean().default(false).describe("Start Claude with --safe-mode for troubleshooting."),
      bare: z.boolean().default(false).describe("Start Claude with --bare. This may bypass normal keychain/OAuth configuration."),
      axScreenReader: z
        .boolean()
        .default(false)
        .describe("Start Claude with --ax-screen-reader for flatter terminal output when supported."),
      killExisting: z.boolean().default(false).describe("Kill an existing managed session with this name before starting."),
      forceKillExisting: z
        .boolean()
        .default(false)
        .describe("Permit replacement of a busy session and force termination if graceful exit fails."),
      trustWorkspace: z
        .boolean()
        .default(false)
        .describe("Accept Claude's workspace trust prompt only when that prompt is detected. Defaults to false."),
      resumeChoice: z
        .enum(["none", "summary", "full", "dont_ask"])
        .default("none")
        .describe("If Claude asks how to resume a large session, optionally choose summary, full, or don't ask again."),
    },
  },
  async (input) =>
    withManagedMutationLock(
      managedSessionName(input),
      async () => {
    const {
      sessionId: requestedSessionId,
      resumeSessionName,
      newSessionId,
      continueLatest,
      forkSession,
      cwd,
      remoteName,
      permissionMode,
      killExisting,
      forceKillExisting,
      trustWorkspace,
      resumeChoice,
    } = input;
    const resolvedCwd = resolveAllowedCwd(cwd);
    const resumeSelectors = [requestedSessionId, resumeSessionName, continueLatest ? "latest" : ""].filter(Boolean);
    if (resumeSelectors.length > 1) {
      throw new Error("sessionId, resumeSessionName, and continueLatest are mutually exclusive.");
    }
    let resolvedResumeSessionId = requestedSessionId;
    if (resolvedResumeSessionId) assertSafeSessionId(resolvedResumeSessionId);
    if (resumeSessionName) {
      resolvedResumeSessionId = await resolveClaudeSessionName(resolvedCwd, resumeSessionName);
    }
    if (continueLatest) {
      resolvedResumeSessionId = snapshotSessionLogs(resolvedCwd).latestSessionId;
      if (!resolvedResumeSessionId) {
        throw new Error(`No Claude session logs exist for continueLatest in ${resolvedCwd}.`);
      }
      assertSafeSessionId(resolvedResumeSessionId);
    }
    const effectiveNewSessionId =
      newSessionId ?? (!resolvedResumeSessionId ? randomUUID() : undefined);
    if (effectiveNewSessionId) assertSafeSessionId(effectiveNewSessionId);
    if (newSessionId && resolvedResumeSessionId) {
      throw new Error("newSessionId cannot be combined with any resume selector.");
    }
    if (forkSession && !resolvedResumeSessionId) throw new Error("forkSession requires a resumed session.");
    if (input.sessionTitle && resolvedResumeSessionId) {
      throw new Error("sessionTitle is only for a new conversation. Use rename_claude_session after resuming.");
    }
    if (input.safeMode && ["bypassPermissions", "dontAsk"].includes(permissionMode)) {
      throw new Error("safeMode cannot be combined with bypassPermissions or dontAsk.");
    }
    if (permissionMode === "bypassPermissions" && !input.confirmBypassPermissions) {
      throw new Error("bypassPermissions requires confirmBypassPermissions=true.");
    }
    if (input.ultracode && !input.confirmUltracode) {
      throw new Error("Ultracode requires confirmUltracode=true because it enables xhigh effort and dynamic workflows.");
    }
    if (input.ultracode && input.effort) {
      throw new Error("ultracode cannot be combined with effort; Ultracode selects xhigh internally.");
    }
    if (input.ultracode && input.safeMode) {
      throw new Error("ultracode cannot be combined with safeMode because safe mode disables workflows.");
    }
    const sessionName = managedSessionName(input);
    const backend = IS_NATIVE_WINDOWS ? "native-windows-broker" : "tmux";

    const started = await backendStart({
      sessionName,
      sessionId: resolvedResumeSessionId,
      newSessionId: effectiveNewSessionId,
      continueLatest: false,
      forkSession,
      cwd: resolvedCwd,
      remoteName,
      sessionTitle: input.sessionTitle,
      permissionMode,
      model: input.model,
      effort: input.effort,
      ultracode: input.ultracode,
      confirmUltracode: input.confirmUltracode,
      confirmBypassPermissions: input.confirmBypassPermissions,
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
      tools: input.tools,
      safeMode: input.safeMode,
      bare: input.bare,
      axScreenReader: input.axScreenReader,
      killExisting,
      forceKillExisting,
    });
    if (started.status === "already_running") {
      const existingMetadata = await backendLaunchMetadata(sessionName);
      const observation = await sessionRuntimeObservation(existingMetadata);
      const signals = signalsWithWorkflowActivity(
        captureSignals(started.capture),
        observation.workflowActivity
      );
      return text({
        ...started,
        backend,
        managedSession: sessionName,
        signals,
        posture: launchPostureReport(
          started.existingRequestedPosture,
          started.existingResolvedPosture,
          signals,
          observation,
          { launchEnvironment: existingMetadata?.launchEnvironment ?? null }
        ),
      });
    }
    pendingTurnAnchors.delete(sessionName);

    // Let Claude settle, then verify it actually stayed up. The most common
    // failure (Claude not authenticated on this OS account) makes it exit
    // immediately; surface that captured error instead of "no session found".
    await sleep(1500);
    if (!(await backendExists(sessionName))) {
      let deadCapture = "";
      const deadMetadata = await backendLaunchMetadata(sessionName);
      const exitCode = deadMetadata?.exitCode ?? null;
      try {
        deadCapture = await backendCapture(sessionName, 140, deadMetadata);
      } catch {
        // No terminal capture remains available.
      }
      const signals = captureSignals(deadCapture);
      const requestedPosture = started.launchMetadata?.requestedPosture ?? requestedLaunchPosture(input);
      const resolvedPosture =
        started.launchMetadata?.resolvedPosture ?? resolvedLaunchPosture({ ...input, permissionMode });
      return text({
        status: "exited_during_startup",
        backend,
        managedSession: sessionName,
        sessionId: resolvedResumeSessionId ?? effectiveNewSessionId ?? null,
        cwd: resolvedCwd,
        exitCode,
        capture: deadCapture,
        signals,
        posture: launchPostureReport(
          requestedPosture,
          resolvedPosture,
          signals,
          {},
          {
            launchEnvironment:
              deadMetadata?.launchEnvironment ??
              started.launchMetadata?.launchEnvironment ??
              null,
          }
        ),
        note: "Claude exited during startup. Most often this means Claude Code is not authenticated in this same OS context - run `claude` here, log in, then retry.",
      });
    }

    const startupMetadata = await backendLaunchMetadata(sessionName);
    let pane = await pollCapture(
      sessionName,
      (p) => REMOTE_URL_RE.test(p) || p.includes("Resume from summary") || workspaceTrustPromptFromCapture(p),
      { timeoutMs: 9000, expectedMetadata: startupMetadata }
    );

    let startupSignals = captureSignals(pane);
    let needsWorkspaceTrust = startupSignals.state === "workspace_trust_required";
    if (trustWorkspace && needsWorkspaceTrust) {
      try {
        await backendSendKey(sessionName, "Enter", startupMetadata);
        pane = await pollCapture(
          sessionName,
          (p) => REMOTE_URL_RE.test(p) || p.includes("Resume from summary"),
          { timeoutMs: 9000, expectedMetadata: startupMetadata }
        );
        startupSignals = captureSignals(pane);
        needsWorkspaceTrust = startupSignals.state === "workspace_trust_required";
      } catch {
        // Session may have exited between the check and the keypress.
      }
    }

    if (!needsWorkspaceTrust && resumeChoice !== "none" && pane.includes("Resume from summary")) {
      const key = resumeChoice === "summary" ? "1" : resumeChoice === "full" ? "2" : "3";
      try {
        await backendSendKey(sessionName, key, startupMetadata);
        await backendSendKey(sessionName, "Enter", startupMetadata);
      } catch {
        // Session gone; fall through with whatever was captured.
      }
      pane = await pollCapture(sessionName, (p) => REMOTE_URL_RE.test(p), {
        timeoutMs: 6000,
        expectedMetadata: startupMetadata,
      });
    }

    const expectedSessionId =
      effectiveNewSessionId ?? (!forkSession ? resolvedResumeSessionId ?? null : null);
    const capturedRemoteUrl = remoteUrlFromCapture(pane);
    const logResult = await waitForStartedSessionSummary(resolvedCwd, {
      expectedSessionId,
      forkSession,
      beforeSnapshot: started.sessionLogSnapshot,
      startedAtMs: started.startedAtMs,
      remoteUrl: capturedRemoteUrl,
    });
    const logSummary = logResult.summary;
    const logRemoteUrlTime = Date.parse(logSummary?.remoteUrlUpdatedAt ?? "");
    const currentLogRemoteUrl =
      logSummary?.remoteUrl && Number.isFinite(logRemoteUrlTime) && logRemoteUrlTime >= started.startedAtMs - 5000
        ? logSummary.remoteUrl
        : "";
    const remoteUrl = capturedRemoteUrl || currentLogRemoteUrl;
    const signals = captureSignals(pane);
    const stillRunning = await backendExists(sessionName);
    needsWorkspaceTrust = signals.state === "workspace_trust_required";
    const requestedPosture = started.launchMetadata?.requestedPosture ?? requestedLaunchPosture(input);
    const resolvedPosture =
      started.launchMetadata?.resolvedPosture ?? resolvedLaunchPosture({ ...input, permissionMode });
    const resolvedSessionId = logSummary?.sessionId ?? expectedSessionId ?? null;
    let metadataWarning = started.metadataWarning ?? null;
    if (resolvedSessionId) {
      try {
        await backendUpdateMetadata(
          sessionName,
          {
            resolvedSessionId,
            requestedPosture,
            resolvedPosture,
          },
          started.startedAtMs,
          started.generationId
        );
      } catch (error) {
        if (error?.code === "ESTALE") throw error;
        metadataWarning =
          `Claude started, but resolved session metadata could not be persisted: ${error?.message || String(error)}`;
      }
    }
    const currentMetadata = await backendLaunchMetadata(sessionName);
    const posture = await managedPostureReport(
      sessionName,
      signals,
      currentMetadata
    );
    const readiness = startupReadiness({
      stillRunning,
      signals,
      remoteUrl,
      needsWorkspaceTrust,
      requestedUltracode: input.ultracode,
    });

    return text({
      status: readiness.status,
      backend,
      managedSession: sessionName,
      sessionId: resolvedResumeSessionId ?? effectiveNewSessionId ?? null,
      resolvedSessionId,
      logFile: logSummary?.file ?? null,
      logBindingAmbiguous: logResult.ambiguous,
      logBindingStatus: logResult.bindingStatus,
      cwd: resolvedCwd,
      remoteUrl,
      permissionMode: resolvedPosture.permissionMode,
      permissionModeRequested: requestedPosture.permissionMode,
      permissionModeResolved: resolvedPosture.permissionMode,
      model: input.model ?? null,
      effort: input.ultracode ? "xhigh" : input.effort ?? null,
      effortRequested: input.effort ?? null,
      ultracode: input.ultracode,
      ultracodeRequested: input.ultracode,
      ultracodeMechanism: requestedPosture.ultracodeMechanism,
      continueLatest,
      resumedByName: resumeSessionName ?? null,
      forkSession,
      axScreenReader: input.axScreenReader,
      replacementForceUsed: started.replacementAudit?.forceUsed ?? false,
      workflowInterrupted:
        started.replacementAudit?.workflowInterrupted ?? false,
      needsWorkspaceTrust,
      metadataWarning,
      note: readiness.note || undefined,
      capture: pane,
      signals,
      posture,
    });
      },
      { allowMissingBackend: true }
    )
);

server.registerTool(
  "capture_remote_control",
  {
    description: "Capture visible terminal output from the managed native Rail Connector Control session.",
    inputSchema: {
      managedSession: z.string().default(DEFAULT_MANAGED_SESSION),
      tmuxSession: z.string().optional().describe("Deprecated alias for managedSession."),
      lines: z.number().int().min(20).max(1000).default(160),
    },
  },
  async (input) => {
    const sessionName = managedSessionName(input);
    const metadata = await backendLaunchMetadata(sessionName);
    const capture = await backendCapture(sessionName, input.lines, metadata);
    const observation = await sessionRuntimeObservation(metadata);
    const signals = signalsWithWorkflowActivity(
      captureSignals(capture),
      observation.workflowActivity
    );
    return text({
      managedSession: sessionName,
      capture,
      signals,
      transcript: await sessionTranscriptSnapshot(metadata),
      posture: await managedPostureReport(
        sessionName,
        signals,
        metadata,
        observation
      ),
    });
  }
);

server.registerTool(
  "wait_for_claude_turn",
  {
    description:
      "Wait for Claude's current turn to finish using record-ordered local session-log completion and terminal state. Pass submit_prompt.waitAfterCursor verbatim.",
    inputSchema: {
      managedSession: z.string().default(DEFAULT_MANAGED_SESSION),
      tmuxSession: z.string().optional().describe("Deprecated alias for managedSession."),
      afterCursor: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .describe("Optional non-empty opaque baseline returned by submit_prompt; completion requires a different final assistant record."),
      timeoutSeconds: z.number().int().min(1).max(900).default(180),
      pollIntervalMs: z.number().int().min(250).max(5000).default(750),
      lines: z.number().int().min(20).max(300).default(100),
    },
  },
  async (input) => {
    const sessionName = managedSessionName(input);
    const deadline = Date.now() + input.timeoutSeconds * 1000;
    const explicitCursor = input.afterCursor
      ? parsePortableWaitCursor(input.afterCursor)
      : null;
    const pendingAnchor = rememberedTurnAnchor(sessionName);
    let anchor =
      input.afterCursor && pendingAnchor?.afterCursor !== input.afterCursor
        ? null
        : pendingAnchor;
    const effectiveCursor =
      explicitCursor ??
      (anchor ? parsePortableWaitCursor(anchor.afterCursor) : null);
    let baselineTranscript =
      anchor?.baselineTranscript ??
      (effectiveCursor?.portable
        ? {
            lastUser: effectiveCursor.userCursor
              ? { cursor: effectiveCursor.userCursor }
              : null,
            lastAssistant:
              effectiveCursor.assistantCursor !== NO_ASSISTANT_CURSOR
                ? { cursor: effectiveCursor.assistantCursor }
                : null,
          }
        : null);
    let capture = "";
    let signals = {};
    let transcript = {};
    let metadata = null;
    while (Date.now() <= deadline) {
      metadata = await backendLaunchMetadata(sessionName);
      if (
        effectiveCursor?.portable &&
        ((effectiveCursor.resolvedSessionId &&
          metadata?.resolvedSessionId !==
            effectiveCursor.resolvedSessionId) ||
          (effectiveCursor.generationId &&
            metadata?.generationId !== effectiveCursor.generationId))
      ) {
        const error = new Error(
          "afterCursor belongs to a different managed session generation."
        );
        error.code = "ESTALE";
        throw error;
      }
      if (
        anchor &&
        (metadata?.startedAtMs !== anchor.startedAtMs ||
          (anchor.generationId &&
            metadata?.generationId !== anchor.generationId))
      ) {
        if (pendingTurnAnchors.get(sessionName) === anchor) {
          pendingTurnAnchors.delete(sessionName);
        }
        anchor = null;
        baselineTranscript = null;
      }
      capture = await backendCapture(sessionName, input.lines, metadata);
      const observation = await sessionRuntimeObservation(metadata);
      signals = signalsWithWorkflowActivity(
        captureSignals(capture),
        observation.workflowActivity
      );
      transcript = await sessionTranscriptSnapshot(metadata);
      baselineTranscript ??= transcriptCursorBaseline(transcript);
      const decision = waitTurnDecision({
        afterCursor:
          effectiveCursor?.assistantCursor ||
          undefined,
        baselineTranscript,
        transcript,
        signals,
        requireNewTurn: Boolean(anchor || effectiveCursor?.portable),
        submittedAfterMs:
          anchor?.submittedAfterMs ??
          effectiveCursor?.submittedAfterMs ??
          null,
      });
      if (decision.status === "completed") {
        if (anchor && pendingTurnAnchors.get(sessionName) === anchor) {
          pendingTurnAnchors.delete(sessionName);
        }
        return text({
          status: "completed",
          completionEvidence: decision.evidence,
          attention: decision.attention || undefined,
          managedSession: sessionName,
          capture,
          signals,
          transcript,
          posture: await managedPostureReport(
            sessionName,
            signals,
            metadata,
            observation
          ),
        });
      }
      if (decision.status === "needs_attention") {
        return text({
          status: "needs_attention",
          reason: decision.evidence,
          managedSession: sessionName,
          capture,
          signals,
          transcript,
          posture: await managedPostureReport(
            sessionName,
            signals,
            metadata,
            observation
          ),
        });
      }
      await sleep(input.pollIntervalMs);
    }
    return text({
      status: "timeout",
      managedSession: sessionName,
      capture,
      signals,
      transcript,
      posture: await managedPostureReport(sessionName, signals, metadata),
    });
  }
);

server.registerTool(
  "send_text",
  {
    description:
      "Send literal text to the managed native Claude session. Use submit=true to press Enter after sending. For multi-line prompts use submit_prompt; newlines sent here may submit early. Pending workflows block this unless force=true after inspection. This can affect a live Claude session.",
    inputSchema: {
      managedSession: z.string().default(DEFAULT_MANAGED_SESSION),
      tmuxSession: z.string().optional().describe("Deprecated alias for managedSession."),
      text: z.string().max(65536),
      submit: z.boolean().default(false),
      force: z
        .boolean()
        .default(false)
        .describe("Bypass only the pending-workflow text gate after inspecting the session."),
    },
  },
  async (input) => {
    const sessionName = managedSessionName(input);
    return withManagedMutationLock(sessionName, async () => {
      const metadata = await assertManagedMutationPolicy(sessionName);
      const beforeCapture = await backendCapture(sessionName, 80, metadata);
      const beforeObservation = await sessionRuntimeObservation(metadata);
      const beforeSignals = signalsWithWorkflowActivity(
        captureSignals(beforeCapture),
        beforeObservation.workflowActivity
      );
      if (beforeSignals.workflowPending && !input.force) {
        return text({
          status: "send_blocked",
          reason: "workflow_pending",
          managedSession: sessionName,
          capture: beforeCapture,
          signals: beforeSignals,
          posture: await managedPostureReport(
            sessionName,
            beforeSignals,
            metadata,
            beforeObservation
          ),
        });
      }
      const baselineTranscript = input.submit
        ? await sessionTranscriptSnapshot(metadata)
        : null;
      const submittedAtMs = Date.now();
      if (input.submit) pendingTurnAnchors.delete(sessionName);
      await backendSendText(sessionName, input.text, input.submit, { metadata });
      const capture = await backendCapture(sessionName, 80, metadata);
      const observation = await sessionRuntimeObservation(metadata);
      const signals = signalsWithWorkflowActivity(
        captureSignals(capture),
        observation.workflowActivity
      );
      const transcriptAcknowledged = input.submit
        ? await promptAcknowledgedInSession(
            sessionName,
            input.text,
            submittedAtMs,
            metadata
          )
        : false;
      const turnStarted = Boolean(
        input.submit &&
          (transcriptAcknowledged ||
            (signals.likelyBusy &&
              !activeInputContainsText(capture, input.text)))
      );
      if (turnStarted && metadata?.startedAtMs) {
        pendingTurnAnchors.set(
          sessionName,
          pendingTurnAnchor(
            metadata,
            baselineTranscript,
            submittedAtMs
          )
        );
      }
      return text({
        status: "sent",
        managedSession: sessionName,
        forceUsed: Boolean(input.force && beforeSignals.workflowPending),
        submitRequested: input.submit,
        submitted: turnStarted,
        transcriptAcknowledged,
        waitAfterCursor: input.submit
          ? waitAfterCursor(
              baselineTranscript,
              metadata,
              submittedAtMs
            )
          : undefined,
        capture,
        signals,
        posture: await managedPostureReport(
          sessionName,
          signals,
          metadata,
          observation
        ),
      });
    });
  }
);

server.registerTool(
  "submit_prompt",
  {
    description:
      "Paste and submit a complete prompt to Claude using safer chunked input. Returns a non-empty waitAfterCursor for an unambiguous wait_for_claude_turn call.",
    inputSchema: {
      managedSession: z.string().default(DEFAULT_MANAGED_SESSION),
      tmuxSession: z.string().optional().describe("Deprecated alias for managedSession."),
      text: z.string().min(1).max(65536),
      pasteMode: z
        .enum(["auto", "bracketed", "literal"])
        .default("auto")
        .describe("Use bracketed paste on Windows by default; literal mode sends plain terminal input."),
      submitRetries: z
        .number()
        .int()
        .min(0)
        .max(2)
        .default(1)
        .describe(
          "Maximum extra Enter retries when prompt or pasted-text evidence remains visible. Each retry may wait through four retryDelayMs visibility polls."
        ),
      retryDelayMs: z
        .number()
        .int()
        .min(250)
        .max(5000)
        .default(DEFAULT_SUBMIT_RETRY_DELAY_MS)
        .describe("Delay between bounded post-submit visibility polls; one retry may wait through four intervals."),
      chunkSize: z.number().int().min(256).max(8192).default(DEFAULT_TEXT_CHUNK_SIZE),
      chunkDelayMs: z.number().int().min(0).max(100).default(DEFAULT_TEXT_CHUNK_DELAY_MS),
      lines: z.number().int().min(20).max(1000).default(160),
      force: z
        .boolean()
        .default(false)
        .describe("Bypass preflight blocks for busy or non-idle captures. Use only after inspecting the session."),
    },
  },
  async (input) => {
    const sessionName = managedSessionName(input);
    return withManagedMutationLock(sessionName, async () => {
      const metadata = await assertManagedMutationPolicy(sessionName);
      const baselineTranscript = await sessionTranscriptSnapshot(metadata);
      const submittedAtMs = Date.now();
      const result = await runSubmitPrompt(input, {
        capture: (name, lines) => backendCapture(name, lines, metadata),
        sendText: (name, value, submit, options) =>
          backendSendText(name, value, submit, { ...options, metadata }),
        sendKey: (name, key) => backendSendKey(name, key, metadata),
        promptAcknowledged: (name, prompt, sinceMs) =>
          promptAcknowledgedInSession(name, prompt, sinceMs, metadata),
        runtimeObservation: () => sessionRuntimeObservation(metadata),
      });
      if (submitResultStartedTurn(result) && metadata?.startedAtMs) {
        pendingTurnAnchors.set(
          sessionName,
          pendingTurnAnchor(
            metadata,
            baselineTranscript,
            submittedAtMs
          )
        );
      } else if (result.status !== "preflight_blocked") {
        pendingTurnAnchors.delete(sessionName);
      }
      const currentMetadata = await backendLaunchMetadata(sessionName);
      const currentObservation = await sessionRuntimeObservation(currentMetadata);
      const currentSignals = signalsWithWorkflowActivity(
        result.signals,
        currentObservation.workflowActivity
      );
      return text({
        ...result,
        signals: currentSignals,
        waitAfterCursor: waitAfterCursor(
          baselineTranscript,
          metadata,
          submittedAtMs
        ),
        transcript: await sessionTranscriptSnapshot(currentMetadata),
        posture: await managedPostureReport(
          result.managedSession,
          currentSignals,
          currentMetadata,
          currentObservation
        ),
      });
    });
  }
);

server.registerTool(
  "send_key",
  {
    description: "Send a single key name to the managed native Claude session, such as Enter, Escape, C-c, Up, Down. Enter-equivalent keys are blocked during pending workflows unless force=true after inspection.",
    inputSchema: {
      managedSession: z.string().default(DEFAULT_MANAGED_SESSION),
      tmuxSession: z.string().optional().describe("Deprecated alias for managedSession."),
      key: z.string().regex(/^[A-Za-z0-9_-]{1,30}$/),
      force: z
        .boolean()
        .default(false)
        .describe("Bypass only the pending-workflow Enter-equivalent gate after inspecting the session."),
    },
  },
  async (input) => {
    const sessionName = managedSessionName(input);
    return withManagedMutationLock(sessionName, async () => {
      const metadata = await assertManagedMutationPolicy(sessionName);
      const submitsComposer = keySubmitsComposer(input.key);
      const baselineTranscript = submitsComposer
        ? await sessionTranscriptSnapshot(metadata)
        : null;
      const beforeCapture = submitsComposer
        ? await backendCapture(sessionName, 80, metadata)
        : "";
      const beforeObservation = submitsComposer
        ? await sessionRuntimeObservation(metadata)
        : null;
      const beforeSignals = submitsComposer
        ? signalsWithWorkflowActivity(
            captureSignals(beforeCapture),
            beforeObservation.workflowActivity
          )
        : {};
      if (submitsComposer && beforeSignals.workflowPending && !input.force) {
        return text({
          status: "send_blocked",
          reason: "workflow_pending",
          managedSession: sessionName,
          key: input.key,
          capture: beforeCapture,
          signals: beforeSignals,
          posture: await managedPostureReport(
            sessionName,
            beforeSignals,
            metadata,
            beforeObservation
          ),
        });
      }
      const submittedAtMs = Date.now();
      if (submitsComposer) pendingTurnAnchors.delete(sessionName);
      await backendSendKey(sessionName, input.key, metadata);
      const capture = await backendCapture(sessionName, 80, metadata);
      const observation = await sessionRuntimeObservation(metadata);
      const signals = signalsWithWorkflowActivity(
        captureSignals(capture),
        observation.workflowActivity
      );
      const afterTranscript = submitsComposer
        ? await sessionTranscriptSnapshot(metadata)
        : null;
      const userChanged = Boolean(
        afterTranscript?.lastUser?.cursor &&
          afterTranscript.lastUser.cursor !==
            (baselineTranscript?.lastUser?.cursor || "")
      );
      const turnStarted = Boolean(
        submitsComposer &&
          (userChanged ||
            (beforeSignals.activeInputHasText &&
              (signals.likelyBusy || !signals.activeInputHasText)))
      );
      if (turnStarted && metadata?.startedAtMs) {
        pendingTurnAnchors.set(
          sessionName,
          pendingTurnAnchor(
            metadata,
            baselineTranscript,
            submittedAtMs
          )
        );
      }
      return text({
        status: "sent",
        managedSession: sessionName,
        key: input.key,
        forceUsed: Boolean(
          input.force && submitsComposer && beforeSignals.workflowPending
        ),
        submitted: turnStarted,
        waitAfterCursor: submitsComposer
          ? waitAfterCursor(
              baselineTranscript,
              metadata,
              submittedAtMs
            )
          : undefined,
        capture,
        signals,
        posture: await managedPostureReport(
          sessionName,
          signals,
          metadata,
          observation
        ),
      });
    });
  }
);

server.registerTool(
  "rename_claude_session",
  {
    description:
      "Rename the Claude conversation attached to a running managed session, then verify the title in Claude's local session log.",
    inputSchema: {
      managedSession: z.string().default(DEFAULT_MANAGED_SESSION),
      tmuxSession: z.string().optional().describe("Deprecated alias for managedSession."),
      title: z
        .string()
        .regex(/^[A-Za-z0-9 _.:@()#-]{1,80}$/)
        .refine((value) => !value.startsWith("-"), "Session title cannot begin with '-'."),
      force: z
        .boolean()
        .default(false)
        .describe("Bypass only the pending-workflow rename gate after inspecting the session."),
    },
  },
  async (input) => {
    const sessionName = managedSessionName(input);
    return withManagedMutationLock(sessionName, async () => {
      const metadata = await assertManagedMutationPolicy(sessionName);
      if (!metadata?.resolvedSessionId) {
        throw new Error(`Managed session ${sessionName} has no resolved Claude session id yet.`);
      }
      const currentTitle = await managedSessionTitle(metadata);
      if (currentTitle.title === input.title) {
        return text({
          status: "already_named",
          managedSession: sessionName,
          resolvedSessionId: metadata.resolvedSessionId,
          requestedTitle: input.title,
          observedTitle: currentTitle.title,
          titleSource: currentTitle.titleSource,
        });
      }
      const before = await backendCapture(sessionName, 100, metadata);
      const beforeObservation = await sessionRuntimeObservation(metadata);
      const beforeSignals = signalsWithWorkflowActivity(
        captureSignals(before),
        beforeObservation.workflowActivity
      );
      const renameBlockReason = lifecycleBlockReason(beforeSignals);
      if (renameBlockReason && !(input.force && renameBlockReason === "workflow_pending")) {
        return text({
          status: "rename_blocked",
          reason: renameBlockReason,
          managedSession: sessionName,
          resolvedSessionId: metadata.resolvedSessionId,
          capture: before,
          signals: beforeSignals,
        });
      }
      await backendSendText(
        sessionName,
        `/rename ${input.title}`,
        true,
        {
          bracketedPaste: false,
          submitSettleMs: 100,
          metadata,
        }
      );
      const deadline = Date.now() + 6000;
      let observed = { title: "", titleSource: "" };
      while (Date.now() < deadline) {
        observed = await managedSessionTitle(metadata);
        if (observed.title === input.title) break;
        await sleep(200);
      }
      const capture = await backendCapture(sessionName, 100, metadata);
      const observation = await sessionRuntimeObservation(metadata);
      const signals = signalsWithWorkflowActivity(
        captureSignals(capture),
        observation.workflowActivity
      );
      return text({
        status: observed.title === input.title ? "renamed" : "rename_unverified",
        managedSession: sessionName,
        resolvedSessionId: metadata.resolvedSessionId,
        requestedTitle: input.title,
        observedTitle: observed.title,
        titleSource: observed.titleSource,
        forceUsed: Boolean(
          input.force && renameBlockReason === "workflow_pending"
        ),
        capture,
        signals,
      });
    });
  }
);

server.registerTool(
  "archive_claude_session",
  {
    description:
      "Archive a Claude conversation in the MCP-local catalog. This never moves, edits, or deletes Claude's JSONL transcript.",
    inputSchema: {
      sessionId: z.string(),
      cwd: z.string().default(DEFAULT_CWD),
    },
  },
  async ({ sessionId, cwd }) => {
    assertSafeSessionId(sessionId);
    const projectDir = projectDirFromCwd(cwd);
    const result = await setSessionArchiveState(projectDir, sessionId, true);
    return text({
      ...result,
      archiveScope: "mcp_local_catalog",
      transcriptUnchanged: true,
    });
  }
);

server.registerTool(
  "unarchive_claude_session",
  {
    description:
      "Remove a Claude conversation from the MCP-local archive catalog so it appears in active listings again. The transcript is unchanged.",
    inputSchema: {
      sessionId: z.string(),
      cwd: z.string().default(DEFAULT_CWD),
    },
  },
  async ({ sessionId, cwd }) => {
    assertSafeSessionId(sessionId);
    const projectDir = projectDirFromCwd(cwd);
    const result = await setSessionArchiveState(projectDir, sessionId, false);
    return text({
      ...result,
      archiveScope: "mcp_local_catalog",
      transcriptUnchanged: true,
    });
  }
);

server.registerTool(
  "stop_remote_control",
  {
    description: "Stop a managed native Rail Connector Control session.",
    inputSchema: {
      managedSession: z.string().default(DEFAULT_MANAGED_SESSION),
      tmuxSession: z.string().optional().describe("Deprecated alias for managedSession."),
      graceful: z.boolean().default(true).describe("Ask an idle Claude session to exit cleanly before force termination."),
      force: z.boolean().default(false).describe("Stop even when Claude appears busy or graceful exit times out."),
    },
  },
  async (input) => {
    const sessionName = managedSessionName(input);
    if (IS_NATIVE_WINDOWS) {
      const brokerStatus = await probeWindowsBroker();
      if (brokerStatus?.compatible === false) {
        if (
          !brokerStatus.managedSessions?.some(
            (candidate) => candidate.name === sessionName
          )
        ) {
          return text({
            status: "not_running",
            managedSession: sessionName,
          });
        }
        if (!input.force) {
          return text({
            status: "stop_blocked",
            reason: "broker_upgrade_required",
            managedSession: sessionName,
            note: "This session belongs to a different broker build or Claude launch policy. Retry with force=true for generation-bound, no-capture compatibility cleanup.",
          });
        }
        return withSessionOperationLock(sessionName, async () =>
          text(
            await forceCleanupIncompatibleWindowsBrokerSession(
              sessionName,
              brokerStatus
            )
          )
        );
      }
    }
    return withManagedMutationLock(sessionName, async () => {
      let capture = "";
      try {
        capture = await backendCapture(sessionName, 120);
      } catch (error) {
        if (brokerUnavailable(error)) {
          return text({ status: "not_running", managedSession: sessionName });
        }
        if (
          ["ECWDUNAVAILABLE", "ECWDPROVENANCE"].includes(error?.code)
        ) {
          if (!input.force) {
            return text({
              status: "stop_blocked",
              reason:
                error.code === "ECWDPROVENANCE"
                  ? "cwd_provenance_changed"
                  : "cwd_unavailable",
              managedSession: sessionName,
              note:
                error.code === "ECWDPROVENANCE"
                  ? "The project path no longer matches its start-time canonical provenance. Retry with force=true for workspace-scoped termination without reading the terminal."
                  : "The persisted project directory is unavailable. Retry with force=true to terminate the broker session without reading its terminal.",
            });
          }
          return text(await backendCleanupStopUnlocked(sessionName));
        }
        throw error;
      }
      const metadata = await backendLaunchMetadata(sessionName);
      const observation = await sessionRuntimeObservation(metadata);
      const signals = signalsWithWorkflowActivity(
        captureSignals(capture),
        observation.workflowActivity
      );
      if (signals.state === "exited") {
        return text(
          await backendStopUnlocked(sessionName, {
            graceful: false,
            force: false,
          })
        );
      }
      const stopBlockReason = lifecycleBlockReason(signals);
      if (!input.force && stopBlockReason) {
        return text({
          status: "stop_blocked",
          reason: stopBlockReason,
          managedSession: sessionName,
          capture,
          signals,
          note: "Claude is not idle. Wait for the turn or attention state to clear, or retry with force=true.",
        });
      }
      const stopped = await backendStopUnlocked(sessionName, {
          graceful: input.graceful && !stopBlockReason,
          force: input.force,
        });
      return text({
        ...stopped,
        forceUsed: Boolean(input.force && stopBlockReason),
        workflowInterrupted: Boolean(
          input.force && signals.workflowPending
        ),
      });
    });
  }
);

server.registerTool(
  "get_claude_capabilities",
  {
    description:
      "Inspect the installed Claude CLI with bounded version, help, and UltraCode parser probes without starting an interactive session. Reports capability provenance and MCP-process environment blockers separately from runtime evidence.",
    inputSchema: {},
  },
  async () => text(await inspectClaudeCapabilities())
);

server.registerTool(
  "status",
  {
    description: "Show terminal backend and Claude process status relevant to managed Remote Control sessions.",
    inputSchema: {
      includeAgentDetails: z
        .boolean()
        .default(false)
        .describe(
          "Include Claude's machine-wide agent inventory. Defaults to false because it can disclose sessions outside this MCP project."
        ),
    },
  },
  async ({ includeAgentDetails }) => {
    const tmuxVersion = IS_NATIVE_WINDOWS ? { ok: true, stdout: "", stderr: "" } : await tmux(["-V"], { timeoutMs: 5000 });
    let brokerStatus = null;
    let brokerProbeError = null;
    if (IS_NATIVE_WINDOWS) {
      try {
        brokerStatus = await probeWindowsBroker();
      } catch (error) {
        brokerProbeError = {
          code: error?.code || "EBROKER",
          message: error?.message || String(error),
        };
      }
    }
    let inaccessibleManagedSessionCount = 0;
    const cleanupEligibleSessions = [];
    let managedSessions;
    if (IS_NATIVE_WINDOWS) {
      managedSessions = [];
      for (const session of brokerStatus?.managedSessions ?? []) {
        try {
          const cwd = resolveAllowedManagedCwd(
            session.cwd,
            session.canonicalCwd
          );
          const {
            canonicalCwd: _canonicalCwd,
            observedPosture: _legacyObservedPosture,
            ...publicSession
          } = session;
          let workflowActivity = emptyWorkflowActivity();
          let workflowObservationStatus = "not_observed";
          try {
            workflowActivity = (
              await sessionRuntimeObservation({ ...session, cwd })
            ).workflowActivity;
            workflowObservationStatus = workflowActivity.evidence
              ? "observed"
              : "not_observed";
          } catch {
            workflowObservationStatus = "unavailable";
          }
          managedSessions.push({
            ...publicSession,
            cwd,
            workflowActivity,
            workflowPending:
              workflowObservationStatus === "unavailable"
                ? null
                : workflowActivity.pendingCount > 0,
            workflowObservationStatus,
          });
        } catch {
          try {
            resolveAllowedCleanupCwd(
              session.cwd,
              session.canonicalCwd
            );
            cleanupEligibleSessions.push({
              name: session.name,
              state: fs.existsSync(session.cwd)
                ? "provenance_changed"
                : "cleanup_only",
              exited: Boolean(session.exited),
            });
            continue;
          } catch {
            // The session is outside the current cleanup boundary.
          }
          inaccessibleManagedSessionCount += 1;
        }
      }
    } else {
      managedSessions = [];
      for (const session of await tmuxManagedSessions()) {
        let workflowActivity = emptyWorkflowActivity();
        let workflowObservationStatus = "not_observed";
        try {
          workflowActivity = (
            await sessionRuntimeObservation(session)
          ).workflowActivity;
          workflowObservationStatus = workflowActivity.evidence
            ? "observed"
            : "not_observed";
        } catch {
          workflowObservationStatus = "unavailable";
        }
        managedSessions.push({
          ...session,
          workflowActivity,
          workflowPending:
            workflowObservationStatus === "unavailable"
              ? null
              : workflowActivity.pendingCount > 0,
          workflowObservationStatus,
        });
      }
    }
    return text({
      platform: process.platform,
      backend: IS_NATIVE_WINDOWS ? "native-windows-broker" : "tmux",
      persistentAcrossMcpRestart: true,
      broker: IS_NATIVE_WINDOWS
        ? {
            running: brokerProbeError ? null : Boolean(brokerStatus),
            pid: brokerStatus?.pid ?? null,
            version: brokerStatus?.version ?? "",
            protocol: brokerStatus?.protocol ?? null,
            compatible: brokerStatus?.compatible ?? null,
            launchPolicyCompatible:
              brokerStatus?.launchPolicyCompatible ?? null,
            legacyPipe: brokerStatus?.legacyPipe ?? false,
            probeError: brokerProbeError,
          }
        : null,
      managedSessions,
      cleanupEligibleSessions:
        IS_NATIVE_WINDOWS ? cleanupEligibleSessions : undefined,
      inaccessibleManagedSessionCount:
        IS_NATIVE_WINDOWS ? inaccessibleManagedSessionCount : undefined,
      mcpProcess: {
        pid: process.pid,
        startedAt: MCP_PROCESS_STARTED_AT,
      },
      bypassPolicy: bypassPolicyStatus(),
      tmuxVersion: tmuxVersion.ok ? tmuxVersion.stdout.trim() : "",
      tmuxError: tmuxVersion.ok ? "" : tmuxVersion.stderr,
      claudeProcesses: await processStatus(managedSessions.map((session) => session.pid)),
      activeClaudeAgents: includeAgentDetails ? await activeClaudeAgents() : undefined,
    });
  }
);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
