import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPortableWaitCursor,
  inspectSessionFile,
  listClaudeSessionSummaries,
  parsePortableWaitCursor,
  projectDirFromCwd,
  readClaudeResultChunkFromFile,
  readRecentSessionRecordWindowFromFile,
  sessionArchiveInfo,
  setSessionArchiveState,
  recentSessionRecords,
  resolveAllowedCleanupCwd,
  resolveAllowedManagedCwd,
  resolveAllowedPersistedCwd,
  resolveClaudeSessionName,
  startedSessionSummary,
  transcriptSnapshotFromRecords,
  waitTurnDecision,
} from "../src/index.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rail-connector-sessions-"));
assert.deepEqual(
  await recentSessionRecords({
    cwd: root,
    resolvedSessionId: "..\\..\\outside",
  }),
  []
);
const missingPersistedCwd = path.join(root, "removed-project");
fs.mkdirSync(missingPersistedCwd);
const canonicalMissingPersistedCwd =
  fs.realpathSync.native?.(missingPersistedCwd) ?? fs.realpathSync(missingPersistedCwd);
fs.rmdirSync(missingPersistedCwd);
assert.equal(resolveAllowedPersistedCwd(missingPersistedCwd), missingPersistedCwd);
const priorAllowedRoots = process.env.RAIL_CONNECTOR_ALLOWED_ROOTS;
process.env.RAIL_CONNECTOR_ALLOWED_ROOTS = root;
try {
  assert.throws(
    () => resolveAllowedPersistedCwd(missingPersistedCwd),
    /canonical provenance is unavailable/
  );
  assert.equal(
    resolveAllowedPersistedCwd(missingPersistedCwd, canonicalMissingPersistedCwd),
    missingPersistedCwd
  );
  assert.throws(
    () =>
      resolveAllowedPersistedCwd(
        missingPersistedCwd,
        path.join(path.dirname(root), "outside-removed-project")
      ),
    /outside RAIL_CONNECTOR_ALLOWED_ROOTS/
  );
  const junctionTargetA = path.join(root, "junction-target-a");
  const junctionTargetB = path.join(root, "junction-target-b");
  const junctionPath = path.join(root, "managed-junction");
  fs.mkdirSync(junctionTargetA);
  fs.mkdirSync(junctionTargetB);
  fs.symlinkSync(
    junctionTargetA,
    junctionPath,
    process.platform === "win32" ? "junction" : "dir"
  );
  const canonicalTargetA =
    fs.realpathSync.native?.(junctionPath) ?? fs.realpathSync(junctionPath);
  assert.equal(
    projectDirFromCwd(junctionPath),
    projectDirFromCwd(canonicalTargetA)
  );
  assert.equal(
    resolveAllowedManagedCwd(junctionPath, canonicalTargetA),
    junctionPath
  );
  fs.unlinkSync(junctionPath);
  fs.symlinkSync(
    junctionTargetB,
    junctionPath,
    process.platform === "win32" ? "junction" : "dir"
  );
  assert.throws(
    () => resolveAllowedManagedCwd(junctionPath, canonicalTargetA),
    (error) => error?.code === "ECWDPROVENANCE"
  );
  assert.equal(
    resolveAllowedCleanupCwd(junctionPath, canonicalTargetA),
    junctionPath
  );
  fs.unlinkSync(junctionPath);
} finally {
  if (priorAllowedRoots === undefined) {
    delete process.env.RAIL_CONNECTOR_ALLOWED_ROOTS;
  } else {
    process.env.RAIL_CONNECTOR_ALLOWED_ROOTS = priorAllowedRoots;
  }
}

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function writeSession(directory, name, records, modifiedSeconds) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${name}.jsonl`);
  fs.writeFileSync(file, jsonl(records));
  const modified = new Date(1_700_000_000_000 + modifiedSeconds * 1000);
  fs.utimesSync(file, modified, modified);
  return file;
}

function message(timestamp, role, text) {
  return { timestamp, message: { role, content: [{ type: "text", text }] } };
}

const toolUseSnapshot = transcriptSnapshotFromRecords([
  {
    ...message("2026-01-01T00:00:00Z", "user", "run a tool"),
    uuid: "user-1",
  },
  {
    ...message("2026-01-01T00:00:01Z", "assistant", "calling tool"),
    uuid: "assistant-tool",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "calling tool" }],
      stop_reason: "tool_use",
      model: "claude-test",
    },
  },
]);
assert.equal(toolUseSnapshot.turnComplete, false);

const longAnswer = "x".repeat(140 * 1024);
const completedSnapshot = transcriptSnapshotFromRecords([
  {
    ...message("2026-01-01T00:00:00Z", "user", "run a tool"),
    uuid: "user-1",
  },
  {
    timestamp: "2026-01-01T00:00:02Z",
    uuid: "assistant-final",
    message: {
      role: "assistant",
      content: [{ type: "text", text: longAnswer }],
      stop_reason: "end_turn",
      model: "claude-test",
    },
  },
  {
    timestamp: "2026-01-01T00:00:03Z",
    isMeta: true,
    uuid: "meta-assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "meta text" }],
      stop_reason: "end_turn",
      model: "claude-test",
    },
  },
]);
assert.equal(completedSnapshot.turnComplete, true);
assert.equal(completedSnapshot.lastAssistant.cursor, "assistant-final");
assert.equal(completedSnapshot.lastAssistant.textLength, longAnswer.length);
assert.equal(completedSnapshot.lastAssistant.textTruncated, true);
assert.equal(completedSnapshot.lastAssistant.text.length, 128 * 1024);
assert.match(
  completedSnapshot.lastAssistant.resultId,
  /^rail:result:v1:[0-9a-f]{64}:[0-9a-f]{64}$/
);
assert.match(completedSnapshot.lastAssistant.textSha256, /^sha256:[0-9a-f]{64}$/);
assert.equal(completedSnapshot.lastAssistant.textUtf8Bytes, longAnswer.length);
assert.equal(completedSnapshot.lastAssistant.usage, null);

const unicodeBoundaryAnswer = `${"u".repeat(128 * 1024 - 1)}😀tail`;
const unicodeBoundarySnapshot = transcriptSnapshotFromRecords([
  {
    timestamp: "2026-01-01T00:00:04Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: unicodeBoundaryAnswer }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 11,
        output_tokens: 22,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
        iterations: 2,
        service_tier: "standard",
        speed: "fast",
      },
    },
  },
]);
assert.equal(unicodeBoundarySnapshot.lastAssistant.text.endsWith("\ud83d"), false);
assert.doesNotMatch(unicodeBoundarySnapshot.lastAssistant.text, /\ufffd/);
assert.equal(
  unicodeBoundarySnapshot.lastAssistant.textCharacters,
  128 * 1024 + 4
);
assert.equal(unicodeBoundarySnapshot.lastAssistant.usage.inputTokens, 11);
assert.equal(
  unicodeBoundarySnapshot.lastAssistant.usage.delegatedAgentCoverage,
  "unknown"
);
assert.equal(unicodeBoundarySnapshot.lastAssistant.usage.costUsd, null);

const sameTimestampFirst = transcriptSnapshotFromRecords([
  message("2026-01-01T00:00:05Z", "assistant", "first answer"),
]);
const sameTimestampSecond = transcriptSnapshotFromRecords([
  message("2026-01-01T00:00:05Z", "assistant", "second answer"),
]);
assert.notEqual(
  sameTimestampFirst.lastAssistant.cursor,
  sameTimestampSecond.lastAssistant.cursor
);
const staleAssistantAfterUser = transcriptSnapshotFromRecords([
  {
    uuid: "assistant-before-user",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
      stop_reason: "end_turn",
    },
  },
  {
    uuid: "user-after-assistant",
    message: { role: "user", content: [{ type: "text", text: "new prompt" }] },
  },
]);
assert.equal(staleAssistantAfterUser.turnComplete, false);

const settledBaseline = {
  lastUser: { cursor: "user-0" },
  lastAssistant: { cursor: "assistant-0" },
};
const settledTranscript = {
  ...settledBaseline,
  turnComplete: true,
};
const portableWaitCursor = createPortableWaitCursor(
  settledBaseline,
  {
    resolvedSessionId: "34343434-3434-4343-8343-343434343434",
    generationId: "45454545-4545-4454-8454-454545454545",
  },
  Date.parse("2026-07-29T12:01:00Z")
);
assert.match(portableWaitCursor, /^rail:v2:/);
assert.deepEqual(parsePortableWaitCursor(portableWaitCursor), {
  portable: true,
  assistantCursor: "assistant-0",
  userCursor: "user-0",
  submittedAfterMs: Date.parse("2026-07-29T12:01:00Z"),
  resolvedSessionId: "34343434-3434-4343-8343-343434343434",
  generationId: "45454545-4545-4454-8454-454545454545",
});
assert.throws(
  () => parsePortableWaitCursor("rail:v2:not-valid-json"),
  (error) => error?.code === "EINVAL"
);
assert.equal(
  waitTurnDecision({
    baselineTranscript: settledBaseline,
    transcript: settledTranscript,
    signals: { state: "busy" },
  }).status,
  "wait"
);
assert.equal(
  waitTurnDecision({
    baselineTranscript: settledBaseline,
    transcript: settledTranscript,
    signals: { state: "idle" },
  }).evidence,
  "latest_settled_turn"
);
assert.equal(
  waitTurnDecision({
    baselineTranscript: settledBaseline,
    transcript: settledTranscript,
    signals: { state: "idle" },
    requireNewTurn: true,
  }).status,
  "wait"
);
assert.equal(
  waitTurnDecision({
    baselineTranscript: settledBaseline,
    transcript: settledTranscript,
    signals: { state: "approval_required" },
    requireNewTurn: true,
  }).status,
  "needs_attention"
);
assert.equal(
  waitTurnDecision({
    afterCursor: "rail:no-assistant:v1",
    baselineTranscript: {
      lastUser: null,
      lastAssistant: null,
    },
    transcript: {
      lastUser: { cursor: "first-user" },
      lastAssistant: { cursor: "first-assistant" },
      turnComplete: true,
    },
    signals: { state: "idle" },
    requireNewTurn: true,
  }).status,
  "completed"
);
const newTurnTranscript = {
  lastUser: { cursor: "user-1" },
  lastAssistant: { cursor: "assistant-1" },
  turnComplete: true,
};
const pendingWorkflowDecision = waitTurnDecision({
  afterCursor: "assistant-0",
  baselineTranscript: settledBaseline,
  transcript: newTurnTranscript,
  signals: {
    state: "busy",
    workflowPending: true,
    workflowPendingCount: 1,
  },
  requireNewTurn: true,
});
assert.equal(pendingWorkflowDecision.status, "wait");
assert.equal(pendingWorkflowDecision.evidence, "workflow_pending");
assert.equal(
  waitTurnDecision({
    afterCursor: "assistant-0",
    baselineTranscript: settledBaseline,
    transcript: newTurnTranscript,
    signals: {
      state: "idle",
      workflowPending: false,
      workflowPendingCount: 0,
    },
    requireNewTurn: true,
  }).status,
  "completed"
);
assert.equal(
  waitTurnDecision({
    afterCursor: "assistant-0",
    baselineTranscript: settledBaseline,
    transcript: newTurnTranscript,
    signals: {
      state: "limit_warning",
      workflowPending: true,
      workflowPendingCount: 1,
    },
    requireNewTurn: true,
  }).status,
  "needs_attention"
);
assert.equal(
  waitTurnDecision({
    afterCursor: "assistant-0",
    baselineTranscript: settledBaseline,
    transcript: newTurnTranscript,
    signals: { state: "busy" },
  }).evidence,
  "after_cursor_changed"
);
assert.equal(
  waitTurnDecision({
    afterCursor: "assistant-0",
    baselineTranscript: settledBaseline,
    transcript: {
      lastUser: { cursor: "user-0" },
      lastAssistant: { cursor: "assistant-unrelated" },
      turnComplete: true,
    },
    signals: { state: "idle" },
    requireNewTurn: true,
  }).status,
  "wait"
);
assert.equal(
  waitTurnDecision({
    afterCursor: "assistant-0",
    baselineTranscript: settledBaseline,
    transcript: newTurnTranscript,
    signals: { state: "approval_required" },
    requireNewTurn: true,
  }).status,
  "needs_attention"
);
const weakAttentionCompletion = waitTurnDecision({
  afterCursor: "assistant-0",
  baselineTranscript: settledBaseline,
  transcript: newTurnTranscript,
  signals: { state: "limit_warning" },
  requireNewTurn: true,
});
assert.equal(weakAttentionCompletion.status, "completed");
assert.equal(weakAttentionCompletion.attention, "limit_warning");
const toolHeavyTailCompletion = waitTurnDecision({
  afterCursor: "assistant-0",
  baselineTranscript: settledBaseline,
  transcript: {
    lastUser: { cursor: "user-0", timestamp: "2026-07-29T12:00:00Z" },
    lastAssistant: {
      cursor: "assistant-after-large-tool-output",
      timestamp: "2026-07-29T12:10:00Z",
    },
    turnComplete: true,
  },
  signals: { state: "idle" },
  requireNewTurn: true,
  submittedAfterMs: Date.parse("2026-07-29T12:01:00Z"),
});
assert.equal(toolHeavyTailCompletion.status, "completed");
assert.equal(toolHeavyTailCompletion.evidence, "after_cursor_changed");
assert.equal(
  waitTurnDecision({
    afterCursor: "assistant-0",
    baselineTranscript: settledBaseline,
    transcript: {
      lastUser: { cursor: "user-0" },
      lastAssistant: {
        cursor: "assistant-stale",
        timestamp: "2026-07-29T11:59:00Z",
      },
      turnComplete: true,
    },
    signals: { state: "idle" },
    requireNewTurn: true,
    submittedAfterMs: Date.parse("2026-07-29T12:01:00Z"),
  }).status,
  "wait"
);

const oversizedDir = path.join(root, "oversized-result");
const oversizedId = "67676767-6767-4676-8676-676767676767";
const oversizedAnswer = `${"z".repeat(2 * 1024 * 1024 + 256)}😀END`;
const oversizedFile = writeSession(
  oversizedDir,
  oversizedId,
  [
    {
      ...message("2026-01-01T00:00:06Z", "user", "large report"),
      sessionId: oversizedId,
    },
    {
      timestamp: "2026-01-01T00:00:07Z",
      sessionId: oversizedId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: oversizedAnswer }],
        stop_reason: "end_turn",
        model: "claude-test",
      },
    },
  ],
  8
);
const oversizedWindow = await readRecentSessionRecordWindowFromFile(
  oversizedFile,
  oversizedId
);
assert.equal(oversizedWindow.status, "full");
assert.equal(oversizedWindow.records.length, 2);
assert.ok(oversizedWindow.bytesRead > 2 * 1024 * 1024);
const oversizedSnapshot = transcriptSnapshotFromRecords(
  oversizedWindow.records,
  oversizedId
);
assert.equal(oversizedSnapshot.turnComplete, true);
assert.equal(oversizedSnapshot.lastAssistant.textTruncated, true);
assert.equal(
  oversizedSnapshot.lastAssistant.textCharacters,
  2 * 1024 * 1024 + 260
);
const oversizedTail = await readClaudeResultChunkFromFile(
  oversizedFile,
  oversizedId,
  oversizedSnapshot.lastAssistant.resultId,
  oversizedSnapshot.lastAssistant.textCharacters - 4,
  4
);
assert.equal(oversizedTail.text, "😀END");
assert.equal(oversizedTail.returnedCharacters, 4);
assert.equal(oversizedTail.hasMore, false);
assert.equal(oversizedTail.textSha256, oversizedSnapshot.lastAssistant.textSha256);
assert.equal(oversizedTail.resultIdentityScope, "assistant_record");
assert.equal(oversizedTail.usageRecordAmbiguous, false);

const buriedResultDir = path.join(root, "buried-large-result");
const buriedResultId = "78787878-7878-4787-8787-787878787878";
const buriedAnswer = `${"b".repeat(3 * 1024 * 1024 + 128)}😀DONE`;
const buriedResultFile = writeSession(
  buriedResultDir,
  buriedResultId,
  [
    {
      ...message("2026-01-01T00:01:00Z", "user", "large report"),
      sessionId: buriedResultId,
      uuid: "buried-user-1",
    },
    {
      timestamp: "2026-01-01T00:01:01Z",
      sessionId: buriedResultId,
      uuid: "buried-assistant-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: buriedAnswer }],
        stop_reason: "end_turn",
        usage: { output_tokens: 321 },
      },
    },
    {
      ...message("2026-01-01T00:01:02Z", "user", "small newer prompt"),
      sessionId: buriedResultId,
      uuid: "buried-user-2",
    },
  ],
  9
);
const buriedWindow = await readRecentSessionRecordWindowFromFile(
  buriedResultFile,
  buriedResultId,
  { minConversationRecords: 3 }
);
const buriedSnapshot = transcriptSnapshotFromRecords(
  buriedWindow.records,
  buriedResultId
);
const buriedFirstChunk = await readClaudeResultChunkFromFile(
  buriedResultFile,
  buriedResultId,
  buriedSnapshot.lastAssistant.resultId,
  0,
  64 * 1024
);
assert.equal(buriedFirstChunk.resultCache.hit, false);
assert.equal(buriedFirstChunk.resultCache.retained, true);
const buriedSecondChunk = await readClaudeResultChunkFromFile(
  buriedResultFile,
  buriedResultId,
  buriedSnapshot.lastAssistant.resultId,
  buriedFirstChunk.nextOffsetCharacters,
  64 * 1024
);
assert.equal(buriedSecondChunk.resultCache.hit, true);
assert.equal(buriedSecondChunk.transcriptRead.bytesRead, 0);
assert.equal(buriedSecondChunk.text, "b".repeat(64 * 1024));
const buriedChunks = [buriedFirstChunk.text, buriedSecondChunk.text];
let buriedPage = buriedSecondChunk;
while (buriedPage.hasMore) {
  buriedPage = await readClaudeResultChunkFromFile(
    buriedResultFile,
    buriedResultId,
    buriedSnapshot.lastAssistant.resultId,
    buriedPage.nextOffsetCharacters,
    64 * 1024
  );
  assert.equal(buriedPage.resultCache.hit, true);
  assert.equal(buriedPage.transcriptRead.bytesRead, 0);
  buriedChunks.push(buriedPage.text);
}
assert.equal(buriedChunks.join(""), buriedAnswer);
fs.appendFileSync(
  buriedResultFile,
  `${JSON.stringify({
    type: "system",
    subtype: "cache-invalidation-fixture",
    sessionId: buriedResultId,
  })}\n`
);
const buriedTail = await readClaudeResultChunkFromFile(
  buriedResultFile,
  buriedResultId,
  buriedSnapshot.lastAssistant.resultId,
  buriedSnapshot.lastAssistant.textCharacters - 5,
  5
);
assert.equal(buriedTail.text, "😀DONE");
assert.ok(buriedTail.transcriptRead.bytesRead > 2 * 1024 * 1024);
assert.equal(buriedTail.usage.outputTokens, 321);
assert.equal(buriedTail.resultCache.hit, false);

const overBoundDir = path.join(root, "over-bound-record");
const overBoundId = "89898989-8989-4898-8989-898989898989";
const overBoundFile = writeSession(
  overBoundDir,
  overBoundId,
  [
    {
      ...message("2026-01-01T00:02:00Z", "assistant", "q".repeat(8 * 1024)),
      sessionId: overBoundId,
    },
    { type: "system", subtype: "status", sessionId: overBoundId },
    { type: "system", subtype: "status", sessionId: overBoundId },
  ],
  10
);
const overBoundWindow = await readRecentSessionRecordWindowFromFile(
  overBoundFile,
  overBoundId,
  { initialBytes: 4096, maxBytes: 4096, minConversationRecords: 2 }
);
assert.equal(overBoundWindow.status, "record_too_large");
assert.equal(
  overBoundWindow.attentionReason,
  "session_record_exceeds_bounded_reader"
);

function fixedByteAssistantRecord(sessionId, targetBytes, fill) {
  const record = {
    timestamp: "2026-01-01T00:02:10Z",
    sessionId,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stop_reason: "end_turn",
    },
  };
  const emptyBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
  record.message.content[0].text = fill.repeat(targetBytes - emptyBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(record), "utf8"), targetBytes);
  return record;
}

const exactBoundId = "93939393-9393-4939-8939-939393939393";
const exactBoundFile = writeSession(
  path.join(root, "exact-bound-record"),
  exactBoundId,
  [
    { type: "system", subtype: "prefix", sessionId: exactBoundId },
    fixedByteAssistantRecord(exactBoundId, 4096, "e"),
  ],
  11
);
const exactBoundWindow = await readRecentSessionRecordWindowFromFile(
  exactBoundFile,
  exactBoundId,
  { initialBytes: 4096, maxBytes: 4096, minConversationRecords: 1 }
);
assert.equal(exactBoundWindow.status, "tail");
assert.equal(exactBoundWindow.records.length, 1);
assert.equal(
  exactBoundWindow.records[0].message.content[0].text.startsWith("e"),
  true
);

const beyondBoundId = "94949494-9494-4949-8949-949494949494";
const beyondBoundFile = writeSession(
  path.join(root, "beyond-bound-record"),
  beyondBoundId,
  [
    { type: "system", subtype: "prefix", sessionId: beyondBoundId },
    fixedByteAssistantRecord(beyondBoundId, 4097, "f"),
  ],
  12
);
const beyondBoundWindow = await readRecentSessionRecordWindowFromFile(
  beyondBoundFile,
  beyondBoundId,
  { initialBytes: 4096, maxBytes: 4096, minConversationRecords: 1 }
);
assert.equal(beyondBoundWindow.status, "record_too_large");
assert.equal(
  beyondBoundWindow.attentionReason,
  "session_record_exceeds_bounded_reader"
);

const duplicateDir = path.join(root, "duplicate-result-text");
const duplicateId = "90909090-9090-4909-8909-909090909090";
const duplicateFile = writeSession(
  duplicateDir,
  duplicateId,
  [
    {
      ...message("2026-01-01T00:03:00Z", "assistant", "same answer"),
      sessionId: duplicateId,
      uuid: "duplicate-assistant-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "same answer" }],
        stop_reason: "end_turn",
        usage: { output_tokens: 1 },
      },
    },
    {
      ...message("2026-01-01T00:03:01Z", "assistant", "same answer"),
      sessionId: duplicateId,
      uuid: "duplicate-assistant-2",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "same answer" }],
        stop_reason: "end_turn",
        usage: { output_tokens: 2 },
      },
    },
  ],
  11
);
const duplicateInspection = await inspectSessionFile(duplicateFile, 2);
const [duplicateFirst, duplicateSecond] = duplicateInspection.recentMessages;
assert.notEqual(duplicateFirst.resultId, duplicateSecond.resultId);
assert.equal(duplicateFirst.textSha256, duplicateSecond.textSha256);
const duplicateFirstResult = await readClaudeResultChunkFromFile(
  duplicateFile,
  duplicateId,
  duplicateFirst.resultId
);
const duplicateSecondResult = await readClaudeResultChunkFromFile(
  duplicateFile,
  duplicateId,
  duplicateSecond.resultId
);
assert.equal(duplicateFirstResult.usage.outputTokens, 1);
assert.equal(duplicateSecondResult.usage.outputTokens, 2);
const duplicateLegacyResult = await readClaudeResultChunkFromFile(
  duplicateFile,
  duplicateId,
  duplicateFirst.textSha256
);
assert.equal(duplicateLegacyResult.matchingRecordCount, 2);
assert.equal(duplicateLegacyResult.usageRecordAmbiguous, true);
assert.equal(duplicateLegacyResult.usage, null);
assert.equal(duplicateLegacyResult.recordResultId, null);
const buriedDuplicateId = "92929292-9292-4929-8929-929292929292";
const buriedDuplicateFile = writeSession(
  path.join(root, "buried-duplicate-result-text"),
  buriedDuplicateId,
  [
    {
      ...message("2026-01-01T00:03:10Z", "assistant", "same answer"),
      sessionId: buriedDuplicateId,
      uuid: "buried-duplicate-assistant-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "same answer" }],
        stop_reason: "end_turn",
        usage: { output_tokens: 10 },
      },
    },
    {
      type: "system",
      subtype: "large-test-fixture",
      sessionId: buriedDuplicateId,
      payload: "m".repeat(2 * 1024 * 1024 + 128),
    },
    {
      ...message("2026-01-01T00:03:11Z", "assistant", "same answer"),
      sessionId: buriedDuplicateId,
      uuid: "buried-duplicate-assistant-2",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "same answer" }],
        stop_reason: "end_turn",
        usage: { output_tokens: 20 },
      },
    },
  ],
  12
);
const buriedDuplicateLegacyResult = await readClaudeResultChunkFromFile(
  buriedDuplicateFile,
  buriedDuplicateId,
  duplicateFirst.textSha256
);
assert.ok(
  buriedDuplicateLegacyResult.transcriptRead.bytesRead > 2 * 1024 * 1024
);
assert.equal(buriedDuplicateLegacyResult.matchingRecordCount, 2);
assert.equal(buriedDuplicateLegacyResult.usageRecordAmbiguous, true);
assert.equal(buriedDuplicateLegacyResult.usage, null);
await assert.rejects(
  readClaudeResultChunkFromFile(
    duplicateFile,
    duplicateId,
    "sha256:not-a-valid-result"
  ),
  (error) => error?.code === "EINVAL"
);

const inspectDepthDir = path.join(root, "inspect-depth");
const inspectDepthId = "91919191-9191-4919-8919-919191919191";
const inspectDepthFile = writeSession(
  inspectDepthDir,
  inspectDepthId,
  Array.from({ length: 4 }, (_, index) => ({
    ...message(
      `2026-01-01T00:04:0${index}Z`,
      "assistant",
      `${index}:${"d".repeat(600 * 1024)}`
    ),
    sessionId: inspectDepthId,
    uuid: `inspect-depth-${index}`,
  })),
  12
);
const inspectDepth = await inspectSessionFile(inspectDepthFile, 4);
assert.equal(inspectDepth.recentMessages.length, 4);
assert.deepEqual(
  inspectDepth.recentMessages.map((entry) => entry.text.slice(0, 2)),
  ["0:", "1:", "2:", "3:"]
);

try {
  const missing = await listClaudeSessionSummaries(path.join(root, "missing"), { limit: 2 });
  assert.equal(missing.projectDirExists, false);
  assert.equal(missing.totalSessionFiles, 0);
  assert.deepEqual(missing.sessions, []);

  const orderedDir = path.join(root, "ordered");
  writeSession(orderedDir, "oldest", [message("2026-01-01T00:00:00Z", "user", "find the hidden needle")], 10);
  writeSession(orderedDir, "middle", [message("2026-01-02T00:00:00Z", "user", "middle prompt")], 20);
  writeSession(
    orderedDir,
    "newest",
    [
      {
        type: "system",
        subtype: "bridge_status",
        timestamp: "2026-01-03T00:00:00Z",
        url: "https://claude.ai/code/session_sensitive",
      },
      message("2026-01-03T00:00:00Z", "assistant", "newest response"),
    ],
    30
  );

  const recent = await listClaudeSessionSummaries(orderedDir, {
    limit: 2,
    maxSummaryBytes: 4096,
    byteBudget: 8192,
  });
  assert.deepEqual(
    recent.sessions.map((session) => session.sessionId),
    ["newest", "middle"]
  );
  assert.equal(recent.filesExamined, 2);
  assert.equal(recent.totalSessionFiles, 3);
  assert.equal(recent.scanTruncated, true);
  assert.equal(Object.hasOwn(recent.sessions[0], "lastAssistantText"), false);
  assert.equal(recent.sessions[0].remoteUrlPresent, true);
  assert.equal(Object.hasOwn(recent.sessions[0], "remoteUrl"), false);
  assert.equal(Object.hasOwn(recent.sessions[0], "file"), false);
  assert.equal(Object.hasOwn(recent.sessions[0], "title"), false);

  const withSensitiveUrls = await listClaudeSessionSummaries(orderedDir, {
    limit: 1,
    includeRemoteUrls: true,
    maxSummaryBytes: 4096,
    byteBudget: 4096,
  });
  assert.equal(withSensitiveUrls.sessions[0].remoteUrl, "https://claude.ai/code/session_sensitive");
  assert.equal(withSensitiveUrls.sessions[0].remoteUrlUpdatedAt, "2026-01-03T00:00:00Z");

  const found = await listClaudeSessionSummaries(orderedDir, {
    limit: 1,
    query: "hidden needle",
    includeSnippets: true,
    scanLimit: 3,
    maxSummaryBytes: 4096,
    byteBudget: 12288,
  });
  assert.equal(found.sessions[0].sessionId, "oldest");
  assert.equal(found.filesExamined, 3);
  assert.equal(found.searchMayBeIncomplete, false);

  const boundedSearch = await listClaudeSessionSummaries(orderedDir, {
    limit: 1,
    query: "hidden needle",
    includeSnippets: true,
    scanLimit: 2,
    maxSummaryBytes: 4096,
    byteBudget: 8192,
  });
  assert.deepEqual(boundedSearch.sessions, []);
  assert.equal(boundedSearch.filesExamined, 2);
  assert.equal(boundedSearch.scanTruncated, true);
  assert.equal(boundedSearch.searchMayBeIncomplete, true);

  const strictScanLimit = await listClaudeSessionSummaries(orderedDir, {
    limit: 3,
    query: "hidden needle",
    includeSnippets: true,
    scanLimit: 1,
    maxSummaryBytes: 4096,
    byteBudget: 4096,
  });
  assert.equal(strictScanLimit.filesExamined, 1);
  assert.equal(strictScanLimit.effectiveScanLimit, 1);

  const budgetDir = path.join(root, "budget");
  const filler = "x".repeat(200);
  const manyRecords = Array.from({ length: 12 }, (_, index) =>
    message(`2026-02-01T00:00:${String(index).padStart(2, "0")}Z`, "assistant", `${index}-${filler}`)
  );
  writeSession(budgetDir, "older-large", manyRecords, 10);
  writeSession(budgetDir, "newer-large", manyRecords, 20);

  const boundedBytes = await listClaudeSessionSummaries(budgetDir, {
    limit: 2,
    includeSnippets: true,
    maxSummaryBytes: 1024,
    byteBudget: 1024,
  });
  assert.equal(boundedBytes.bytesRead, 1024);
  assert.equal(boundedBytes.summariesTruncated, 1);
  assert.equal(boundedBytes.summariesSkipped, 1);
  assert.equal(boundedBytes.sessions[0].summaryTruncated, true);
  assert.equal(boundedBytes.sessions[0].messageCountIsPartial, true);
  assert.equal(boundedBytes.sessions[1].summarySkipped, true);
  assert.equal(boundedBytes.sessions[1].summarySkipReason, "scan_byte_budget_exhausted");
  assert.equal(
    boundedBytes.sessions[1].ultraEffortAttachment.observationCoverage,
    "none"
  );
  assert.equal(
    boundedBytes.sessions[1].ultraEffortAttachment.observationSkippedBytes,
    boundedBytes.sessions[1].size
  );

  const boundedPostureDir = path.join(root, "bounded-posture");
  const boundedPostureId = "12121212-1212-4212-8212-121212121212";
  writeSession(
    boundedPostureDir,
    boundedPostureId,
    [
      {
        sessionId: boundedPostureId,
        timestamp: "2026-02-02T00:00:00Z",
        type: "permission-mode",
        permissionMode: "bypassPermissions",
      },
      {
        sessionId: boundedPostureId,
        timestamp: "2026-02-02T00:00:00.500Z",
        type: "attachment",
        attachment: { type: "ultra_effort_enter", reminderType: "full" },
      },
      {
        sessionId: boundedPostureId,
        timestamp: "2026-02-02T00:00:01Z",
        effort: "high",
        message: {
          role: "assistant",
          model: "claude-head-only",
          content: [{ type: "text", text: "head posture" }],
        },
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        sessionId: boundedPostureId,
        timestamp: `2026-02-02T00:01:${String(index).padStart(2, "0")}Z`,
        isSidechain: true,
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "p".repeat(256) }],
        },
      })),
    ],
    30
  );
  const boundedPosture = await listClaudeSessionSummaries(boundedPostureDir, {
    limit: 1,
    includeSnippets: false,
    maxSummaryBytes: 4096,
    byteBudget: 4096,
  });
  assert.equal(boundedPosture.sessions[0].summaryTruncated, true);
  assert.equal(boundedPosture.sessions[0].observedPermissionMode, null);
  assert.equal(boundedPosture.sessions[0].observedModel, null);
  assert.equal(boundedPosture.sessions[0].observedEffort, null);
  assert.equal(boundedPosture.sessions[0].ultraEffortAttachmentObserved, true);
  assert.equal(boundedPosture.sessions[0].ultraEffortActive, null);
  assert.equal(boundedPosture.sessions[0].ultraEffortLifecycle, "unknown");
  assert.equal(boundedPosture.sessions[0].ultraEffortHistoryIncomplete, true);
  assert.equal(
    boundedPosture.sessions[0].ultraEffortAttachment.observationCoverage,
    "head_tail"
  );
  assert.equal(
    boundedPosture.sessions[0].ultraEffortAttachment.observationSkippedBytes,
    boundedPosture.sessions[0].summaryBytesSkipped
  );
  assert.equal(
    boundedPosture.sessions[0].ultraEffortAttachment.transitionEventsIncluded,
    false
  );
  assert.equal(
    Object.hasOwn(
      boundedPosture.sessions[0].ultraEffortAttachment,
      "transitionEvents"
    ),
    false
  );

  const lifecycleDir = path.join(root, "lifecycle");
  const stateDir = path.join(root, "state");
  const lifecycleId = "22222222-2222-4222-8222-222222222222";
  const lifecycleFile = writeSession(
    lifecycleDir,
    lifecycleId,
    [
      { type: "ai-title", aiTitle: "Generated title", sessionId: lifecycleId },
      {
        type: "attachment",
        attachment: { type: "ultra_effort_enter", reminderType: "full" },
        sessionId: lifecycleId,
        timestamp: "2026-03-01T00:00:00Z",
        version: "2.1.251",
      },
      { type: "agent-name", agentName: "Startup title", sessionId: lifecycleId },
      { type: "custom-title", customTitle: "Renamed session", sessionId: lifecycleId },
      {
        type: "user",
        isMeta: true,
        timestamp: "2026-03-01T00:00:00Z",
        sessionId: lifecycleId,
        message: { role: "user", content: "system reminder should not count" },
      },
      {
        ...message("2026-03-01T00:00:01Z", "user", "real prompt"),
        permissionMode: "bypassPermissions",
        sessionId: lifecycleId,
      },
      {
        ...message("2026-03-01T00:00:01.250Z", "user", "middle searchable needle"),
        sessionId: lifecycleId,
      },
      {
        ...message("2026-03-01T00:00:01.500Z", "assistant", "middle response"),
        sessionId: lifecycleId,
      },
      {
        ...message("2026-03-01T00:00:02Z", "assistant", "real answer"),
        effort: "xhigh",
        sessionId: lifecycleId,
        message: {
          role: "assistant",
          model: "claude-opus-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "real answer" }],
        },
      },
      {
        ...message("2026-03-01T00:00:03Z", "assistant", "synthetic output must be ignored"),
        sessionId: lifecycleId,
        message: {
          role: "assistant",
          model: "<synthetic>",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "synthetic output must be ignored" }],
        },
      },
      {
        type: "attachment",
        attachment: { type: "ultra_effort_exit", reminderType: "full" },
        sessionId: lifecycleId,
        timestamp: "2026-03-01T00:00:04Z",
        version: "2.1.251",
      },
    ],
    40
  );
  const lifecycle = await listClaudeSessionSummaries(lifecycleDir, {
    limit: 5,
    includeSnippets: true,
    archiveState: "all",
    stateDir,
  });
  assert.equal(lifecycle.sessions[0].title, "Renamed session");
  assert.equal(lifecycle.sessions[0].titleSource, "custom-title");
  assert.equal(lifecycle.sessions[0].messageCount, 4);
  assert.equal(lifecycle.sessions[0].lastAssistantText, "real answer");
  assert.equal(lifecycle.sessions[0].observedPermissionMode, "bypassPermissions");
  assert.equal(lifecycle.sessions[0].observedModel, "claude-opus-5");
  assert.equal(lifecycle.sessions[0].observedEffort, "xhigh");
  assert.equal(lifecycle.sessions[0].observedClaudeVersion, "2.1.251");
  assert.equal(lifecycle.sessions[0].ultraEffortAttachmentObserved, true);
  assert.equal(
    lifecycle.sessions[0].ultraEffortAttachmentObservedAt,
    "2026-03-01T00:00:00Z"
  );
  assert.equal(lifecycle.sessions[0].ultraEffortActive, false);
  assert.equal(lifecycle.sessions[0].ultraEffortLifecycle, "inactive_exited");
  assert.equal(
    lifecycle.sessions[0].ultraEffortLastExitedAt,
    "2026-03-01T00:00:04Z"
  );
  assert.equal(lifecycle.sessions[0].ultraEffortAttachment.enterCount, 1);
  assert.equal(lifecycle.sessions[0].ultraEffortAttachment.exitCount, 1);
  assert.equal(
    lifecycle.sessions[0].ultraEffortAttachment.transitionEventsIncluded,
    false
  );
  assert.equal(
    Object.hasOwn(lifecycle.sessions[0].ultraEffortAttachment, "transitionEvents"),
    false
  );
  const lifecycleDetails = await inspectSessionFile(lifecycleFile, 5);
  assert.equal(
    lifecycleDetails.ultraEffortAttachment.transitionEventsIncluded,
    true
  );
  assert.deepEqual(lifecycleDetails.ultraEffortAttachment.transitionEvents, [
    { direction: "enter", at: "2026-03-01T00:00:00Z" },
    { direction: "exit", at: "2026-03-01T00:00:04Z" },
  ]);

  const privateTitleSearch = await listClaudeSessionSummaries(lifecycleDir, {
    limit: 5,
    query: "Renamed session",
    includeSnippets: false,
    archiveState: "all",
    stateDir,
  });
  assert.equal(privateTitleSearch.sessions[0].sessionId, lifecycleId);
  assert.equal(Object.hasOwn(privateTitleSearch.sessions[0], "title"), false);
  const privateMiddleSearch = await listClaudeSessionSummaries(lifecycleDir, {
    limit: 5,
    query: "middle searchable needle",
    includeSnippets: false,
    archiveState: "all",
    stateDir,
  });
  assert.equal(privateMiddleSearch.sessions[0].sessionId, lifecycleId);
  const syntheticSearch = await listClaudeSessionSummaries(lifecycleDir, {
    limit: 5,
    query: "synthetic output must be ignored",
    includeSnippets: false,
    archiveState: "all",
    stateDir,
  });
  assert.equal(syntheticSearch.sessions.length, 0);

  const archived = await setSessionArchiveState(lifecycleDir, lifecycleId, true, stateDir);
  assert.equal(archived.status, "archived");
  assert.equal((await sessionArchiveInfo(lifecycleDir, lifecycleId, stateDir)).archived, true);
  const activeOnly = await listClaudeSessionSummaries(lifecycleDir, {
    archiveState: "active",
    stateDir,
  });
  assert.equal(activeOnly.sessions.length, 0);
  const archivedOnly = await listClaudeSessionSummaries(lifecycleDir, {
    archiveState: "archived",
    stateDir,
  });
  assert.equal(archivedOnly.sessions[0].sessionId, lifecycleId);
  assert.equal(archivedOnly.sessions[0].archived, true);
  const archivesRoot = path.join(stateDir, "archives");
  const markerPath = fs
    .readdirSync(archivesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(archivesRoot, entry.name, `${lifecycleId}.json`))
    .find((candidate) => fs.existsSync(candidate));
  assert.ok(markerPath, "archive marker should exist");
  fs.writeFileSync(markerPath, "{ corrupt marker\n");
  assert.equal((await sessionArchiveInfo(lifecycleDir, lifecycleId, stateDir)).markerCorrupt, true);
  assert.equal(
    (await setSessionArchiveState(lifecycleDir, lifecycleId, true, stateDir)).status,
    "archived"
  );
  assert.equal((await sessionArchiveInfo(lifecycleDir, lifecycleId, stateDir)).archived, true);
  assert.equal((await setSessionArchiveState(lifecycleDir, lifecycleId, false, stateDir)).status, "unarchived");
  const concurrentArchives = await Promise.all(
    Array.from({ length: 20 }, () =>
      setSessionArchiveState(lifecycleDir, lifecycleId, true, stateDir)
    )
  );
  assert.equal(concurrentArchives.filter((result) => result.status === "archived").length, 1);
  assert.equal(
    concurrentArchives.filter((result) => result.status === "already_archived").length,
    19
  );
  assert.equal((await sessionArchiveInfo(lifecycleDir, lifecycleId, stateDir)).archived, true);
  assert.equal(
    fs
      .readdirSync(path.dirname(markerPath))
      .some((name) => name.endsWith(".tmp") || name.endsWith(".lock")),
    false
  );
  assert.equal((await setSessionArchiveState(lifecycleDir, lifecycleId, false, stateDir)).status, "unarchived");

  const isolationDir = path.join(root, "isolation");
  const targetId = "44444444-4444-4444-8444-444444444444";
  const foreignId = "55555555-5555-4555-8555-555555555555";
  const isolationFile = writeSession(
    isolationDir,
    targetId,
    [
      {
        ...message("2026-04-01T00:00:00Z", "user", "target prompt"),
        sessionId: targetId,
      },
      {
        ...message(
          "2026-04-01T00:00:01Z",
          "assistant",
          "target answer with runtime session id"
        ),
        sessionId: targetId,
        session_id: foreignId,
      },
      {
        ...message("2026-04-01T00:00:01.100Z", "assistant", "foreign fallback"),
        session_id: foreignId,
      },
      {
        ...message("2026-04-01T00:00:01.200Z", "assistant", "foreign primary"),
        sessionId: foreignId,
        session_id: targetId,
      },
      message("2026-04-01T00:00:02Z", "user", "legacy prompt"),
      {
        ...message("2026-04-01T00:00:03Z", "assistant", "target answer"),
        session_id: targetId,
      },
      {
        timestamp: "2026-04-01T00:00:04Z",
        effort: "max",
        sessionId: targetId,
        message: {
          role: "assistant",
          model: "claude-tool-model",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", name: "Read", input: {} }],
        },
      },
      {
        ...message("2099-04-01T00:00:05Z", "assistant", "sidechain answer"),
        type: "custom-title",
        customTitle: "Sidechain title",
        sessionId: targetId,
        isSidechain: true,
        permissionMode: "plan",
        effort: "low",
        message: {
          role: "assistant",
          model: "claude-sidechain-model",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "sidechain answer" }],
        },
      },
    ],
    50
  );
  const isolated = await inspectSessionFile(isolationFile, 10);
  assert.deepEqual(
    isolated.recentMessages.map((entry) => entry.text),
    [
      "target prompt",
      "target answer with runtime session id",
      "legacy prompt",
      "target answer",
    ]
  );
  assert.equal(isolated.messageCount, 4);
  assert.equal(isolated.observedModel, "claude-tool-model");
  assert.equal(isolated.observedEffort, "max");
  assert.equal(isolated.observedPermissionMode, null);
  assert.equal(isolated.titlePresent, false);
  assert.equal(isolated.lastTimestamp, "2026-04-01T00:00:04Z");
  assert.equal(JSON.stringify(isolated).includes("foreign fallback"), false);
  assert.equal(JSON.stringify(isolated).includes("foreign primary"), false);
  assert.equal(JSON.stringify(isolated).includes("sidechain answer"), false);

  const boundedTitleDir = path.join(root, "bounded-title");
  const boundedTitle = "Ambiguous bounded title";
  writeSession(
    boundedTitleDir,
    "88888888-8888-4888-8888-888888888888",
    [{ type: "custom-title", customTitle: boundedTitle }],
    2000
  );
  for (let index = 0; index < 500; index += 1) {
    const sessionId =
      `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`;
    writeSession(
      boundedTitleDir,
      sessionId,
      [
        {
          type: "custom-title",
          customTitle:
            index === 499 ? boundedTitle : `Filler title ${index}`,
        },
      ],
      1000 - index
    );
  }
  await assert.rejects(
    resolveClaudeSessionName(root, boundedTitle, boundedTitleDir),
    /Cannot prove.*unique.*resume by UUID/
  );

  const forkBindingDir = path.join(root, "fork-binding");
  const forkBindingId = "12121212-1212-4121-8121-121212121212";
  writeSession(
    forkBindingDir,
    forkBindingId,
    [
      {
        type: "system",
        subtype: "bridge_status",
        timestamp: "2026-07-29T12:00:00Z",
        sessionId: forkBindingId,
        url: "https://claude.ai/code/fork_binding_test",
      },
    ],
    3000
  );
  const uncorroboratedFork = await startedSessionSummary(root, {
    expectedSessionId: null,
    forkSession: true,
    beforeSnapshot: { sessionIds: [] },
    startedAtMs: 0,
    remoteUrl: "",
    projectDirOverride: forkBindingDir,
  });
  assert.equal(uncorroboratedFork.summary, null);
  assert.equal(uncorroboratedFork.ambiguous, false);
  const correlatedFork = await startedSessionSummary(root, {
    expectedSessionId: null,
    forkSession: true,
    beforeSnapshot: { sessionIds: [] },
    startedAtMs: 0,
    remoteUrl: "https://claude.ai/code/fork_binding_test",
    projectDirOverride: forkBindingDir,
  });
  assert.equal(correlatedFork.summary.sessionId, forkBindingId);

  const archiveFilterDir = path.join(root, "archive-filter");
  const newestArchivedId = "66666666-6666-4666-8666-666666666661";
  const middleActiveId = "66666666-6666-4666-8666-666666666662";
  const oldestArchivedId = "66666666-6666-4666-8666-666666666663";
  const newestArchivedFile = writeSession(
    archiveFilterDir,
    newestArchivedId,
    [message("2026-05-01T00:00:03Z", "user", "newest archived")],
    30
  );
  const middleActiveFile = writeSession(
    archiveFilterDir,
    middleActiveId,
    [message("2026-05-01T00:00:02Z", "user", "middle active")],
    20
  );
  const oldestArchivedFile = writeSession(
    archiveFilterDir,
    oldestArchivedId,
    [message("2026-05-01T00:00:01Z", "user", "oldest archived")],
    10
  );
  await setSessionArchiveState(
    archiveFilterDir,
    newestArchivedId,
    true,
    stateDir
  );
  await setSessionArchiveState(
    archiveFilterDir,
    oldestArchivedId,
    true,
    stateDir
  );
  const filteredActive = await listClaudeSessionSummaries(archiveFilterDir, {
    limit: 1,
    scanLimit: 3,
    archiveState: "active",
    stateDir,
  });
  assert.deepEqual(
    filteredActive.sessions.map((session) => session.sessionId),
    [middleActiveId]
  );
  assert.equal(filteredActive.filesExamined, 2);
  assert.equal(filteredActive.effectiveScanLimit, 3);
  assert.equal(filteredActive.bytesRead, fs.statSync(middleActiveFile).size);
  assert.equal(filteredActive.archiveFilterMayBeIncomplete, false);
  const filteredArchived = await listClaudeSessionSummaries(archiveFilterDir, {
    limit: 2,
    scanLimit: 3,
    archiveState: "archived",
    stateDir,
  });
  assert.deepEqual(
    filteredArchived.sessions.map((session) => session.sessionId),
    [newestArchivedId, oldestArchivedId]
  );
  assert.equal(filteredArchived.filesExamined, 3);
  assert.equal(
    filteredArchived.bytesRead,
    fs.statSync(newestArchivedFile).size + fs.statSync(oldestArchivedFile).size
  );
  const boundedActive = await listClaudeSessionSummaries(archiveFilterDir, {
    limit: 1,
    scanLimit: 1,
    archiveState: "active",
    stateDir,
  });
  assert.deepEqual(boundedActive.sessions, []);
  assert.equal(boundedActive.scanTruncated, true);
  assert.equal(boundedActive.archiveFilterMayBeIncomplete, true);
  const unfilteredNewest = await listClaudeSessionSummaries(archiveFilterDir, {
    limit: 1,
    archiveState: "all",
    stateDir,
  });
  assert.equal(unfilteredNewest.sessions[0].sessionId, newestArchivedId);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("session-listing ok");
