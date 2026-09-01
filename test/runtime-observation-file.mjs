import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-runtime-observation-"));
const claudeConfig = path.join(root, ".claude");
const cwd = path.join(root, "project");
const sessionId = "56565656-5656-4656-8656-565656565656";
const startedAtMs = Date.parse("2026-08-18T08:00:00Z");

fs.mkdirSync(cwd, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = claudeConfig;

const {
  runSubmitPrompt,
  runtimeObservationFromRecords,
  sessionRuntimeObservation,
} = await import(
  `../src/index.js?runtime-observation=${Date.now()}`
);

const projectDirectory = path.join(
  claudeConfig,
  "projects",
  (fs.realpathSync.native?.(cwd) ?? fs.realpathSync(cwd)).replace(
    /[^A-Za-z0-9]/g,
    "-"
  )
);
const logFile = path.join(projectDirectory, `${sessionId}.jsonl`);
fs.mkdirSync(projectDirectory, { recursive: true });

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const baseRecord = { sessionId };

try {
  const initialRecords = [
    {
      ...baseRecord,
      timestamp: "2026-08-18T08:00:01Z",
      type: "permission-mode",
      permissionMode: "bypassPermissions",
    },
    {
      ...baseRecord,
      timestamp: "2026-08-18T08:00:02Z",
      effort: "xhigh",
      message: {
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: "initial" }],
      },
    },
    {
      ...baseRecord,
      timestamp: "2026-08-18T08:00:03Z",
      toolUseResult: {
        status: "async_launched",
        taskType: "local_workflow",
        workflowName: "private-name-must-not-escape",
        taskId: "head-private-task-id",
      },
    },
  ];
  const filler = Array.from({ length: 2400 }, (_, index) => ({
    ...baseRecord,
    timestamp: `2026-08-18T08:${String(1 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
    isSidechain: true,
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: "x".repeat(1024) }],
    },
  }));
  fs.writeFileSync(logFile, jsonl([...initialRecords, ...filler]), "utf8");
  assert.ok(fs.statSync(logFile).size > 2 * 1024 * 1024);

  const metadata = { cwd, resolvedSessionId: sessionId, startedAtMs };
  const initial = await sessionRuntimeObservation(metadata);
  assert.equal(initial.permissionMode, null);
  assert.equal(initial.model, null);
  assert.equal(initial.effort, null);
  assert.equal(initial.evidence.permissionMode, "");
  assert.equal(initial.evidence.model, "");
  assert.equal(initial.evidence.effort, "");
  assert.equal(initial.workflowActivity.state, "unknown_due_to_gap");
  assert.equal(initial.workflowActivity.launchObserved, true);
  assert.equal(initial.workflowActivity.launchStatus, "async_launched");
  assert.equal(initial.workflowActivity.pendingCount, null);
  assert.equal(initial.workflowActivity.lastKnownPendingCount, 1);
  assert.equal(initial.workflowActivity.pendingObservedAt, "");
  assert.equal(
    initial.workflowActivity.lastObservedAt,
    "2026-08-18T08:00:03Z"
  );
  assert.equal(
    initial.workflowActivity.evidence,
    "claude_session_log_incomplete"
  );
  assert.equal(initial.workflowActivity.observationUncertain, true);
  assert.equal(initial.workflowActivity.observationCoverage, "head_tail");
  assert.ok(initial.workflowActivity.observationSkippedBytes > 0);
  assert.doesNotMatch(
    JSON.stringify(initial),
    /private-name-must-not-escape|head-private-task-id/
  );

  let mutationCount = 0;
  const blockedSubmit = await runSubmitPrompt(
    {
      managedSession: "runtime-gap-test",
      text: "must not be sent",
      force: false,
    },
    {
      capture: async () => "> ",
      sendText: async () => {
        mutationCount += 1;
      },
      sendKey: async () => {
        mutationCount += 1;
      },
      delay: async () => {},
      promptAcknowledged: async () => false,
      runtimeObservation: async () => initial,
    }
  );
  assert.equal(blockedSubmit.status, "preflight_blocked");
  assert.equal(blockedSubmit.reason, "workflow_pending");
  assert.equal(blockedSubmit.signals.workflowObservationUncertain, true);
  assert.equal(mutationCount, 0);

  fs.appendFileSync(
    logFile,
    jsonl([
      {
        ...baseRecord,
        timestamp: "2026-08-18T09:00:01Z",
        effort: "max",
        message: {
          role: "assistant",
          model: "claude-fable-5",
          content: [{ type: "text", text: "newest" }],
        },
      },
    ]),
    "utf8"
  );
  const appended = await sessionRuntimeObservation(metadata);
  assert.equal(appended.permissionMode, null);
  assert.equal(appended.model, "claude-fable-5");
  assert.equal(appended.effort, "max");
  assert.equal(appended.workflowActivity.state, "unknown_due_to_gap");
  assert.equal(appended.workflowActivity.launchObserved, true);
  assert.equal(appended.workflowActivity.pendingCount, null);
  assert.equal(appended.workflowActivity.lastKnownPendingCount, 1);
  assert.equal(appended.workflowActivity.observationUncertain, true);
  assert.equal(appended.workflowActivity.observationCoverage, "head_tail");

  fs.appendFileSync(
    logFile,
    jsonl([
      {
        ...baseRecord,
        timestamp: "2026-08-18T09:00:02Z",
        toolUseResult: {
          retrieval_status: "success",
          task: {
            task_id: "head-private-task-id",
            status: "completed",
          },
        },
      },
    ]),
    "utf8"
  );
  const terminalResultOnly = await sessionRuntimeObservation(metadata);
  assert.equal(terminalResultOnly.workflowActivity.state, "unknown_due_to_gap");
  assert.equal(terminalResultOnly.workflowActivity.pendingCount, null);
  assert.equal(terminalResultOnly.workflowActivity.lastKnownPendingCount, 1);
  assert.equal(terminalResultOnly.workflowActivity.observationUncertain, true);
  assert.equal(
    terminalResultOnly.workflowActivity.lastObservedAt,
    "2026-08-18T08:00:03Z"
  );

  fs.appendFileSync(
    logFile,
    jsonl([
      {
        ...baseRecord,
        timestamp: "2026-08-18T09:00:03Z",
        pendingWorkflowCount: 1,
      },
    ]),
    "utf8"
  );
  const positiveCheckpoint = await sessionRuntimeObservation(metadata);
  assert.equal(positiveCheckpoint.workflowActivity.state, "pending");
  assert.equal(positiveCheckpoint.workflowActivity.pendingCount, 1);
  assert.equal(positiveCheckpoint.workflowActivity.observationUncertain, false);

  fs.appendFileSync(
    logFile,
    jsonl([
      {
        ...baseRecord,
        timestamp: "2026-08-18T09:00:04Z",
        toolUseResult: {
          retrieval_status: "success",
          task: {
            task_id: "head-private-task-id",
            status: "completed",
          },
        },
      },
    ]),
    "utf8"
  );
  const staleCompletion = await sessionRuntimeObservation(metadata);
  assert.equal(staleCompletion.workflowActivity.state, "pending");
  assert.equal(staleCompletion.workflowActivity.pendingCount, 1);
  assert.equal(staleCompletion.workflowActivity.observationUncertain, false);

  fs.appendFileSync(
    logFile,
    jsonl([
      {
        ...baseRecord,
        timestamp: "2026-08-18T09:00:05Z",
        toolUseResult: {
          status: "async_launched",
          taskType: "local_workflow",
          workflowName: "post-checkpoint-private-name",
          taskId: "post-checkpoint-private-task-id",
        },
      },
    ]),
    "utf8"
  );
  const postCheckpointLaunch = await sessionRuntimeObservation(metadata);
  assert.equal(postCheckpointLaunch.workflowActivity.pendingCount, 2);

  fs.appendFileSync(
    logFile,
    jsonl([
      {
        ...baseRecord,
        timestamp: "2026-08-18T09:00:06Z",
        pendingWorkflowCount: 1,
      },
    ]),
    "utf8"
  );
  const reconciledCheckpoint = await sessionRuntimeObservation(metadata);
  assert.equal(reconciledCheckpoint.workflowActivity.pendingCount, 1);

  fs.appendFileSync(
    logFile,
    jsonl([
      {
        ...baseRecord,
        timestamp: "2026-08-18T09:00:07Z",
        toolUseResult: {
          retrieval_status: "success",
          task: {
            task_id: "post-checkpoint-private-task-id",
            status: "completed",
          },
        },
      },
    ]),
    "utf8"
  );
  const reconciledCompletion = await sessionRuntimeObservation(metadata);
  assert.equal(reconciledCompletion.workflowActivity.pendingCount, 1);

  fs.appendFileSync(
    logFile,
    jsonl([
      {
        ...baseRecord,
        timestamp: "2026-08-18T09:00:08Z",
        pendingWorkflowCount: 0,
      },
    ]),
    "utf8"
  );
  const checkpointed = await sessionRuntimeObservation(metadata);
  assert.equal(checkpointed.permissionMode, null);
  assert.equal(checkpointed.model, "claude-fable-5");
  assert.equal(checkpointed.effort, "max");
  assert.equal(checkpointed.workflowActivity.state, "launch_observed");
  assert.equal(checkpointed.workflowActivity.pendingCount, 0);
  assert.equal(checkpointed.workflowActivity.lastKnownPendingCount, null);
  assert.equal(
    checkpointed.workflowActivity.pendingObservedAt,
    "2026-08-18T09:00:08Z"
  );
  assert.equal(checkpointed.workflowActivity.observationUncertain, false);
  assert.equal(checkpointed.workflowActivity.observationCoverage, "head_tail");
  assert.ok(checkpointed.workflowActivity.observationSkippedBytes > 0);
  assert.equal(checkpointed.workflowActivity.evidence, "claude_session_log");
  assert.doesNotMatch(
    JSON.stringify(checkpointed),
    /post-checkpoint-private-name|post-checkpoint-private-task-id/
  );

  fs.writeFileSync(
    logFile,
    jsonl([
      {
        ...baseRecord,
        timestamp: "2026-08-18T09:05:00Z",
        type: "permission-mode",
        permissionMode: "default",
      },
    ]),
    "utf8"
  );
  const truncated = await sessionRuntimeObservation(metadata);
  assert.equal(truncated.permissionMode, "default");
  assert.equal(truncated.effort, null);
  assert.equal(truncated.workflowActivity.state, "not_observed");
  assert.equal(truncated.workflowActivity.lastKnownPendingCount, null);
  assert.equal(truncated.workflowActivity.observationUncertain, false);
  assert.equal(truncated.workflowActivity.observationCoverage, "full");
  assert.equal(truncated.workflowActivity.observationSkippedBytes, 0);

  fs.appendFileSync(
    logFile,
    jsonl([
      {
        ...baseRecord,
        timestamp: "2026-08-18T09:06:00Z",
        toolUseResult: {
          status: "async_launched",
          taskType: "local_workflow",
          workflowName: "incremental-private-name",
          taskId: "incremental-private-task-id",
        },
      },
    ]),
    "utf8"
  );
  const workflowPending = await sessionRuntimeObservation(metadata);
  assert.equal(workflowPending.workflowActivity.state, "pending");
  assert.equal(workflowPending.workflowActivity.pendingCount, 1);
  assert.equal(
    workflowPending.workflowActivity.pendingObservedAt,
    "2026-08-18T09:06:00Z"
  );

  fs.appendFileSync(
    logFile,
    jsonl([
      {
        ...baseRecord,
        timestamp: "2026-08-18T09:07:00Z",
        toolUseResult: {
          retrieval_status: "success",
          task: {
            task_id: "incremental-private-task-id",
            status: "completed",
          },
        },
      },
    ]),
    "utf8"
  );
  const workflowCompleted = await sessionRuntimeObservation(metadata);
  assert.equal(workflowCompleted.workflowActivity.state, "launch_observed");
  assert.equal(workflowCompleted.workflowActivity.pendingCount, 0);
  assert.equal(
    workflowCompleted.workflowActivity.pendingObservedAt,
    "2026-08-18T09:07:00Z"
  );
  assert.doesNotMatch(
    JSON.stringify(workflowCompleted),
    /incremental-private-name|incremental-private-task-id/
  );

  fs.appendFileSync(
    logFile,
    jsonl([
      {
        ...baseRecord,
        timestamp: "2026-08-18T09:08:00Z",
        toolUseResult: {
          status: "running",
          taskType: "local_workflow",
          workflowName: "direct-terminal-private-name",
          taskId: "direct-terminal-private-task-id",
        },
      },
    ]),
    "utf8"
  );
  const directWorkflowPending = await sessionRuntimeObservation(metadata);
  assert.equal(directWorkflowPending.workflowActivity.state, "pending");
  assert.equal(directWorkflowPending.workflowActivity.pendingCount, 1);

  fs.appendFileSync(
    logFile,
    jsonl([
      {
        ...baseRecord,
        timestamp: "2026-08-18T09:09:00Z",
        toolUseResult: {
          status: "completed",
          taskType: "local_workflow",
          workflowName: "direct-terminal-private-name",
          taskId: "direct-terminal-private-task-id",
        },
      },
    ]),
    "utf8"
  );
  const directWorkflowCompleted = await sessionRuntimeObservation(metadata);
  assert.equal(directWorkflowCompleted.workflowActivity.state, "launch_observed");
  assert.equal(directWorkflowCompleted.workflowActivity.pendingCount, 0);
  assert.equal(
    directWorkflowCompleted.workflowActivity.pendingObservedAt,
    "2026-08-18T09:09:00Z"
  );
  assert.doesNotMatch(
    JSON.stringify(directWorkflowCompleted),
    /direct-terminal-private-name|direct-terminal-private-task-id/
  );

  const interruptionSessionId = "67676767-6767-4676-8676-676767676767";
  const interruptionLogFile = path.join(
    projectDirectory,
    `${interruptionSessionId}.jsonl`
  );
  const interruptionBase = { sessionId: interruptionSessionId };
  fs.writeFileSync(
    interruptionLogFile,
    jsonl([
      {
        ...interruptionBase,
        timestamp: "2026-08-18T10:00:01Z",
        toolUseResult: {
          status: "async_launched",
          taskType: "local_workflow",
          workflowName: "interruption-private-name",
        },
      },
      ...filler.map((record) => ({
        ...record,
        sessionId: interruptionSessionId,
      })),
    ]),
    "utf8"
  );
  const interruptionMetadata = {
    cwd,
    resolvedSessionId: interruptionSessionId,
    startedAtMs,
  };
  const beforeInterruption = await sessionRuntimeObservation(
    interruptionMetadata
  );
  assert.equal(beforeInterruption.workflowActivity.observationUncertain, true);
  fs.appendFileSync(
    interruptionLogFile,
    jsonl([
      {
        ...interruptionBase,
        timestamp: "2026-08-18T10:30:00Z",
        interruptedMessageId: "private-interruption-id",
      },
    ]),
    "utf8"
  );
  const afterInterruption = await sessionRuntimeObservation(
    interruptionMetadata
  );
  assert.equal(afterInterruption.workflowActivity.state, "launch_observed");
  assert.equal(afterInterruption.workflowActivity.pendingCount, 0);
  assert.equal(afterInterruption.workflowActivity.observationUncertain, false);
  assert.doesNotMatch(
    JSON.stringify(afterInterruption),
    /interruption-private-name|private-interruption-id/
  );

  const rewriteSessionId = "78787878-7878-4787-8787-787878787878";
  const rewriteLogFile = path.join(projectDirectory, `${rewriteSessionId}.jsonl`);
  const rewriteBase = { sessionId: rewriteSessionId };
  fs.writeFileSync(
    rewriteLogFile,
    jsonl([
      {
        ...rewriteBase,
        timestamp: "2026-08-18T11:00:00Z",
        pendingWorkflowCount: 0,
      },
    ]),
    "utf8"
  );
  const rewriteMetadata = {
    cwd,
    resolvedSessionId: rewriteSessionId,
    startedAtMs,
  };
  const beforeRewriteStat = fs.statSync(rewriteLogFile);
  const beforeRewrite = await sessionRuntimeObservation(rewriteMetadata);
  assert.equal(beforeRewrite.workflowActivity.state, "idle_count_observed");
  fs.writeFileSync(
    rewriteLogFile,
    jsonl([
      {
        ...rewriteBase,
        timestamp: "2026-08-18T11:01:00Z",
        toolUseResult: {
          status: "async_launched",
          taskType: "local_workflow",
          workflowName: "rewrite-private-name",
          taskId: "rewrite-private-task-id",
        },
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        ...rewriteBase,
        timestamp: `2026-08-18T11:01:${String(index + 1).padStart(2, "0")}Z`,
        isSidechain: true,
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "r".repeat(256) }],
        },
      })),
    ]),
    "utf8"
  );
  const afterRewriteStat = fs.statSync(rewriteLogFile);
  assert.equal(afterRewriteStat.dev, beforeRewriteStat.dev);
  assert.equal(afterRewriteStat.ino, beforeRewriteStat.ino);
  assert.ok(afterRewriteStat.size > beforeRewriteStat.size);
  const afterRewrite = await sessionRuntimeObservation(rewriteMetadata);
  assert.equal(afterRewrite.workflowActivity.state, "pending");
  assert.equal(afterRewrite.workflowActivity.pendingCount, 1);
  assert.doesNotMatch(
    JSON.stringify(afterRewrite),
    /rewrite-private-name|rewrite-private-task-id/
  );

  fs.appendFileSync(
    rewriteLogFile,
    jsonl([
      {
        ...rewriteBase,
        timestamp: "2026-08-18T11:02:00Z",
        pendingWorkflowCount: 0,
      },
    ]),
    "utf8"
  );
  const beforePartial = await sessionRuntimeObservation(rewriteMetadata);
  assert.equal(beforePartial.workflowActivity.pendingCount, 0);
  const partialRecord = `${JSON.stringify({
    ...rewriteBase,
    timestamp: "2026-08-18T11:03:00Z",
    toolUseResult: {
      status: "async_launched",
      taskType: "local_workflow",
      workflowName: "partial-private-name",
      taskId: "partial-private-task-id",
    },
  })}\n`;
  const splitAt = Math.floor(partialRecord.length / 2);
  fs.appendFileSync(rewriteLogFile, partialRecord.slice(0, splitAt), "utf8");
  const partial = await sessionRuntimeObservation(rewriteMetadata);
  assert.equal(partial.workflowActivity.state, "unknown_due_to_gap");
  assert.equal(partial.workflowActivity.pendingCount, null);
  assert.equal(partial.workflowActivity.lastKnownPendingCount, 0);
  assert.equal(partial.workflowActivity.observationUncertain, true);
  fs.appendFileSync(rewriteLogFile, partialRecord.slice(splitAt), "utf8");
  const completedPartial = await sessionRuntimeObservation(rewriteMetadata);
  assert.equal(completedPartial.workflowActivity.state, "pending");
  assert.equal(completedPartial.workflowActivity.pendingCount, 1);
  assert.equal(completedPartial.workflowActivity.observationUncertain, false);
  assert.doesNotMatch(
    JSON.stringify(completedPartial),
    /partial-private-name|partial-private-task-id/
  );

  fs.appendFileSync(
    rewriteLogFile,
    jsonl([
      {
        ...rewriteBase,
        timestamp: "2026-08-18T11:04:00Z",
        pendingWorkflowCount: 0,
      },
    ]),
    "utf8"
  );
  await sessionRuntimeObservation(rewriteMetadata);
  const truncatedPartialRecord = JSON.stringify({
    ...rewriteBase,
    timestamp: "2026-08-18T11:05:00Z",
    toolUseResult: {
      status: "async_launched",
      taskType: "local_workflow",
      workflowName: "truncated-partial-private-name",
    },
  });
  fs.appendFileSync(
    rewriteLogFile,
    truncatedPartialRecord.slice(0, Math.floor(truncatedPartialRecord.length / 2)),
    "utf8"
  );
  const beforePartialTruncation = await sessionRuntimeObservation(
    rewriteMetadata
  );
  assert.equal(
    beforePartialTruncation.workflowActivity.observationUncertain,
    true
  );
  fs.writeFileSync(
    rewriteLogFile,
    jsonl([
      {
        ...rewriteBase,
        timestamp: "2026-08-18T11:06:00Z",
        type: "permission-mode",
        permissionMode: "default",
      },
    ]),
    "utf8"
  );
  const afterPartialTruncation = await sessionRuntimeObservation(
    rewriteMetadata
  );
  assert.equal(afterPartialTruncation.permissionMode, "default");
  assert.equal(afterPartialTruncation.workflowActivity.state, "not_observed");
  assert.equal(
    afterPartialTruncation.workflowActivity.observationUncertain,
    false
  );

  const orderedSessionId = "89898989-8989-4898-8989-898989898989";
  const orderedLogFile = path.join(projectDirectory, `${orderedSessionId}.jsonl`);
  const orderedBase = { sessionId: orderedSessionId };
  fs.writeFileSync(
    orderedLogFile,
    jsonl([
      {
        ...orderedBase,
        timestamp: "2026-08-18T13:10:00Z",
        toolUseResult: {
          status: "async_launched",
          taskType: "local_workflow",
          workflowName: "ordered-private-name",
          taskId: "ordered-private-task-id",
        },
      },
      {
        ...orderedBase,
        timestamp: "2026-08-18T13:05:00Z",
        pendingWorkflowCount: 0,
      },
    ]),
    "utf8"
  );
  const orderedMetadata = {
    cwd,
    resolvedSessionId: orderedSessionId,
    startedAtMs,
  };
  const regressingCounter = await sessionRuntimeObservation(orderedMetadata);
  assert.equal(regressingCounter.workflowActivity.state, "pending");
  assert.equal(regressingCounter.workflowActivity.pendingCount, 1);
  assert.equal(
    regressingCounter.workflowActivity.lastObservedAt,
    "2026-08-18T13:10:00Z"
  );
  let regressingMutationCount = 0;
  const regressingBlocked = await runSubmitPrompt(
    {
      managedSession: "regressing-release-test",
      text: "must not be sent",
      force: false,
    },
    {
      capture: async () => "> ",
      sendText: async () => {
        regressingMutationCount += 1;
      },
      sendKey: async () => {
        regressingMutationCount += 1;
      },
      delay: async () => {},
      promptAcknowledged: async () => false,
      runtimeObservation: async () => regressingCounter,
    }
  );
  assert.equal(regressingBlocked.reason, "workflow_pending");
  assert.equal(regressingMutationCount, 0);

  const interruptionOrderingSessionId =
    "90909090-9090-4909-8909-909090909090";
  const interruptionOrderingLogFile = path.join(
    projectDirectory,
    `${interruptionOrderingSessionId}.jsonl`
  );
  fs.writeFileSync(
    interruptionOrderingLogFile,
    jsonl([
      {
        sessionId: interruptionOrderingSessionId,
        timestamp: "2026-08-18T13:10:00Z",
        toolUseResult: {
          status: "async_launched",
          taskType: "local_workflow",
          workflowName: "ordered-interruption-private-name",
        },
      },
      {
        sessionId: interruptionOrderingSessionId,
        timestamp: "2026-08-18T13:05:00Z",
        interruptedMessageId: "ordered-interruption-private-id",
      },
    ]),
    "utf8"
  );
  const regressingInterruption = await sessionRuntimeObservation({
    cwd,
    resolvedSessionId: interruptionOrderingSessionId,
    startedAtMs,
  });
  assert.equal(regressingInterruption.workflowActivity.state, "pending");
  assert.equal(regressingInterruption.workflowActivity.pendingCount, 1);
  assert.equal(
    regressingInterruption.workflowActivity.lastObservedAt,
    "2026-08-18T13:10:00Z"
  );

  const fullGuardSessionId = "91919191-9191-4919-8919-919191919191";
  const fullGuardLogFile = path.join(
    projectDirectory,
    `${fullGuardSessionId}.jsonl`
  );
  const fullGuardBase = { sessionId: fullGuardSessionId };
  const guardFiller = (prefix, index) =>
    `${JSON.stringify({
      ...fullGuardBase,
      timestamp: `2026-08-18T14:${prefix}:${String(index).padStart(2, "0")}Z`,
      isSidechain: true,
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: prefix.repeat(384) }],
      },
    })}\n`;
  const guardedPrefix = [
    `${JSON.stringify({
      ...fullGuardBase,
      timestamp: "2026-08-18T14:00:00Z",
      pendingWorkflowCount: 0,
    })}\n`,
    ...Array.from({ length: 14 }, (_, index) => guardFiller("p", index + 1)),
  ].join("");
  const guardedSuffix = Array.from({ length: 14 }, (_, index) =>
    guardFiller("s", index + 1)
  ).join("");
  const guardedLaunch = JSON.stringify({
    ...fullGuardBase,
    timestamp: "2026-08-18T14:20:00Z",
    toolUseResult: {
      status: "async_launched",
      taskType: "local_workflow",
      workflowName: "full-guard-private-name",
      taskId: "full-guard-private-task-id",
    },
  });
  const guardedNoOpBase = JSON.stringify({
    ...fullGuardBase,
    timestamp: "2026-08-18T14:20:00Z",
    padding: "",
  });
  const guardedPaddingLength = guardedLaunch.length - guardedNoOpBase.length;
  assert.ok(guardedPaddingLength >= 0);
  const guardedNoOp = JSON.stringify({
    ...fullGuardBase,
    timestamp: "2026-08-18T14:20:00Z",
    padding: "x".repeat(guardedPaddingLength),
  });
  assert.equal(guardedNoOp.length, guardedLaunch.length);
  const guardedOriginal = `${guardedPrefix}${guardedNoOp}\n${guardedSuffix}`;
  fs.writeFileSync(fullGuardLogFile, guardedOriginal, "utf8");
  const fullGuardMetadata = {
    cwd,
    resolvedSessionId: fullGuardSessionId,
    startedAtMs,
  };
  const guardedIdle = await sessionRuntimeObservation(fullGuardMetadata);
  assert.equal(guardedIdle.workflowActivity.state, "idle_count_observed");
  assert.ok(Buffer.byteLength(guardedPrefix) > 4096);
  assert.ok(Buffer.byteLength(guardedSuffix) > 4096);
  const guardStatBefore = fs.statSync(fullGuardLogFile);
  const guardedAppend = `${JSON.stringify({
    ...fullGuardBase,
    timestamp: "2026-08-18T14:30:00Z",
    message: {
      role: "assistant",
      model: "claude-fable-5",
      content: [{ type: "text", text: "new tail" }],
    },
  })}\n`;
  fs.writeFileSync(
    fullGuardLogFile,
    `${guardedPrefix}${guardedLaunch}\n${guardedSuffix}${guardedAppend}`,
    "utf8"
  );
  const guardStatAfter = fs.statSync(fullGuardLogFile);
  assert.equal(guardStatAfter.dev, guardStatBefore.dev);
  assert.equal(guardStatAfter.ino, guardStatBefore.ino);
  assert.ok(guardStatAfter.size > guardStatBefore.size);
  const guardedRewrite = await sessionRuntimeObservation(fullGuardMetadata);
  assert.equal(guardedRewrite.workflowActivity.state, "pending");
  assert.equal(guardedRewrite.workflowActivity.pendingCount, 1);
  assert.doesNotMatch(
    JSON.stringify(guardedRewrite),
    /full-guard-private-name|full-guard-private-task-id/
  );

  const mixedIdentity = runtimeObservationFromRecords([
    {
      timestamp: "2026-08-18T15:10:00Z",
      toolUseResult: {
        status: "async_launched",
        taskType: "local_workflow",
        workflowName: "mixed-identified-private-name",
        taskId: "mixed-identified-private-task-id",
      },
    },
    {
      timestamp: "2026-08-18T15:10:01Z",
      toolUseResult: {
        status: "async_launched",
        taskType: "local_workflow",
        workflowName: "mixed-unidentified-private-name",
      },
    },
    {
      timestamp: "2026-08-18T15:10:02Z",
      pendingWorkflowCount: 1,
    },
    {
      timestamp: "2026-08-18T15:10:03Z",
      toolUseResult: {
        retrieval_status: "success",
        task: {
          task_id: "mixed-identified-private-task-id",
          status: "completed",
        },
      },
    },
  ]);
  assert.equal(mixedIdentity.workflowActivity.state, "pending");
  assert.equal(mixedIdentity.workflowActivity.pendingCount, 1);
  assert.equal(
    mixedIdentity.workflowActivity.lastObservedAt,
    "2026-08-18T15:10:02Z"
  );
  assert.doesNotMatch(
    JSON.stringify(mixedIdentity),
    /mixed-identified-private-name|mixed-unidentified-private-name|mixed-identified-private-task-id/
  );

  const untrackedCompletion = runtimeObservationFromRecords([
    {
      timestamp: "2026-08-18T15:20:00Z",
      toolUseResult: {
        status: "async_launched",
        taskType: "local_workflow",
        workflowName: "tracked-private-name",
        taskId: "tracked-private-task-id",
      },
    },
    {
      timestamp: "2026-08-18T15:20:10Z",
      toolUseResult: {
        retrieval_status: "success",
        task: {
          task_id: "historical-private-task-id",
          status: "completed",
        },
      },
    },
    {
      timestamp: "2026-08-18T15:20:11Z",
      toolUseResult: {
        status: "completed",
        taskType: "local_workflow",
        workflowName: "historical-direct-private-name",
        taskId: "historical-direct-private-task-id",
      },
    },
    {
      timestamp: "2026-08-18T15:20:05Z",
      toolUseResult: {
        retrieval_status: "success",
        task: {
          task_id: "tracked-private-task-id",
          status: "completed",
        },
      },
    },
  ]);
  assert.equal(untrackedCompletion.workflowActivity.state, "launch_observed");
  assert.equal(untrackedCompletion.workflowActivity.pendingCount, 0);
  assert.equal(
    untrackedCompletion.workflowActivity.lastObservedAt,
    "2026-08-18T15:20:05Z"
  );
  assert.doesNotMatch(
    JSON.stringify(untrackedCompletion),
    /tracked-private-name|tracked-private-task-id|historical-private-task-id|historical-direct-private-name|historical-direct-private-task-id/
  );

  const replaySessionId = "93939393-9393-4939-8939-939393939393";
  const replayLogFile = path.join(projectDirectory, `${replaySessionId}.jsonl`);
  const replayBase = { sessionId: replaySessionId };
  const replayFiller = (marker, count) =>
    Array.from({ length: count }, (_, index) => ({
      ...replayBase,
      timestamp: "2026-08-18T15:30:00Z",
      isSidechain: true,
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: `${marker}${"x".repeat(1023)}` }],
      },
      index,
    }));
  fs.writeFileSync(
    replayLogFile,
    jsonl([
      {
        ...replayBase,
        timestamp: "2026-08-18T15:30:10Z",
        pendingWorkflowCount: 0,
      },
      ...replayFiller("head", 320),
      {
        ...replayBase,
        timestamp: "2026-08-18T15:30:20Z",
        toolUseResult: {
          status: "async_launched",
          taskType: "local_workflow",
          workflowName: "hidden-middle-private-name",
          taskId: "hidden-middle-private-task-id",
        },
      },
      ...replayFiller("tail", 2100),
      {
        ...replayBase,
        timestamp: "2026-08-18T15:30:15Z",
        pendingWorkflowCount: 0,
      },
    ]),
    "utf8"
  );
  assert.ok(fs.statSync(replayLogFile).size > 2.5 * 1024 * 1024);
  const boundedGap = await sessionRuntimeObservation({
    cwd,
    resolvedSessionId: replaySessionId,
    startedAtMs,
  });
  assert.equal(boundedGap.workflowActivity.state, "idle_count_observed");
  assert.equal(boundedGap.workflowActivity.pendingCount, 0);
  assert.equal(boundedGap.workflowActivity.observationUncertain, false);
  assert.equal(boundedGap.workflowActivity.observationCoverage, "head_tail");
  const replayBytes = fs.readFileSync(replayLogFile);
  const replayHead = replayBytes.subarray(0, 256 * 1024);
  const replayProcessedHeadBytes = replayHead.lastIndexOf(0x0a) + 1;
  const replayTailStart = Math.max(
    256 * 1024,
    replayBytes.length - 2 * 1024 * 1024
  );
  const replayFirstTailNewline = replayBytes.indexOf(0x0a, replayTailStart);
  const expectedReplaySkippedBytes =
    (replayFirstTailNewline >= 0
      ? replayFirstTailNewline + 1
      : replayBytes.length) - replayProcessedHeadBytes;
  assert.equal(
    boundedGap.workflowActivity.observationSkippedBytes,
    expectedReplaySkippedBytes
  );
  assert.equal(
    boundedGap.workflowActivity.lastObservedAt,
    "2026-08-18T15:30:15Z"
  );
  assert.doesNotMatch(
    JSON.stringify(boundedGap),
    /hidden-middle-private-name|hidden-middle-private-task-id/
  );

  const metadataGuardSessionId = "94949494-9494-4949-8949-949494949494";
  const metadataGuardLogFile = path.join(
    projectDirectory,
    `${metadataGuardSessionId}.jsonl`
  );
  const metadataGuardBase = { sessionId: metadataGuardSessionId };
  const metadataGuardLaunch = JSON.stringify({
    ...metadataGuardBase,
    timestamp: "2026-08-18T15:40:00Z",
    toolUseResult: {
      status: "async_launched",
      taskType: "local_workflow",
      workflowName: "metadata-guard-private-name",
      taskId: "metadata-guard-private-task-id",
    },
  });
  const metadataGuardNoOpBase = JSON.stringify({
    ...metadataGuardBase,
    timestamp: "2026-08-18T15:40:00Z",
    pendingWorkflowCount: 0,
    padding: "",
  });
  const metadataGuardPaddingLength =
    metadataGuardLaunch.length - metadataGuardNoOpBase.length;
  assert.ok(metadataGuardPaddingLength >= 0);
  const metadataGuardNoOp = JSON.stringify({
    ...metadataGuardBase,
    timestamp: "2026-08-18T15:40:00Z",
    pendingWorkflowCount: 0,
    padding: "x".repeat(metadataGuardPaddingLength),
  });
  assert.equal(metadataGuardNoOp.length, metadataGuardLaunch.length);
  fs.writeFileSync(metadataGuardLogFile, `${metadataGuardNoOp}\n`, "utf8");
  const fixedGuardTime = new Date("2026-08-18T15:40:30Z");
  fs.utimesSync(metadataGuardLogFile, fixedGuardTime, fixedGuardTime);
  const metadataGuardMetadata = {
    cwd,
    resolvedSessionId: metadataGuardSessionId,
    startedAtMs,
  };
  const metadataGuardIdle = await sessionRuntimeObservation(
    metadataGuardMetadata
  );
  assert.equal(metadataGuardIdle.workflowActivity.state, "idle_count_observed");
  const metadataGuardStatBefore = fs.statSync(metadataGuardLogFile);
  fs.writeFileSync(metadataGuardLogFile, `${metadataGuardLaunch}\n`, "utf8");
  fs.utimesSync(metadataGuardLogFile, fixedGuardTime, fixedGuardTime);
  const metadataGuardStatAfter = fs.statSync(metadataGuardLogFile);
  assert.equal(metadataGuardStatAfter.size, metadataGuardStatBefore.size);
  assert.equal(metadataGuardStatAfter.mtimeMs, metadataGuardStatBefore.mtimeMs);
  const originalLstat = fs.promises.lstat;
  fs.promises.lstat = async (...args) => {
    const stat = await originalLstat(...args);
    if (path.resolve(args[0]) !== path.resolve(metadataGuardLogFile)) return stat;
    return new Proxy(stat, {
      get(target, property) {
        if (property === "mtimeMs") return metadataGuardStatBefore.mtimeMs;
        if (property === "ctimeMs") return metadataGuardStatBefore.ctimeMs;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  let metadataGuardPending;
  try {
    metadataGuardPending = await sessionRuntimeObservation(
      metadataGuardMetadata
    );
  } finally {
    fs.promises.lstat = originalLstat;
  }
  assert.equal(metadataGuardPending.workflowActivity.state, "pending");
  assert.equal(metadataGuardPending.workflowActivity.pendingCount, 1);
  assert.doesNotMatch(
    JSON.stringify(metadataGuardPending),
    /metadata-guard-private-name|metadata-guard-private-task-id/
  );

  const bufferedSessionId = "95959595-9595-4959-8959-959595959595";
  const bufferedLogFile = path.join(
    projectDirectory,
    `${bufferedSessionId}.jsonl`
  );
  const bufferedBase = { sessionId: bufferedSessionId };
  fs.writeFileSync(
    bufferedLogFile,
    jsonl([
      {
        ...bufferedBase,
        timestamp: "2026-08-18T15:50:00Z",
        pendingWorkflowCount: 0,
      },
    ]),
    "utf8"
  );
  const bufferedMetadata = {
    cwd,
    resolvedSessionId: bufferedSessionId,
    startedAtMs,
  };
  await sessionRuntimeObservation(bufferedMetadata);
  const bufferedRecord = JSON.stringify({
    ...bufferedBase,
    timestamp: "2026-08-18T15:50:01Z",
    padding: "b".repeat(3 * 1024 * 1024),
    pendingWorkflowCount: 1,
  });
  fs.appendFileSync(bufferedLogFile, bufferedRecord, "utf8");
  const bufferedPending = await sessionRuntimeObservation(bufferedMetadata);
  assert.equal(bufferedPending.workflowActivity.state, "pending_without_launch_record");
  assert.equal(bufferedPending.workflowActivity.pendingCount, 1);
  assert.equal(bufferedPending.workflowActivity.observationUncertain, false);

  const overflowSessionId = "96969696-9696-4969-8969-969696969696";
  const overflowLogFile = path.join(
    projectDirectory,
    `${overflowSessionId}.jsonl`
  );
  const overflowBase = { sessionId: overflowSessionId };
  fs.writeFileSync(
    overflowLogFile,
    jsonl([
      {
        ...overflowBase,
        timestamp: "2026-08-18T16:00:00Z",
        pendingWorkflowCount: 0,
      },
    ]),
    "utf8"
  );
  const overflowMetadata = {
    cwd,
    resolvedSessionId: overflowSessionId,
    startedAtMs,
  };
  await sessionRuntimeObservation(overflowMetadata);
  const overflowRecord = JSON.stringify({
    ...overflowBase,
    timestamp: "2026-08-18T16:00:01Z",
    padding: "o".repeat(9 * 1024 * 1024),
    pendingWorkflowCount: 1,
  });
  fs.appendFileSync(overflowLogFile, overflowRecord, "utf8");
  const overflowIncomplete = await sessionRuntimeObservation(overflowMetadata);
  assert.equal(overflowIncomplete.workflowActivity.state, "unknown_due_to_gap");
  assert.equal(overflowIncomplete.workflowActivity.pendingCount, null);
  assert.equal(overflowIncomplete.workflowActivity.observationUncertain, true);
  fs.appendFileSync(
    overflowLogFile,
    `\n${jsonl([
      {
        ...overflowBase,
        timestamp: "2026-08-18T16:00:02Z",
        pendingWorkflowCount: 0,
      },
    ])}`,
    "utf8"
  );
  const overflowReleased = await sessionRuntimeObservation(overflowMetadata);
  assert.equal(overflowReleased.workflowActivity.state, "idle_count_observed");
  assert.equal(overflowReleased.workflowActivity.pendingCount, 0);
  assert.equal(overflowReleased.workflowActivity.lastKnownPendingCount, null);
  assert.equal(overflowReleased.workflowActivity.observationUncertain, false);
  assert.equal(
    overflowReleased.workflowActivity.observationSkippedBytes,
    Buffer.byteLength(overflowRecord) + 1
  );
  assert.equal(
    overflowReleased.ultraEffortAttachment.historyCoverage,
    "partial"
  );
  assert.equal(
    overflowReleased.ultraEffortAttachment.observationUncertain,
    true
  );
  fs.appendFileSync(
    overflowLogFile,
    jsonl([
      {
        ...overflowBase,
        type: "attachment",
        timestamp: "2026-08-18T16:00:03Z",
        attachment: { type: "ultra_effort_enter", reminderType: "full" },
      },
    ]),
    "utf8"
  );
  const overflowUltraRecovered = await sessionRuntimeObservation(
    overflowMetadata
  );
  assert.equal(overflowUltraRecovered.ultracode, true);
  assert.equal(
    overflowUltraRecovered.ultraEffortAttachment.lifecycle,
    "active"
  );
  assert.equal(
    overflowUltraRecovered.ultraEffortAttachment.historyCoverage,
    "partial"
  );
  assert.equal(
    overflowUltraRecovered.ultraEffortAttachment.countsAreLowerBound,
    true
  );

  const lifecycleSessionId = "97979797-9797-4979-8979-979797979797";
  const lifecycleLogFile = path.join(
    projectDirectory,
    `${lifecycleSessionId}.jsonl`
  );
  const lifecycleBase = { sessionId: lifecycleSessionId };
  const lifecycleMetadata = {
    cwd,
    resolvedSessionId: lifecycleSessionId,
    startedAtMs,
  };
  fs.writeFileSync(
    lifecycleLogFile,
    jsonl([
      {
        ...lifecycleBase,
        type: "attachment",
        timestamp: "2026-08-18T16:05:00Z",
        attachment: { type: "ultra_effort_enter", reminderType: "full" },
      },
    ]),
    "utf8"
  );
  const lifecycleEntered = await sessionRuntimeObservation(lifecycleMetadata);
  assert.equal(lifecycleEntered.ultracode, true);
  assert.equal(lifecycleEntered.ultraEffortAttachment.lifecycle, "active");

  const exitRecord = JSON.stringify({
    ...lifecycleBase,
    type: "attachment",
    timestamp: "2026-08-18T16:05:01Z",
    attachment: { type: "ultra_effort_exit", reminderType: "full" },
  });
  const exitSplit = Math.floor(exitRecord.length / 2);
  fs.appendFileSync(lifecycleLogFile, exitRecord.slice(0, exitSplit), "utf8");
  const lifecyclePartialExit = await sessionRuntimeObservation(
    lifecycleMetadata
  );
  assert.equal(lifecyclePartialExit.ultracode, null);
  assert.equal(lifecyclePartialExit.ultraEffortAttachment.active, null);
  assert.equal(lifecyclePartialExit.ultraEffortAttachment.lifecycle, "unknown");
  assert.equal(
    lifecyclePartialExit.ultraEffortAttachment.activeUnknownReason,
    "trailing_record_incomplete"
  );
  fs.appendFileSync(
    lifecycleLogFile,
    `${exitRecord.slice(exitSplit)}\n`,
    "utf8"
  );
  const lifecycleExited = await sessionRuntimeObservation(lifecycleMetadata);
  assert.equal(lifecycleExited.ultracode, false);
  assert.equal(
    lifecycleExited.ultraEffortAttachment.lifecycle,
    "inactive_exited"
  );
  assert.equal(lifecycleExited.ultraEffortAttachment.exitCount, 1);

  fs.appendFileSync(
    lifecycleLogFile,
    jsonl([
      {
        ...lifecycleBase,
        type: "attachment",
        timestamp: "2026-08-18T16:05:02Z",
        attachment: { type: "workflow_keyword_request" },
      },
      {
        ...lifecycleBase,
        type: "attachment",
        timestamp: "2026-08-18T16:05:03Z",
        attachment: { type: "ultra_effort_enter", reminderType: "full" },
      },
    ]),
    "utf8"
  );
  const lifecycleReentered = await sessionRuntimeObservation(
    lifecycleMetadata
  );
  assert.equal(lifecycleReentered.ultracode, true);
  assert.equal(lifecycleReentered.ultraEffortAttachment.lifecycle, "active");
  assert.equal(lifecycleReentered.ultraEffortAttachment.enterCount, 2);
  assert.equal(
    lifecycleReentered.ultraEffortAttachment.workflowKeywordRequestCount,
    1
  );

  const concurrentFragments = Array.from({ length: 5 }, (_, index) => {
    const digit = String(index + 1);
    const concurrentSessionId = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
    const concurrentLogFile = path.join(
      projectDirectory,
      `${concurrentSessionId}.jsonl`
    );
    const concurrentBase = { sessionId: concurrentSessionId };
    const concurrentMetadata = {
      cwd,
      resolvedSessionId: concurrentSessionId,
      startedAtMs,
    };
    const completeRecord = JSON.stringify({
      ...concurrentBase,
      timestamp: `2026-08-18T16:10:0${index}Z`,
      padding: digit.repeat(7 * 1024 * 1024),
      pendingWorkflowCount: 1,
    });
    return {
      base: concurrentBase,
      completeRecord,
      file: concurrentLogFile,
      metadata: concurrentMetadata,
    };
  });
  for (const fragment of concurrentFragments) {
    fs.writeFileSync(
      fragment.file,
      jsonl([
        {
          ...fragment.base,
          timestamp: "2026-08-18T16:09:59Z",
          pendingWorkflowCount: 0,
        },
      ]),
      "utf8"
    );
  }
  await Promise.all(
    concurrentFragments.map((fragment) =>
      sessionRuntimeObservation(fragment.metadata)
    )
  );
  for (const fragment of concurrentFragments) {
    fs.appendFileSync(
      fragment.file,
      fragment.completeRecord.slice(0, -1),
      "utf8"
    );
  }
  const incompleteFragments = await Promise.all(
    concurrentFragments.map((fragment) =>
      sessionRuntimeObservation(fragment.metadata)
    )
  );
  assert.ok(
    incompleteFragments.every(
      (observation) => observation.workflowActivity.observationUncertain
    )
  );
  for (const fragment of concurrentFragments) {
    fs.appendFileSync(fragment.file, "}\n", "utf8");
  }
  const completedFragments = await Promise.all(
    concurrentFragments.map((fragment) =>
      sessionRuntimeObservation(fragment.metadata)
    )
  );
  const overflowedFragmentCount = completedFragments.filter(
    (observation) => observation.workflowActivity.observationUncertain
  ).length;
  assert.ok(overflowedFragmentCount >= 1);
  assert.ok(overflowedFragmentCount < concurrentFragments.length);
  assert.ok(
    completedFragments.every(
      (observation) =>
        observation.workflowActivity.observationUncertain ||
        observation.workflowActivity.pendingCount === 1
    )
  );

  const noNewlineSessionId = "92929292-9292-4929-8929-929292929292";
  const noNewlineLogFile = path.join(
    projectDirectory,
    `${noNewlineSessionId}.jsonl`
  );
  fs.writeFileSync(
    noNewlineLogFile,
    JSON.stringify({
      sessionId: noNewlineSessionId,
      timestamp: "2026-08-18T15:00:00Z",
      toolUseResult: {
        status: "async_launched",
        taskType: "local_workflow",
        workflowName: "no-newline-private-name",
        taskId: "no-newline-private-task-id",
      },
    }),
    "utf8"
  );
  const noNewline = await sessionRuntimeObservation({
    cwd,
    resolvedSessionId: noNewlineSessionId,
    startedAtMs,
  });
  assert.equal(noNewline.workflowActivity.state, "pending");
  assert.equal(noNewline.workflowActivity.pendingCount, 1);
  assert.equal(noNewline.workflowActivity.observationUncertain, false);
  assert.doesNotMatch(
    JSON.stringify(noNewline),
    /no-newline-private-name|no-newline-private-task-id/
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("runtime-observation-file ok");
