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
  freshWorkflowSnapshotLogIdentity,
  reconstructWorkflowObservation,
  signalsWithWorkflowActivity,
  lifecycleBlockReason,
  waitTurnDecision,
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
        model: "claude-fable-5-1",
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
        runId: "head-private-run-id",
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
  assert.equal(initial.workflowActivity.state, "pending");
  assert.equal(initial.workflowActivity.launchObserved, true);
  assert.equal(initial.workflowActivity.launchStatus, "async_launched");
  assert.equal(initial.workflowActivity.pendingCount, 1);
  assert.equal(initial.workflowActivity.lastKnownPendingCount, null);
  assert.equal(initial.workflowActivity.pendingObservedAt, "2026-08-18T08:00:03Z");
  assert.equal(
    initial.workflowActivity.lastObservedAt,
    "2026-08-18T08:00:03Z"
  );
  assert.equal(
    initial.workflowActivity.evidence,
    "claude_session_log"
  );
  assert.equal(initial.workflowActivity.observationUncertain, false);
  assert.equal(initial.workflowActivity.reconstruction.status, "complete");
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
  assert.equal(blockedSubmit.signals.workflowObservationUncertain, false);
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
          model: "claude-fable-5-1",
          content: [{ type: "text", text: "newest" }],
        },
      },
    ]),
    "utf8"
  );
  const appended = await sessionRuntimeObservation(metadata);
  assert.equal(appended.permissionMode, null);
  assert.equal(appended.model, "claude-fable-5-1");
  assert.equal(appended.effort, "max");
  assert.equal(appended.workflowActivity.state, "pending");
  assert.equal(appended.workflowActivity.launchObserved, true);
  assert.equal(appended.workflowActivity.pendingCount, 1);
  assert.equal(appended.workflowActivity.lastKnownPendingCount, null);
  assert.equal(appended.workflowActivity.observationUncertain, false);
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
            run_id: "head-private-run-id",
            status: "completed",
          },
        },
      },
    ]),
    "utf8"
  );
  const terminalResultOnly = await sessionRuntimeObservation(metadata);
  assert.equal(terminalResultOnly.workflowActivity.state, "launch_observed");
  assert.equal(terminalResultOnly.workflowActivity.pendingCount, 0);
  assert.equal(terminalResultOnly.workflowActivity.lastKnownPendingCount, null);
  assert.equal(terminalResultOnly.workflowActivity.observationUncertain, false);
  assert.equal(
    terminalResultOnly.workflowActivity.lastObservedAt,
    "2026-08-18T09:00:02Z"
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
          runId: "post-checkpoint-private-run-id",
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
  assert.equal(reconciledCheckpoint.workflowActivity.pendingCount, 2);
  assert.equal(reconciledCheckpoint.workflowActivity.observationUncertain, false);

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
            run_id: "post-checkpoint-private-run-id",
            status: "completed",
          },
        },
      },
    ]),
    "utf8"
  );
  const reconciledCompletion = await sessionRuntimeObservation(metadata);
  assert.equal(reconciledCompletion.workflowActivity.pendingCount, 1);
  assert.equal(reconciledCompletion.workflowActivity.observationUncertain, false);

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
  assert.equal(checkpointed.model, "claude-fable-5-1");
  assert.equal(checkpointed.effort, "max");
  assert.equal(checkpointed.workflowActivity.state, "pending");
  // A counter without task/run identity cannot clear the unresolved workflow
  // carried across the earlier history gap.
  assert.equal(checkpointed.workflowActivity.pendingCount, 1);
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
          runId: "incremental-private-run-id",
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
            run_id: "incremental-private-run-id",
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
          runId: "direct-terminal-private-run-id",
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
          runId: "direct-terminal-private-run-id",
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
  assert.equal(beforeInterruption.workflowActivity.observationUncertain, false);
  assert.equal(beforeInterruption.workflowActivity.pendingCount, 1);
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
  assert.equal(beforePartial.workflowActivity.pendingCount, 1);
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
  assert.equal(partial.workflowActivity.lastKnownPendingCount, 1);
  assert.equal(partial.workflowActivity.observationUncertain, true);
  fs.appendFileSync(rewriteLogFile, partialRecord.slice(splitAt), "utf8");
  const completedPartial = await sessionRuntimeObservation(rewriteMetadata);
  assert.equal(completedPartial.workflowActivity.state, "pending");
  assert.equal(completedPartial.workflowActivity.pendingCount, 2);
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
      model: "claude-fable-5-1",
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
  assert.equal(mixedIdentity.workflowActivity.pendingCount, 2);
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
        runId: "tracked-private-run-id",
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
          run_id: "tracked-private-run-id",
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

  const runBoundLaunch = {
    timestamp: "2026-08-18T15:25:00Z",
    toolUseResult: {
      status: "async_launched",
      taskType: "local_workflow",
      workflowName: "run-bound-private-name",
      taskId: "run-bound-private-task-id",
      runId: "run-bound-current-private-run-id",
    },
  };
  const directRunMismatch = runtimeObservationFromRecords([
    runBoundLaunch,
    {
      timestamp: "2026-08-18T15:25:01Z",
      pendingWorkflowCount: 0,
      toolUseResult: {
        status: "completed",
        taskType: "local_workflow",
        workflowName: "run-bound-private-name",
        taskId: "run-bound-private-task-id",
        runId: "run-bound-stale-private-run-id",
      },
    },
  ]);
  assert.equal(directRunMismatch.workflowActivity.state, "pending");
  assert.equal(directRunMismatch.workflowActivity.pendingCount, 1);

  const directRunMissing = runtimeObservationFromRecords([
    runBoundLaunch,
    {
      timestamp: "2026-08-18T15:25:02Z",
      pendingWorkflowCount: 0,
      toolUseResult: {
        status: "completed",
        taskType: "local_workflow",
        workflowName: "run-bound-private-name",
        taskId: "run-bound-private-task-id",
      },
    },
  ]);
  assert.equal(directRunMissing.workflowActivity.state, "pending");
  assert.equal(directRunMissing.workflowActivity.pendingCount, 1);

  const retrievalRunMismatch = runtimeObservationFromRecords([
    runBoundLaunch,
    {
      timestamp: "2026-08-18T15:25:03Z",
      pendingWorkflowCount: 0,
      toolUseResult: {
        retrieval_status: "success",
        task: {
          task_id: "run-bound-private-task-id",
          run_id: "run-bound-stale-private-run-id",
          status: "completed",
        },
      },
    },
  ]);
  assert.equal(retrievalRunMismatch.workflowActivity.state, "pending");
  assert.equal(retrievalRunMismatch.workflowActivity.pendingCount, 1);

  // The real CLI 2.1.275 TaskOutput retrievals on record carry task_id but no run
  // ID. A retrieval without a run ID releases the matching run-bound launch.
  const retrievalRunMissing = runtimeObservationFromRecords([
    runBoundLaunch,
    {
      timestamp: "2026-08-18T15:25:04Z",
      toolUseResult: {
        retrieval_status: "success",
        task: {
          task_id: "run-bound-private-task-id",
          task_type: "local_workflow",
          status: "completed",
          description: "synthetic",
          output: "synthetic",
        },
      },
    },
  ]);
  assert.equal(retrievalRunMissing.workflowActivity.pendingCount, 0, "a run-ID-less retrieval must release its matching launch");
  // CLI 2.1.289 has no TaskOutput tool; Claude records a task notification
  // marked by origin {kind: "task-notification"}, as a user record or as a
  // queued_command attachment (seen in a resumed session).
  const notificationText = (taskId, status, result = "done") =>
    `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_synthetic</tool-use-id>\n<output-file>C:\\synthetic\\out.output</output-file>\n<status>${status}</status>\n<summary>synthetic</summary>\n<result>${result}</result>\n</task-notification>`;
  const userNotification = (taskId, status, timestamp = "2026-08-18T15:25:05Z", result) => ({
    timestamp, type: "user", origin: { kind: "task-notification", producer: "session-task" },
    message: { role: "user", content: notificationText(taskId, status, result) },
  });
  const attachmentNotification = (taskId, status, timestamp = "2026-08-18T15:25:05Z") => ({
    timestamp, type: "attachment",
    attachment: { type: "queued_command", commandMode: "task-notification", origin: { kind: "task-notification", producer: "session-task" }, prompt: notificationText(taskId, status) },
  });
  const runBoundTask = "run-bound-private-task-id";
  assert.equal(runtimeObservationFromRecords([runBoundLaunch, userNotification(runBoundTask, "completed")]).workflowActivity.pendingCount, 0, "a Claude task notification releases its tracked launch");
  assert.equal(runtimeObservationFromRecords([runBoundLaunch, attachmentNotification(runBoundTask, "completed")]).workflowActivity.pendingCount, 0, "a queued task notification (resumed session) releases its tracked launch");
  assert.equal(runtimeObservationFromRecords([runBoundLaunch, userNotification(runBoundTask, "running")]).workflowActivity.pendingCount, 1, "a non-terminal notification must not release");
  for (const status of ["failed", "killed"]) {
    assert.equal(runtimeObservationFromRecords([runBoundLaunch, attachmentNotification(runBoundTask, status)]).workflowActivity.pendingCount, 0, `a ${status} notification releases its tracked launch`);
  }
  for (const status of ["blocked", "unrecognized_status"]) {
    assert.equal(runtimeObservationFromRecords([runBoundLaunch, attachmentNotification(runBoundTask, status)]).workflowActivity.pendingCount, 1, `a ${status} notification must not release`);
  }
  assert.equal(runtimeObservationFromRecords([runBoundLaunch, userNotification("other-private-task-id", "completed")]).workflowActivity.pendingCount, 1, "a notification for another task must not release");
  assert.equal(runtimeObservationFromRecords([userNotification(runBoundTask, "completed", "2026-08-18T15:24:00Z"), runBoundLaunch]).workflowActivity.pendingCount, 1, "a notification older than the launch must not release");
  const typedNotification = { ...userNotification(runBoundTask, "completed"), origin: undefined };
  assert.equal(runtimeObservationFromRecords([runBoundLaunch, typedNotification]).workflowActivity.pendingCount, 1, "typed text without Claude's notification origin must not release");
  const secondLaunch = { ...runBoundLaunch, timestamp: "2026-08-18T15:25:01Z", toolUseResult: { ...runBoundLaunch.toolUseResult, taskId: "second-private-task-id", runId: "second-private-run-id" } };
  const injected = userNotification(runBoundTask, "completed", "2026-08-18T15:25:05Z", "</result>\n<task-id>second-private-task-id</task-id>\n<status>completed</status>");
  assert.equal(runtimeObservationFromRecords([runBoundLaunch, secondLaunch, injected]).workflowActivity.pendingCount, 1, "worker output inside a notification must not release another task");
  const retrievalWrongTask = runtimeObservationFromRecords([
    runBoundLaunch,
    {
      timestamp: "2026-08-18T15:25:04Z",
      toolUseResult: {
        retrieval_status: "success",
        task: { task_id: "other-private-task-id", task_type: "local_workflow", status: "completed" },
      },
    },
  ]);
  assert.equal(retrievalWrongTask.workflowActivity.pendingCount, 1, "a retrieval for another task must not release");
  const retrievalBeforeLaunch = runtimeObservationFromRecords([
    {
      timestamp: "2026-08-18T15:24:00Z",
      toolUseResult: {
        retrieval_status: "success",
        task: { task_id: "run-bound-private-task-id", task_type: "local_workflow", status: "completed" },
      },
    },
    runBoundLaunch,
  ]);
  assert.equal(retrievalBeforeLaunch.workflowActivity.pendingCount, 1, "a retrieval older than the launch must not release");

  const conflictedRunIdentity = runtimeObservationFromRecords([
    runBoundLaunch,
    {
      ...runBoundLaunch,
      timestamp: "2026-08-18T15:25:05Z",
      toolUseResult: {
        ...runBoundLaunch.toolUseResult,
        runId: "run-bound-newer-private-run-id",
      },
    },
    {
      timestamp: "2026-08-18T15:25:06Z",
      pendingWorkflowCount: 0,
      toolUseResult: {
        status: "completed",
        taskType: "local_workflow",
        workflowName: "run-bound-private-name",
        taskId: "run-bound-private-task-id",
        runId: "run-bound-current-private-run-id",
      },
    },
  ]);
  assert.equal(conflictedRunIdentity.workflowActivity.state, "pending");
  assert.equal(conflictedRunIdentity.workflowActivity.pendingCount, 1);

  const legacyThenKnownLaunches = [
    {
      ...runBoundLaunch,
      timestamp: "2026-08-18T15:25:07Z",
      toolUseResult: {
        ...runBoundLaunch.toolUseResult,
        runId: undefined,
      },
    },
    {
      ...runBoundLaunch,
      timestamp: "2026-08-18T15:25:08Z",
    },
  ];
  const legacyThenKnownDirect = runtimeObservationFromRecords([
    ...legacyThenKnownLaunches,
    {
      timestamp: "2026-08-18T15:25:09Z",
      pendingWorkflowCount: 0,
      toolUseResult: {
        status: "completed",
        taskType: "local_workflow",
        workflowName: "run-bound-private-name",
        taskId: "run-bound-private-task-id",
        runId: "run-bound-current-private-run-id",
      },
    },
  ]);
  assert.equal(legacyThenKnownDirect.workflowActivity.state, "pending");
  assert.equal(legacyThenKnownDirect.workflowActivity.pendingCount, 1);
  const legacyThenKnownRetrieval = runtimeObservationFromRecords([
    ...legacyThenKnownLaunches,
    {
      timestamp: "2026-08-18T15:25:10Z",
      pendingWorkflowCount: 0,
      toolUseResult: {
        retrieval_status: "success",
        task: {
          task_id: "run-bound-private-task-id",
          run_id: "run-bound-current-private-run-id",
          status: "completed",
        },
      },
    },
  ]);
  assert.equal(legacyThenKnownRetrieval.workflowActivity.state, "pending");
  assert.equal(legacyThenKnownRetrieval.workflowActivity.pendingCount, 1);

  const invalidTimestampRunIdentity = {
    ...runBoundLaunch,
    timestamp: "invalid-private-timestamp",
  };
  const invalidTimestampDirectMissing = runtimeObservationFromRecords([
    invalidTimestampRunIdentity,
    {
      timestamp: "2026-08-18T15:25:07Z",
      pendingWorkflowCount: 0,
      toolUseResult: {
        status: "completed",
        taskType: "local_workflow",
        workflowName: "run-bound-private-name",
        taskId: "run-bound-private-task-id",
      },
    },
  ]);
  assert.equal(invalidTimestampDirectMissing.workflowActivity.state, "pending");
  assert.equal(invalidTimestampDirectMissing.workflowActivity.pendingCount, 1);
  const invalidTimestampRetrievalMismatch = runtimeObservationFromRecords([
    invalidTimestampRunIdentity,
    {
      timestamp: "2026-08-18T15:25:08Z",
      pendingWorkflowCount: 0,
      toolUseResult: {
        retrieval_status: "success",
        task: {
          task_id: "run-bound-private-task-id",
          run_id: "run-bound-stale-private-run-id",
          status: "completed",
        },
      },
    },
  ]);
  assert.equal(
    invalidTimestampRetrievalMismatch.workflowActivity.state,
    "pending"
  );
  assert.equal(
    invalidTimestampRetrievalMismatch.workflowActivity.pendingCount,
    1
  );

  const overflowRunLaunches = Array.from({ length: 33 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 7, 18, 15, 26, index)).toISOString(),
    toolUseResult: {
      status: "async_launched",
      taskType: "local_workflow",
      workflowName: `overflow-private-name-${index}`,
      taskId: `overflow-private-task-${index}`,
      runId: `overflow-private-run-${index}`,
    },
  }));
  const overflowDirectMissing = runtimeObservationFromRecords([
    ...overflowRunLaunches,
    {
      timestamp: "2026-08-18T15:27:00Z",
      pendingWorkflowCount: 0,
      toolUseResult: {
        status: "completed",
        taskType: "local_workflow",
        workflowName: "overflow-private-name-32",
        taskId: "overflow-private-task-32",
      },
    },
  ]);
  assert.equal(overflowDirectMissing.workflowActivity.state, "pending");
  assert.equal(overflowDirectMissing.workflowActivity.pendingCount, 33);
  const overflowRetrievalMismatch = runtimeObservationFromRecords([
    ...overflowRunLaunches,
    {
      timestamp: "2026-08-18T15:27:01Z",
      pendingWorkflowCount: 0,
      toolUseResult: {
        retrieval_status: "success",
        task: {
          task_id: "overflow-private-task-32",
          run_id: "overflow-private-stale-run-32",
          status: "completed",
        },
      },
    },
  ]);
  assert.equal(overflowRetrievalMismatch.workflowActivity.state, "pending");
  assert.equal(overflowRetrievalMismatch.workflowActivity.pendingCount, 33);

  const directRunMatch = runtimeObservationFromRecords([
    runBoundLaunch,
    {
      timestamp: "2026-08-18T15:28:00Z",
      toolUseResult: {
        status: "completed",
        taskType: "local_workflow",
        workflowName: "run-bound-private-name",
        taskId: "run-bound-private-task-id",
        runId: "run-bound-current-private-run-id",
      },
    },
  ]);
  assert.equal(directRunMatch.workflowActivity.pendingCount, 0);

  const retrievalRunMatch = runtimeObservationFromRecords([
    runBoundLaunch,
    {
      timestamp: "2026-08-18T15:28:01Z",
      toolUseResult: {
        retrieval_status: "success",
        task: {
          task_id: "run-bound-private-task-id",
          run_id: "run-bound-current-private-run-id",
          status: "completed",
        },
      },
    },
  ]);
  assert.equal(retrievalRunMatch.workflowActivity.pendingCount, 0);

  // A task ID by itself is not a generation identity. A delayed task-only
  // terminal row must not complete a newer run that reuses the same task ID.
  const runlessTaskReuse = runtimeObservationFromRecords([
    {
      timestamp: "2026-08-18T15:28:10Z",
      toolUseResult: {
        status: "async_launched",
        taskType: "local_workflow",
        workflowName: "runless-reuse-private-workflow",
        taskId: "runless-reuse-private-task",
      },
    },
    {
      timestamp: "2026-08-18T15:28:11Z",
      toolUseResult: {
        status: "async_launched",
        taskType: "local_workflow",
        workflowName: "runless-reuse-private-workflow",
        taskId: "runless-reuse-private-task",
      },
    },
    {
      timestamp: "2026-08-18T15:28:12Z",
      toolUseResult: {
        status: "completed",
        taskType: "local_workflow",
        workflowName: "runless-reuse-private-workflow",
        taskId: "runless-reuse-private-task",
      },
    },
  ]);
  assert.equal(runlessTaskReuse.workflowActivity.state, "pending");
  assert.equal(runlessTaskReuse.workflowActivity.pendingCount, 1);

  // Matching task/run fields still cannot release a workflow whose launch
  // ordering is absent or lies in the future.
  const invalidLaunchMatchingTerminal = runtimeObservationFromRecords([
    invalidTimestampRunIdentity,
    {
      timestamp: "2026-08-18T15:28:13Z",
      toolUseResult: {
        status: "completed",
        taskType: "local_workflow",
        workflowName: "run-bound-private-name",
        taskId: "run-bound-private-task-id",
        runId: "run-bound-current-private-run-id",
      },
    },
  ]);
  assert.equal(invalidLaunchMatchingTerminal.workflowActivity.pendingCount, 1);
  const unorderedMatchingTerminal = runtimeObservationFromRecords([
    runBoundLaunch,
    {
      timestamp: "2026-08-18T15:24:59Z",
      toolUseResult: {
        status: "completed",
        taskType: "local_workflow",
        workflowName: "run-bound-private-name",
        taskId: "run-bound-private-task-id",
        runId: "run-bound-current-private-run-id",
      },
    },
  ]);
  assert.equal(unorderedMatchingTerminal.workflowActivity.pendingCount, 1);
  const futureLaunchTimestamp = new Date(Date.now() + 60_000).toISOString();
  const futureLaunchMatchingRetrieval = runtimeObservationFromRecords([
    {
      ...runBoundLaunch,
      timestamp: futureLaunchTimestamp,
    },
    {
      timestamp: new Date().toISOString(),
      toolUseResult: {
        retrieval_status: "success",
        task: {
          task_id: "run-bound-private-task-id",
          run_id: "run-bound-current-private-run-id",
          status: "completed",
        },
      },
    },
  ]);
  assert.equal(futureLaunchMatchingRetrieval.workflowActivity.pendingCount, 1);
  const generationStartMs = Date.parse("2026-08-18T15:28:15Z");
  const preGenerationLaunch = runtimeObservationFromRecords(
    [
      {
        ...runBoundLaunch,
        timestamp: "2026-08-18T15:28:14.999Z",
      },
      {
        timestamp: "2026-08-18T15:28:15.001Z",
        toolUseResult: {
          retrieval_status: "success",
          task: {
            task_id: "run-bound-private-task-id",
            run_id: "run-bound-current-private-run-id",
            status: "completed",
          },
        },
      },
    ],
    { startedAtMs: generationStartMs }
  );
  assert.equal(preGenerationLaunch.workflowActivity.launchObserved, false);
  assert.equal(preGenerationLaunch.workflowActivity.pendingCount, null);

  // Aggregate counters carry no per-workflow identity. They may observe a
  // smaller number, but cannot clear either identity-bound peer on their own.
  const counterOnlyShrink = runtimeObservationFromRecords([
    {
      timestamp: "2026-08-18T15:28:20Z",
      toolUseResult: {
        status: "async_launched",
        taskType: "local_workflow",
        workflowName: "counter-peer-a-private-workflow",
        taskId: "counter-peer-a-private-task",
        runId: "counter-peer-a-private-run",
      },
    },
    {
      timestamp: "2026-08-18T15:28:21Z",
      toolUseResult: {
        status: "async_launched",
        taskType: "local_workflow",
        workflowName: "counter-peer-b-private-workflow",
        taskId: "counter-peer-b-private-task",
        runId: "counter-peer-b-private-run",
      },
    },
    { timestamp: "2026-08-18T15:28:22Z", pendingWorkflowCount: 1 },
    { timestamp: "2026-08-18T15:28:23Z", pendingWorkflowCount: 0 },
  ]);
  assert.equal(counterOnlyShrink.workflowActivity.state, "pending");
  assert.equal(counterOnlyShrink.workflowActivity.pendingCount, 2);
  for (const observation of [
    directRunMismatch,
    directRunMissing,
    retrievalRunMismatch,
    retrievalRunMissing,
    conflictedRunIdentity,
    legacyThenKnownDirect,
    legacyThenKnownRetrieval,
    invalidTimestampDirectMissing,
    invalidTimestampRetrievalMismatch,
    directRunMatch,
    retrievalRunMatch,
    runlessTaskReuse,
    invalidLaunchMatchingTerminal,
    unorderedMatchingTerminal,
    futureLaunchMatchingRetrieval,
    preGenerationLaunch,
    counterOnlyShrink,
  ]) {
    assert.doesNotMatch(
      JSON.stringify(observation),
      /run-bound-private-name|run-bound-private-task-id|run-bound-current-private-run-id|run-bound-stale-private-run-id|run-bound-newer-private-run-id|runless-reuse-private|counter-peer-[ab]-private/
    );
  }
  for (const observation of [
    overflowDirectMissing,
    overflowRetrievalMismatch,
  ]) {
    assert.doesNotMatch(
      JSON.stringify(observation),
      /overflow-private-name|overflow-private-task|overflow-private-run|overflow-private-stale-run/
    );
  }

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
  assert.equal(boundedGap.workflowActivity.state, "pending");
  assert.equal(boundedGap.workflowActivity.pendingCount, 1);
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
    "2026-08-18T15:30:20Z"
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

  // This synthetic missing structured-completion shape uses the aggregate
  // snapshot corroborated on 2.1.275 and inspected in the 2.1.276 writer.
  // Worker rows and end_turn remain insufficient; the current-generation,
  // identity-bound completed snapshot is the only added release evidence.
  const bindSnapshotLog = (metadata, file) => {
    const stat = fs.statSync(file);
    metadata.snapshotIdentityBinding = {
      mode: "fresh",
      generationId: metadata.generationId,
      startedAtMs: metadata.startedAtMs,
      resolvedSessionId: metadata.resolvedSessionId,
      logFileIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
    };
  };
  const freshProofId = "90909090-9090-4090-8090-909090909090";
  const freshProofFile = path.join(projectDirectory, `${freshProofId}.jsonl`);
  const freshProofStart = Date.now() - 1000;
  fs.writeFileSync(freshProofFile, jsonl([{ sessionId: freshProofId, type: "system" }]), "utf8");
  const freshProofInput = {
    sessionId: freshProofId,
    startedAtMs: freshProofStart,
    beforeSessionIds: [],
    logFile: freshProofFile,
  };
  const freshProofIdentity = await freshWorkflowSnapshotLogIdentity(cwd, freshProofInput);
  assert.equal(typeof freshProofIdentity, "string");
  assert.equal(await freshWorkflowSnapshotLogIdentity(cwd, {
    ...freshProofInput,
    beforeSessionIds: [freshProofId],
  }), null, "a preexisting conversation cannot gain a fresh snapshot binding");
  assert.equal(await freshWorkflowSnapshotLogIdentity(cwd, {
    ...freshProofInput,
    startedAtMs: Date.now() + 10_000,
  }), null, "an old log cannot gain a later launch binding");
  fs.writeFileSync(freshProofFile, jsonl([{ sessionId: "other-conversation" }]), "utf8");
  assert.equal(await freshWorkflowSnapshotLogIdentity(cwd, freshProofInput), null);
  fs.writeFileSync(freshProofFile, jsonl([
    { sessionId: freshProofId },
    { sessionId: "other-conversation" },
  ]), "utf8");
  assert.equal(await freshWorkflowSnapshotLogIdentity(cwd, freshProofInput), null);
  fs.writeFileSync(freshProofFile, "{invalid}\n", "utf8");
  assert.equal(await freshWorkflowSnapshotLogIdentity(cwd, freshProofInput), null);
  const snapshotSessionId = "96969696-9696-4696-8696-969696969696";
  const snapshotBase = { sessionId: snapshotSessionId };
  const snapshotMetadata = { cwd, resolvedSessionId: snapshotSessionId, startedAtMs, generationId: "snapshot-generation" };
  const snapshotLogFile = path.join(projectDirectory, `${snapshotSessionId}.jsonl`);
  const snapshotDirectory = path.join(projectDirectory, snapshotSessionId, "workflows");
  const snapshotLaunch = (taskId, runId, timestamp) => ({
    ...snapshotBase,
    timestamp,
    toolUseResult: {
      status: "async_launched",
      taskType: "local_workflow",
      workflowName: "snapshot-private-workflow",
      taskId,
      runId,
    },
  });
  const snapshotBody = (taskId, runId, startTime, timestamp) => ({
    status: "completed", taskId, runId, startTime: Date.parse(startTime), timestamp,
  });
  fs.writeFileSync(snapshotLogFile, jsonl([
    snapshotLaunch("snapshot-task-a", "run-a", "2026-08-18T16:20:00Z"),
    { ...snapshotBase, timestamp: "2026-08-18T16:20:01Z", pendingWorkflowCount: 1 },
    { ...snapshotBase, timestamp: "2026-08-18T16:20:02Z", type: "agent", agentId: "synthetic-worker-a", phase: "result", result: { text: "done" } },
    { ...snapshotBase, timestamp: "2026-08-18T16:20:03Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "workers complete" }] } },
  ]), "utf8");
  bindSnapshotLog(snapshotMetadata, snapshotLogFile);
  assert.equal((await sessionRuntimeObservation(snapshotMetadata)).workflowActivity.pendingCount, 1);
  fs.mkdirSync(snapshotDirectory, { recursive: true });
  const snapshotStartedAt = "2026-08-18T16:20:00.500Z";
  const numericSnapshotCompletedAt = Date.parse("2026-08-18T16:20:02Z");
  fs.writeFileSync(path.join(snapshotDirectory, "run-a.json"), JSON.stringify(
    snapshotBody("snapshot-task-a", "run-a", snapshotStartedAt, numericSnapshotCompletedAt)
  ), "utf8");
  assert.equal((await sessionRuntimeObservation({ ...snapshotMetadata, generationId: "" })).workflowActivity.pendingCount, 1);
  assert.equal((await sessionRuntimeObservation({
    ...snapshotMetadata,
    snapshotIdentityBinding: null,
  })).workflowActivity.pendingCount, 1, "an unverified fresh conversation cannot release a snapshot");
  assert.equal((await sessionRuntimeObservation({
    ...snapshotMetadata,
    snapshotIdentityBinding: {
      ...snapshotMetadata.snapshotIdentityBinding,
      logFileIdentity: "different-log-file",
    },
  })).workflowActivity.pendingCount, 1, "a substituted log cannot release a snapshot");
  const snapshotCompleted = await sessionRuntimeObservation(snapshotMetadata);
  assert.equal(snapshotCompleted.workflowActivity.pendingCount, 0);
  assert.equal(snapshotCompleted.workflowActivity.completionEvidence, "claude_workflow_snapshot");
  assert.equal(snapshotCompleted.workflowActivity.completedSnapshotCount, 1);
  assert.equal(snapshotCompleted.workflowActivity.lastObservedAt, "2026-08-18T16:20:02.000Z");
  assert.equal(snapshotCompleted.workflowActivity.pendingObservedAt, "2026-08-18T16:20:02.000Z");
  const replacementGenerationCompletion = await sessionRuntimeObservation({
    ...snapshotMetadata,
    generationId: "replacement-snapshot-generation",
  });
  assert.equal(
    replacementGenerationCompletion.workflowActivity.pendingCount,
    1,
    "a snapshot from a different managed generation must not release pending work"
  );
  fs.unlinkSync(path.join(snapshotDirectory, "run-a.json"));
  assert.equal((await sessionRuntimeObservation(snapshotMetadata)).workflowActivity.pendingCount, 1);
  fs.writeFileSync(path.join(snapshotDirectory, "run-a.json"), JSON.stringify(
    snapshotBody("snapshot-task-a", "run-a", snapshotStartedAt, "2026-08-18T16:20:02Z")
  ), "utf8");
  const stringSnapshotCompleted = await sessionRuntimeObservation(snapshotMetadata);
  assert.equal(stringSnapshotCompleted.workflowActivity.pendingCount, 0);
  assert.equal(
    stringSnapshotCompleted.workflowActivity.lastObservedAt,
    "2026-08-18T16:20:02.000Z"
  );
  assert.equal(
    stringSnapshotCompleted.workflowActivity.pendingObservedAt,
    "2026-08-18T16:20:02.000Z"
  );
  assert.equal(
    stringSnapshotCompleted.workflowActivity.lastObservedAt,
    snapshotCompleted.workflowActivity.lastObservedAt,
    "numeric and string completion timestamps must reach the same canonical ISO observation"
  );
  assert.equal(
    stringSnapshotCompleted.workflowActivity.pendingObservedAt,
    snapshotCompleted.workflowActivity.pendingObservedAt,
    "numeric and string completion timestamps must reach the same canonical ISO pending observation"
  );

  const snapshotStatusRecord = (sessionId, status, taskId, runId, timestamp) => ({
    sessionId,
    timestamp,
    toolUseResult: {
      status,
      taskType: "local_workflow",
      workflowName: "snapshot-status-workflow",
      taskId,
      runId,
    },
  });
  const observeSnapshotStatusSequence = async (
    sessionId,
    records,
    { taskId, runId, startTime, completedAt }
  ) => {
    const metadata = {
      cwd,
      resolvedSessionId: sessionId,
      startedAtMs,
      generationId: `snapshot-status-${sessionId}`,
    };
    const logFile = path.join(projectDirectory, `${sessionId}.jsonl`);
    fs.writeFileSync(logFile, jsonl(records), "utf8");
    bindSnapshotLog(metadata, logFile);
    const directory = path.join(projectDirectory, sessionId, "workflows");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `${runId}.json`),
      JSON.stringify(snapshotBody(taskId, runId, startTime, completedAt)),
      "utf8"
    );
    return sessionRuntimeObservation(metadata);
  };
  const sameRunStatusSessionId = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
  const sameRunStatusTaskId = "same-run-status-task";
  const sameRunStatusRunId = "same-run-status-run";
  const sameRunStatusCompletion = await observeSnapshotStatusSequence(
    sameRunStatusSessionId,
    [
      snapshotStatusRecord(sameRunStatusSessionId, "async_launched", sameRunStatusTaskId, sameRunStatusRunId, "2026-08-18T16:22:00Z"),
      snapshotStatusRecord(sameRunStatusSessionId, "launched", sameRunStatusTaskId, sameRunStatusRunId, "2026-08-18T16:22:01Z"),
      snapshotStatusRecord(sameRunStatusSessionId, "running", sameRunStatusTaskId, sameRunStatusRunId, "2026-08-18T16:22:02Z"),
      { sessionId: sameRunStatusSessionId, timestamp: "2026-08-18T16:22:03Z", pendingWorkflowCount: 1 },
    ],
    {
      taskId: sameRunStatusTaskId,
      runId: sameRunStatusRunId,
      startTime: "2026-08-18T16:22:00.500Z",
      completedAt: "2026-08-18T16:22:04Z",
    }
  );
  assert.equal(sameRunStatusCompletion.workflowActivity.pendingCount, 0);
  assert.equal(sameRunStatusCompletion.workflowActivity.completedSnapshotCount, 1);
  assert.equal(sameRunStatusCompletion.workflowActivity.completionEvidence, "claude_workflow_snapshot");

  const noAsyncSessionId = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
  const noAsyncTaskId = "no-async-task";
  const noAsyncRunId = "no-async-run";
  const noAsyncSnapshot = await observeSnapshotStatusSequence(
    noAsyncSessionId,
    [
      snapshotStatusRecord(noAsyncSessionId, "launched", noAsyncTaskId, noAsyncRunId, "2026-08-18T16:23:00Z"),
      snapshotStatusRecord(noAsyncSessionId, "running", noAsyncTaskId, noAsyncRunId, "2026-08-18T16:23:01Z"),
      { sessionId: noAsyncSessionId, timestamp: "2026-08-18T16:23:02Z", pendingWorkflowCount: 1 },
    ],
    {
      taskId: noAsyncTaskId,
      runId: noAsyncRunId,
      startTime: "2026-08-18T16:23:00.500Z",
      completedAt: "2026-08-18T16:23:03Z",
    }
  );
  assert.equal(noAsyncSnapshot.workflowActivity.pendingCount, 1);
  assert.equal(noAsyncSnapshot.workflowActivity.completedSnapshotCount, 0);

  const conflictingAsyncSessionId = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
  const conflictingAsyncTaskId = "conflicting-async-task";
  const conflictingAsyncRunId = "conflicting-async-run-b";
  const conflictingAsyncSnapshot = await observeSnapshotStatusSequence(
    conflictingAsyncSessionId,
    [
      snapshotStatusRecord(conflictingAsyncSessionId, "async_launched", conflictingAsyncTaskId, "conflicting-async-run-a", "2026-08-18T16:24:00Z"),
      snapshotStatusRecord(conflictingAsyncSessionId, "async_launched", conflictingAsyncTaskId, conflictingAsyncRunId, "2026-08-18T16:24:01Z"),
      { sessionId: conflictingAsyncSessionId, timestamp: "2026-08-18T16:24:02Z", pendingWorkflowCount: 1 },
    ],
    {
      taskId: conflictingAsyncTaskId,
      runId: conflictingAsyncRunId,
      startTime: "2026-08-18T16:24:01.500Z",
      completedAt: "2026-08-18T16:24:03Z",
    }
  );
  assert.equal(conflictingAsyncSnapshot.workflowActivity.pendingCount, 1);
  assert.equal(conflictingAsyncSnapshot.workflowActivity.completedSnapshotCount, 0);

  const reusedSnapshotSessionId = "91919191-9191-4919-8919-919191919191";
  const reusedSnapshotBase = { sessionId: reusedSnapshotSessionId };
  const reusedSnapshotMetadata = {
    cwd,
    resolvedSessionId: reusedSnapshotSessionId,
    startedAtMs,
    generationId: "reused-snapshot-generation",
  };
  const reusedSnapshotDirectory = path.join(
    projectDirectory,
    reusedSnapshotSessionId,
    "workflows"
  );
  fs.writeFileSync(
    path.join(projectDirectory, `${reusedSnapshotSessionId}.jsonl`),
    jsonl([
      {
        ...reusedSnapshotBase,
        timestamp: "2026-08-18T16:25:00Z",
        toolUseResult: {
          status: "async_launched",
          taskType: "local_workflow",
          workflowName: "reused-snapshot-private-workflow",
          taskId: "reused-snapshot-private-task",
        },
      },
      {
        ...reusedSnapshotBase,
        timestamp: "2026-08-18T16:25:01Z",
        toolUseResult: {
          status: "async_launched",
          taskType: "local_workflow",
          workflowName: "reused-snapshot-private-workflow",
          taskId: "reused-snapshot-private-task",
          runId: "reused-snapshot-private-run",
        },
      },
    ]),
    "utf8"
  );
  bindSnapshotLog(
    reusedSnapshotMetadata,
    path.join(projectDirectory, `${reusedSnapshotSessionId}.jsonl`)
  );
  fs.mkdirSync(reusedSnapshotDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(reusedSnapshotDirectory, "reused-snapshot-private-run.json"),
    JSON.stringify(
      snapshotBody(
        "reused-snapshot-private-task",
        "reused-snapshot-private-run",
        "2026-08-18T16:25:01.500Z",
        "2026-08-18T16:25:02Z"
      )
    ),
    "utf8"
  );
  const reusedSnapshotPending = await sessionRuntimeObservation(
    reusedSnapshotMetadata
  );
  assert.equal(reusedSnapshotPending.workflowActivity.state, "pending");
  assert.equal(reusedSnapshotPending.workflowActivity.pendingCount, 1);
  assert.equal(reusedSnapshotPending.workflowActivity.completedSnapshotCount, 0);
  assert.doesNotMatch(
    JSON.stringify(reusedSnapshotPending),
    /reused-snapshot-private/
  );

  // A snapshot file created before a replacement managed generation is not
  // generation evidence, even if its contents later claim current task/run
  // timestamps. File creation time is immutable provenance for this path.
  const carriedSnapshotSessionId = "92929292-9292-4929-8929-929292929292";
  const carriedSnapshotRunId = "carried-snapshot-run";
  const carriedSnapshotTaskId = "carried-snapshot-task";
  const carriedSnapshotDirectory = path.join(
    projectDirectory,
    carriedSnapshotSessionId,
    "workflows"
  );
  fs.mkdirSync(carriedSnapshotDirectory, { recursive: true });
  const carriedSnapshotFile = path.join(
    carriedSnapshotDirectory,
    `${carriedSnapshotRunId}.json`
  );
  fs.writeFileSync(carriedSnapshotFile, "{}", "utf8");
  const carriedSnapshotBirthtimeMs = fs.statSync(carriedSnapshotFile).birthtimeMs;
  const replacementGenerationStartedAtMs = Math.ceil(carriedSnapshotBirthtimeMs) + 1;
  while (Date.now() <= replacementGenerationStartedAtMs + 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const replacementSnapshotStart = new Date(
    replacementGenerationStartedAtMs + 1
  ).toISOString();
  const replacementSnapshotCompleted = new Date(
    replacementGenerationStartedAtMs + 2
  ).toISOString();
  fs.writeFileSync(
    carriedSnapshotFile,
    JSON.stringify(
      snapshotBody(
        carriedSnapshotTaskId,
        carriedSnapshotRunId,
        replacementSnapshotStart,
        replacementSnapshotCompleted
      )
    ),
    "utf8"
  );
  assert.ok(
    fs.statSync(carriedSnapshotFile).birthtimeMs < replacementGenerationStartedAtMs
  );
  fs.writeFileSync(
    path.join(projectDirectory, `${carriedSnapshotSessionId}.jsonl`),
    jsonl([
      {
        sessionId: carriedSnapshotSessionId,
        timestamp: replacementSnapshotStart,
        toolUseResult: {
          status: "async_launched",
          taskType: "local_workflow",
          workflowName: "carried-snapshot-private-workflow",
          taskId: carriedSnapshotTaskId,
          runId: carriedSnapshotRunId,
        },
      },
    ]),
    "utf8"
  );
  const carriedSnapshotMetadata = {
    cwd,
    resolvedSessionId: carriedSnapshotSessionId,
    startedAtMs: replacementGenerationStartedAtMs,
    generationId: "replacement-generation",
  };
  bindSnapshotLog(carriedSnapshotMetadata, path.join(projectDirectory, `${carriedSnapshotSessionId}.jsonl`));
  const carriedSnapshotPending = await sessionRuntimeObservation(carriedSnapshotMetadata);
  assert.equal(carriedSnapshotPending.workflowActivity.state, "pending");
  assert.equal(carriedSnapshotPending.workflowActivity.pendingCount, 1);
  assert.equal(carriedSnapshotPending.workflowActivity.completedSnapshotCount, 0);

  const historicalGeneration = await sessionRuntimeObservation({
    ...snapshotMetadata,
    generationId: "historical-generation",
    startedAtMs: Date.parse("2026-08-18T17:00:00Z"),
  });
  assert.equal(historicalGeneration.workflowActivity.launchObserved, false);

  // Replacing the real log at the same conversation path must invalidate the
  // broker-generation binding even when the new file has identical records.
  const originalSnapshotLogFile = `${snapshotLogFile}.original`;
  fs.renameSync(snapshotLogFile, originalSnapshotLogFile);
  fs.writeFileSync(
    snapshotLogFile,
    fs.readFileSync(originalSnapshotLogFile),
  );
  const replacementStat = fs.statSync(snapshotLogFile);
  const replacementIdentity = `${replacementStat.dev}:${replacementStat.ino}:${replacementStat.birthtimeMs}`;
  assert.notEqual(replacementIdentity, snapshotMetadata.snapshotIdentityBinding.logFileIdentity);
  const replacedLogObservation = await sessionRuntimeObservation(snapshotMetadata);
  assert.equal(replacedLogObservation.workflowActivity.pendingCount, 1);
  assert.equal(replacedLogObservation.workflowActivity.completedSnapshotCount, 0);

  const peerSessionId = "97979797-9797-4797-8797-979797979797";
  const peerBase = { sessionId: peerSessionId };
  const peerMetadata = { cwd, resolvedSessionId: peerSessionId, startedAtMs, generationId: "peer-generation" };
  const peerLogFile = path.join(projectDirectory, `${peerSessionId}.jsonl`);
  const peerDirectory = path.join(projectDirectory, peerSessionId, "workflows");
  const peerRecord = (record) => ({ ...record, sessionId: peerSessionId });
  fs.writeFileSync(peerLogFile, jsonl([
    peerRecord(snapshotLaunch("peer-task-a", "peer-run-a", "2026-08-18T16:30:00Z")),
    peerRecord(snapshotLaunch("peer-task-b", "peer-run-b", "2026-08-18T16:30:01Z")),
    { sessionId: peerSessionId, timestamp: "2026-08-18T16:30:02Z", toolUseResult: {
      status: "async_launched", taskType: "local_workflow", workflowName: "unidentified-peer-workflow",
    } },
    { sessionId: peerSessionId, timestamp: "2026-08-18T16:30:03Z", pendingWorkflowCount: 3 },
  ]), "utf8");
  bindSnapshotLog(peerMetadata, peerLogFile);
  fs.mkdirSync(peerDirectory, { recursive: true });
  fs.writeFileSync(path.join(peerDirectory, "peer-run-a.json"), JSON.stringify(
    snapshotBody("peer-task-a", "peer-run-a", "2026-08-18T16:30:00Z", "2026-08-18T16:30:04Z")
  ), "utf8");
  assert.equal((await sessionRuntimeObservation(peerMetadata)).workflowActivity.pendingCount, 2);
  fs.appendFileSync(peerLogFile, jsonl([
    peerRecord(snapshotLaunch("peer-task-c", "peer-run-c", "2026-08-18T16:30:05Z")),
  ]), "utf8");
  assert.equal((await sessionRuntimeObservation(peerMetadata)).workflowActivity.pendingCount, 3);

  const orderedPeerSessionId = "94949494-9494-4949-8994-949494949494";
  const orderedPeerMetadata = {
    cwd,
    resolvedSessionId: orderedPeerSessionId,
    startedAtMs,
    generationId: "ordered-peer-generation",
  };
  const orderedPeerLogFile = path.join(projectDirectory, `${orderedPeerSessionId}.jsonl`);
  const orderedPeerDirectory = path.join(projectDirectory, orderedPeerSessionId, "workflows");
  const orderedPeerRecord = (record) => ({ ...record, sessionId: orderedPeerSessionId });
  fs.writeFileSync(orderedPeerLogFile, jsonl([
    orderedPeerRecord(snapshotLaunch("ordered-task-a", "ordered-run-a", "2026-08-18T16:35:00Z")),
    orderedPeerRecord(snapshotLaunch("ordered-task-b", "ordered-run-b", "2026-08-18T16:35:03Z")),
  ]), "utf8");
  bindSnapshotLog(orderedPeerMetadata, orderedPeerLogFile);
  fs.mkdirSync(orderedPeerDirectory, { recursive: true });
  fs.writeFileSync(path.join(orderedPeerDirectory, "ordered-run-a.json"), JSON.stringify(
    snapshotBody("ordered-task-a", "ordered-run-a", "2026-08-18T16:35:00Z", "2026-08-18T16:35:02Z")
  ), "utf8");
  const orderedPeerPending = await sessionRuntimeObservation(orderedPeerMetadata);
  assert.equal(orderedPeerPending.workflowActivity.pendingCount, 1);
  assert.equal(orderedPeerPending.workflowActivity.lastObservedAt, "2026-08-18T16:35:03Z");
  assert.equal(orderedPeerPending.workflowActivity.pendingObservedAt, "2026-08-18T16:35:03Z");
  fs.writeFileSync(path.join(orderedPeerDirectory, "ordered-run-b.json"), JSON.stringify(
    snapshotBody("ordered-task-b", "ordered-run-b", "2026-08-18T16:35:03Z", "2026-08-18T16:35:04Z")
  ), "utf8");
  assert.equal((await sessionRuntimeObservation(orderedPeerMetadata)).workflowActivity.pendingCount, 0);

  const counterConflictSessionId = "93939393-9393-4939-8993-939393939393";
  const counterConflictMetadata = {
    cwd,
    resolvedSessionId: counterConflictSessionId,
    startedAtMs,
    generationId: "counter-conflict-generation",
  };
  const counterConflictLogFile = path.join(projectDirectory, `${counterConflictSessionId}.jsonl`);
  const counterConflictDirectory = path.join(projectDirectory, counterConflictSessionId, "workflows");
  fs.writeFileSync(counterConflictLogFile, jsonl([
    { ...snapshotLaunch("counter-task", "counter-run", "2026-08-18T16:37:00Z"), sessionId: counterConflictSessionId },
    { sessionId: counterConflictSessionId, timestamp: "2026-08-18T16:37:03Z", pendingWorkflowCount: 1 },
  ]), "utf8");
  bindSnapshotLog(counterConflictMetadata, counterConflictLogFile);
  fs.mkdirSync(counterConflictDirectory, { recursive: true });
  fs.writeFileSync(path.join(counterConflictDirectory, "counter-run.json"), JSON.stringify(
    snapshotBody("counter-task", "counter-run", "2026-08-18T16:37:00Z", "2026-08-18T16:37:02Z")
  ), "utf8");
  const counterConflict = await sessionRuntimeObservation(counterConflictMetadata);
  assert.equal(counterConflict.workflowActivity.pendingCount, 1);
  // The terminal snapshot predates the final valid pending-counter observation.
  // It must not release the workflow or move either watermark backward.
  assert.equal(
    counterConflict.workflowActivity.lastObservedAt,
    "2026-08-18T16:37:03Z"
  );
  assert.equal(
    counterConflict.workflowActivity.pendingObservedAt,
    "2026-08-18T16:37:03Z"
  );

  // Real Claude registers the run before it writes async_launched: across 115
  // local snapshots (CLI 2.1.247-2.1.288) the snapshot started 3-55 ms before
  // the launch record. These fixtures use that ordering.
  const realOrderSession = (id, generationId, records) => {
    const metadata = { cwd, resolvedSessionId: id, startedAtMs, generationId };
    const file = path.join(projectDirectory, `${id}.jsonl`);
    fs.writeFileSync(file, jsonl(records.map((record) => ({ ...record, sessionId: id }))), "utf8");
    bindSnapshotLog(metadata, file);
    const directory = path.join(projectDirectory, id, "workflows");
    fs.mkdirSync(directory, { recursive: true });
    const writeSnapshot = (taskId, runId, startTime, completedAt) =>
      fs.writeFileSync(path.join(directory, `${runId}.json`), JSON.stringify(
        snapshotBody(taskId, runId, startTime, completedAt)
      ), "utf8");
    return { metadata, file, writeSnapshot };
  };
  const realOrder = realOrderSession("92929292-9292-4929-8992-929292929292", "real-order-generation", [
    snapshotLaunch("real-task", "real-run", "2026-08-18T16:38:00.010Z"),
    { timestamp: "2026-08-18T16:38:01Z", pendingWorkflowCount: 1 },
  ]);
  realOrder.writeSnapshot("real-task", "real-run", "2026-08-18T16:38:00.000Z", "2026-08-18T16:38:05Z");
  const realOrderObservation = await sessionRuntimeObservation(realOrder.metadata);
  assert.equal(realOrderObservation.workflowActivity.pendingCount, 0, "a snapshot that starts just before its launch record must release");
  assert.equal(realOrderObservation.workflowActivity.completedSnapshotCount, 1);
  realOrder.writeSnapshot("real-task", "real-run", "2026-08-18T16:37:29.000Z", "2026-08-18T16:38:05Z");
  assert.equal((await sessionRuntimeObservation(realOrder.metadata)).workflowActivity.pendingCount, 1, "a snapshot that starts more than 30 s before its launch must not release");
  realOrder.writeSnapshot("real-task", "real-run", "2026-08-18T16:38:05.100Z", "2026-08-18T16:38:06Z");
  assert.equal((await sessionRuntimeObservation(realOrder.metadata)).workflowActivity.pendingCount, 1, "a snapshot that starts more than 5 s after its launch must not release");

  // A zero count after completion confirms rather than reopens the workflow.
  const zeroAfter = realOrderSession("91919191-9191-4919-8991-919191919191", "zero-after-generation", [
    snapshotLaunch("zero-task", "zero-run", "2026-08-18T16:39:00.020Z"),
    { timestamp: "2026-08-18T16:39:01Z", pendingWorkflowCount: 1 },
    { timestamp: "2026-08-18T16:39:09Z", pendingWorkflowCount: 0 },
  ]);
  zeroAfter.writeSnapshot("zero-task", "zero-run", "2026-08-18T16:39:00.000Z", "2026-08-18T16:39:08Z");
  assert.equal((await sessionRuntimeObservation(zeroAfter.metadata)).workflowActivity.pendingCount, 0, "a later zero count must not hold back a completed snapshot");

  // Two workflows in a row: the second workflow's own count must not reopen
  // the first, already completed workflow.
  const sequential = realOrderSession("90909091-9090-4909-8990-909090909091", "sequential-generation", [
    snapshotLaunch("first-task", "first-run", "2026-08-18T16:41:00.010Z"),
    { timestamp: "2026-08-18T16:41:01Z", pendingWorkflowCount: 1 },
    snapshotLaunch("second-task", "second-run", "2026-08-18T16:41:10.012Z"),
    { timestamp: "2026-08-18T16:41:11Z", pendingWorkflowCount: 1 },
  ]);
  sequential.writeSnapshot("first-task", "first-run", "2026-08-18T16:41:00.000Z", "2026-08-18T16:41:05Z");
  const firstDone = await sessionRuntimeObservation(sequential.metadata);
  assert.equal(firstDone.workflowActivity.pendingCount, 1, "only the second workflow remains pending");
  assert.equal(firstDone.workflowActivity.completedSnapshotCount, 1);
  sequential.writeSnapshot("second-task", "second-run", "2026-08-18T16:41:10.000Z", "2026-08-18T16:41:20Z");
  const bothDone = await sessionRuntimeObservation(sequential.metadata);
  assert.equal(bothDone.workflowActivity.pendingCount, 0, "sequential completed workflows must both release");
  assert.equal(bothDone.workflowActivity.completedSnapshotCount, 2);

  const rejectedSnapshotSessionId = "98989898-9898-4898-8898-989898989898";
  const rejectedBase = { sessionId: rejectedSnapshotSessionId };
  const rejectedMetadata = { cwd, resolvedSessionId: rejectedSnapshotSessionId, startedAtMs, generationId: "rejected-generation" };
  const rejectedLogFile = path.join(projectDirectory, `${rejectedSnapshotSessionId}.jsonl`);
  const rejectedDirectory = path.join(projectDirectory, rejectedSnapshotSessionId, "workflows");
  const rejectedRecord = (record) => ({ ...record, sessionId: rejectedSnapshotSessionId });
  fs.writeFileSync(rejectedLogFile, jsonl([
    rejectedRecord(snapshotLaunch("rejected-task", "rejected-run", "2026-08-18T16:40:00Z")),
    rejectedRecord({ ...snapshotBase, timestamp: "2026-08-18T16:40:01Z", pendingWorkflowCount: 1 }),
  ]), "utf8");
  bindSnapshotLog(rejectedMetadata, rejectedLogFile);
  fs.mkdirSync(rejectedDirectory, { recursive: true });
  const rejectedSnapshotFile = path.join(rejectedDirectory, "rejected-run.json");
  fs.writeFileSync(rejectedSnapshotFile, "{malformed", "utf8");
  assert.equal((await sessionRuntimeObservation(rejectedMetadata)).workflowActivity.pendingCount, 1);
  fs.writeFileSync(rejectedSnapshotFile, "x".repeat(128 * 1024 + 1), "utf8");
  assert.equal((await sessionRuntimeObservation(rejectedMetadata)).workflowActivity.pendingCount, 1);
  fs.writeFileSync(rejectedSnapshotFile, JSON.stringify(
    snapshotBody("wrong-task", "rejected-run", "2026-08-18T16:40:00Z", "2026-08-18T16:40:02Z")
  ), "utf8");
  assert.equal((await sessionRuntimeObservation(rejectedMetadata)).workflowActivity.pendingCount, 1);
  fs.writeFileSync(rejectedSnapshotFile, JSON.stringify(
    snapshotBody("rejected-task", "rejected-run", "2026-08-18T16:39:00Z", "2026-08-18T16:39:30Z")
  ), "utf8");
  assert.equal((await sessionRuntimeObservation(rejectedMetadata)).workflowActivity.pendingCount, 1);
  fs.writeFileSync(rejectedSnapshotFile, JSON.stringify(
    snapshotBody("rejected-task", "rejected-run", "2026-08-18T16:40:00Z", "2026-08-18T16:40:02Z")
  ), "utf8");
  assert.equal((await sessionRuntimeObservation(rejectedMetadata)).workflowActivity.pendingCount, 0);
  fs.appendFileSync(rejectedLogFile, jsonl([
    rejectedRecord(snapshotLaunch("rejected-task", "rejected-run", "2026-08-18T16:40:04Z")),
  ]), "utf8");
  assert.equal((await sessionRuntimeObservation(rejectedMetadata)).workflowActivity.pendingCount, 1);

  const missingResultSessionId = "99999999-9999-4999-8999-999999999999";
  const missingResultBase = { sessionId: missingResultSessionId };
  const missingResultMetadata = { cwd, resolvedSessionId: missingResultSessionId, startedAtMs, generationId: "error-generation" };
  const missingResultLogFile = path.join(projectDirectory, `${missingResultSessionId}.jsonl`);
  const missingResultDirectory = path.join(projectDirectory, missingResultSessionId, "workflows");
  const missingResultRecord = (record) => ({ ...record, sessionId: missingResultSessionId });
  fs.writeFileSync(missingResultLogFile, jsonl([
    missingResultRecord(snapshotLaunch("missing-result-task", "missing-result-run", "2026-08-18T16:50:00Z")),
    missingResultRecord({ ...snapshotBase, timestamp: "2026-08-18T16:50:01Z", pendingWorkflowCount: 1 }),
  ]), "utf8");
  bindSnapshotLog(missingResultMetadata, missingResultLogFile);
  fs.mkdirSync(missingResultDirectory, { recursive: true });
  fs.writeFileSync(path.join(missingResultDirectory, "missing-result-run.json"), JSON.stringify({
    ...snapshotBody("missing-result-task", "missing-result-run", "2026-08-18T16:50:00Z", "2026-08-18T16:50:02Z"),
    error: "reported",
  }
  ), "utf8");
  assert.equal((await sessionRuntimeObservation(missingResultMetadata)).workflowActivity.pendingCount, 1);

  const partialSnapshotSessionId = "91919191-9191-4919-8991-919191919191";
  const partialSnapshotMetadata = {
    cwd,
    resolvedSessionId: partialSnapshotSessionId,
    startedAtMs,
    generationId: "partial-snapshot-generation",
  };
  const partialSnapshotLogFile = path.join(projectDirectory, `${partialSnapshotSessionId}.jsonl`);
  const partialSnapshotDirectory = path.join(projectDirectory, partialSnapshotSessionId, "workflows");
  const partialSnapshotRecord = (record) => ({ ...record, sessionId: partialSnapshotSessionId });
  fs.writeFileSync(partialSnapshotLogFile, `${jsonl([
    partialSnapshotRecord(snapshotLaunch("partial-snapshot-task", "partial-snapshot-run", "2026-08-18T16:55:00Z")),
    { sessionId: partialSnapshotSessionId, timestamp: "2026-08-18T16:55:01Z", pendingWorkflowCount: 1 },
  ])}{"sessionId":`, "utf8");
  bindSnapshotLog(partialSnapshotMetadata, partialSnapshotLogFile);
  fs.mkdirSync(partialSnapshotDirectory, { recursive: true });
  fs.writeFileSync(path.join(partialSnapshotDirectory, "partial-snapshot-run.json"), JSON.stringify(
    snapshotBody("partial-snapshot-task", "partial-snapshot-run", "2026-08-18T16:55:00Z", "2026-08-18T16:55:02Z")
  ), "utf8");
  const partialSnapshot = await sessionRuntimeObservation(partialSnapshotMetadata);
  assert.equal(partialSnapshot.workflowActivity.pendingCount, null);
  assert.equal(partialSnapshot.workflowActivity.observationUncertain, true);

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

  // Complete workflow reconstruction is independent of posture/history replay.
  const recoverySession = "34343434-3434-4343-8343-343434343434";
  const recoveryFile = path.join(projectDirectory, `${recoverySession}.jsonl`);
  const recoveryMetadata = { cwd, resolvedSessionId: recoverySession, startedAtMs };
  const recoveryRecord = (record) => ({ sessionId: recoverySession, ...record });
  const recoveryLaunch = recoveryRecord({
    timestamp: "2026-08-18T18:00:02Z",
    toolUseResult: { taskType: "local_workflow", status: "async_launched",
      workflowName: "synthetic-private-workflow", taskId: "recover-task", runId: "recover-run" },
  });
  const recoveryTerminal = recoveryRecord({
    timestamp: "2026-08-18T18:00:03Z",
    toolUseResult: { taskType: "local_workflow", status: "completed",
      taskId: "recover-task", runId: "recover-run" },
  });
  const recoveryHead = recoveryRecord({ timestamp: "2026-08-18T18:00:01Z",
    type: "permission-mode", permissionMode: "bypassPermissions" });
  const recoveryFiller = (bytes) => recoveryRecord({
    timestamp: "2026-08-18T07:00:00Z", padding: "x".repeat(bytes),
  });
  const workflowConclusion = (observation) => Object.fromEntries([
    "state", "launchObserved", "launchStatus", "pendingCount", "lastKnownPendingCount",
    "pendingObservedAt", "lastObservedAt", "observationUncertain",
  ].map((key) => [key, observation.workflowActivity[key]]));

  // Exact threshold boundaries, not just approximate megabyte sizes.
  for (const extent of [2359295, 2359296, 2359297]) {
    const records = [recoveryHead, recoveryLaunch, recoveryTerminal, recoveryFiller(0)];
    records.at(-1).padding = "x".repeat(extent - Buffer.byteLength(jsonl(records)));
    fs.writeFileSync(recoveryFile, jsonl(records));
    assert.equal(fs.statSync(recoveryFile).size, extent);
    const observation = await sessionRuntimeObservation({ ...recoveryMetadata, generationId: `threshold-${extent}` });
    assert.equal(observation.workflowActivity.pendingCount, 0);
    assert.equal(observation.workflowActivity.observationUncertain, false);
    assert.equal(observation.workflowActivity.observationCoverage, extent > 2359296 ? "head_tail" : "full");
    if (extent > 2359296) {
      assert.equal(observation.permissionMode, null);
      assert.equal(observation.workflowActivity.reconstruction.status, "complete");
      assert.equal(observation.workflowActivity.reconstruction.bytesRead, extent);
    }
  }

  // Same final bytes observed incrementally and cold, including unordered time.
  fs.writeFileSync(recoveryFile, jsonl([recoveryHead, recoveryLaunch]));
  const incrementalMetadata = { ...recoveryMetadata, generationId: "incremental" };
  assert.equal((await sessionRuntimeObservation(incrementalMetadata)).workflowActivity.pendingCount, 1);
  fs.appendFileSync(recoveryFile, jsonl([recoveryFiller(2500000), recoveryTerminal]));
  const incrementalRecovery = await sessionRuntimeObservation(incrementalMetadata);
  const coldRecovery = await sessionRuntimeObservation({ ...recoveryMetadata, generationId: "cold" });
  assert.deepEqual(workflowConclusion(coldRecovery), workflowConclusion(incrementalRecovery));
  assert.equal(coldRecovery.permissionMode, null);
  assert.equal(coldRecovery.ultraEffortAttachment.historyCoverage, "partial");
  assert.equal((await sessionRuntimeObservation({ ...recoveryMetadata, generationId: "cold" }))
    .workflowActivity.reconstruction.cacheHit, true);
  const recoveredSignals = signalsWithWorkflowActivity({ state: "busy", terminalState: "idle",
    terminalBusy: false, workflowPending: true }, coldRecovery.workflowActivity);
  assert.equal(recoveredSignals.workflowPending, false, "complete identity-bound replay supersedes only the stale waiting row");
  assert.equal(lifecycleBlockReason(recoveredSignals), "");
  assert.equal(waitTurnDecision({ signals: recoveredSignals, transcript: {
    turnComplete: true, lastAssistant: { cursor: "new-complete-record" },
  } }).status, "completed");
  let recoveredWrites = 0;
  assert.equal((await runSubmitPrompt({ managedSession: "synthetic-recovery", text: "synthetic prompt", force: false }, {
    capture: async () => "> ", sendText: async () => { recoveredWrites += 1; return { bracketedPasteUsed: true }; },
    sendKey: async () => { recoveredWrites += 1; }, delay: async () => {},
    promptAcknowledged: async () => true, runtimeObservation: async () => coldRecovery,
  })).status, "submitted");
  assert.ok(recoveredWrites > 0);
  assert.equal(lifecycleBlockReason(signalsWithWorkflowActivity({ state: "approval_required",
    terminalState: "approval_required" }, coldRecovery.workflowActivity)), "approval_required");

  // An old first tail timestamp never permits skipping a hidden active launch.
  const unorderedRecords = [recoveryFiller(350000), recoveryLaunch, recoveryFiller(2200000),
    recoveryRecord({ timestamp: "2026-08-18T18:00:01Z", pendingWorkflowCount: 0 }),
    recoveryRecord({ timestamp: "2026-08-18T18:00:04Z", message: {
      role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }),
  ];
  fs.writeFileSync(recoveryFile, jsonl(unorderedRecords));
  const unordered = await sessionRuntimeObservation({ ...recoveryMetadata, generationId: "unordered" });
  assert.equal(unordered.workflowActivity.pendingCount, 1);
  assert.equal(unordered.workflowActivity.reconstruction.status, "complete");
  const pendingSignals = signalsWithWorkflowActivity({ state: "idle", terminalState: "idle" }, unordered.workflowActivity);
  assert.equal(lifecycleBlockReason(pendingSignals), "workflow_pending");
  assert.equal(waitTurnDecision({ signals: pendingSignals, transcript: { turnComplete: true } }).evidence, "workflow_pending");
  assert.equal((await runSubmitPrompt({ managedSession: "synthetic-pending", text: "must not send" }, {
    capture: async () => "> ", sendText: async () => assert.fail("active workflow must block"),
    sendKey: async () => assert.fail("active workflow must block"),
    runtimeObservation: async () => unordered,
  })).reason, "workflow_pending");

  // Bounded reader tests use only in-memory JSONL and injected reads/clock.
  const scanBytes = async (input, options = {}, readOverride = null) => {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const handle = { read: async (target, offset, length, position) => {
      if (readOverride) return readOverride(target, offset, length, position, bytes);
      const bytesRead = bytes.copy(target, offset, position, position + length);
      return { bytesRead };
    } };
    return reconstructWorkflowObservation(handle, bytes.length, recoveryMetadata, options);
  };
  const completeBytes = jsonl([recoveryLaunch, recoveryTerminal]);
  assert.equal((await scanBytes(completeBytes)).proof.status, "complete");
  assert.equal((await scanBytes(completeBytes.trimEnd())).proof.status, "complete");
  for (const [options, reason] of [
    [{ maxBytes: 1 }, "byte_limit"], [{ maxRecords: 1 }, "record_limit"],
    [{ maxRecordBytes: 1 }, "record_too_large"], [{ timeoutMs: 0 }, "deadline"],
  ]) assert.equal((await scanBytes(completeBytes, options)).proof.reason, reason);
  let clock = 0;
  assert.equal((await scanBytes(completeBytes, { now: () => clock }, async (target, offset, length, position, bytes) => {
    const bytesRead = bytes.copy(target, offset, position, position + length);
    clock = 1001;
    return { bytesRead };
  })).proof.reason, "deadline", "a read finishing beyond the deadline cannot publish proof");
  assert.equal((await scanBytes(completeBytes, {}, async () => ({ bytesRead: 0 }))).proof.reason, "short_read");
  assert.equal((await scanBytes(completeBytes, {}, async () => { throw new Error("synthetic read error"); })).proof.reason, "read_error");
  assert.equal((await scanBytes(`${jsonl([recoveryLaunch])}{bad}\n${jsonl([recoveryTerminal])}`)).proof.reason, "malformed_record");
  assert.equal((await scanBytes(`${completeBytes}{"unfinished":`)).proof.reason, "partial_record");
  assert.equal((await scanBytes(Buffer.concat([Buffer.from(completeBytes), Buffer.from([0xc3])]))).proof.reason, "invalid_encoding");
  assert.equal((await scanBytes(jsonl([{ ...recoveryLaunch, timestamp: undefined }, recoveryTerminal]))).proof.reason, "identity_ambiguous");
  assert.equal((await scanBytes(jsonl([{ ...recoveryLaunch,
    timestamp: Date.parse(recoveryLaunch.timestamp) }]))).proof.reason, "identity_ambiguous",
  "numeric timestamps cannot pass validation and then become untimestamped in the generation filter");
  assert.equal((await scanBytes(jsonl([{ ...recoveryLaunch, sessionId }, recoveryTerminal]))).proof.reason, "identity_ambiguous");
  assert.equal((await scanBytes(jsonl([{ ...recoveryLaunch, sessionId,
    timestamp: new Date(startedAtMs - 1).toISOString() }, recoveryLaunch, recoveryTerminal])))
    .state.pendingWorkflowCount, 0, "an individually parsed old foreign record is safely outside the exact run-identity cutoff");
  assert.equal((await scanBytes(jsonl([{ ...recoveryLaunch, sessionId,
    timestamp: new Date(startedAtMs).toISOString() }]))).proof.reason, "identity_ambiguous");
  assert.equal((await scanBytes(jsonl([recoveryRecord({ pendingWorkflowCount: 1,
    sessionId, timestamp: new Date(startedAtMs - 5000).toISOString() })]))).proof.reason, "identity_ambiguous",
  "counter records preserve the existing five-second attribution allowance");
  const mismatch = { ...recoveryTerminal, toolUseResult: { ...recoveryTerminal.toolUseResult, runId: "wrong-run" } };
  const mismatchState = await scanBytes(jsonl([recoveryLaunch, mismatch, recoveryRecord({
    timestamp: "2026-08-18T18:00:04Z", pendingWorkflowCount: 0,
  })]));
  assert.equal(mismatchState.state.pendingWorkflowCount, 1);
  const unicodeBytes = jsonl([{ ...recoveryLaunch, toolUseResult: {
    ...recoveryLaunch.toolUseResult, workflowName: "synthetic-\u20ac-\ud83d\ude80" } }, recoveryTerminal]);
  assert.equal((await scanBytes(unicodeBytes, {}, async (target, offset, length, position, bytes) => ({
    bytesRead: bytes.copy(target, offset, position, position + Math.min(length, 1)),
  }))).proof.status, "complete", "UTF-8 codepoints may cross read boundaries");
  let oversizedRead = false;
  assert.equal((await reconstructWorkflowObservation({ read: async () => {
    oversizedRead = true;
    assert.fail("source extent beyond cap must not be read");
  } }, 16 * 1024 * 1024 + 1, recoveryMetadata)).proof.reason, "byte_limit");
  assert.equal(oversizedRead, false);

  const irrelevantPayload = "x".repeat(800000);
  const projectionOnly = await scanBytes(jsonl([{ ...recoveryLaunch,
    type: "custom-title", customTitle: irrelevantPayload, version: "2.1.1",
    permissionMode: "bypassPermissions", url: irrelevantPayload,
    message: { role: "assistant", model: irrelevantPayload },
  }, recoveryTerminal]));
  assert.equal(projectionOnly.proof.status, "complete");
  for (const field of ["titleCandidates", "permissionMode", "model", "claudeVersion", "remoteUrl", "searchTextParts",
    "runtimeUntimestampedRecords", "ultraEffortAttachmentTransitionEvents"]) {
    assert.equal(Object.hasOwn(projectionOnly.state, field), false, `${field} must not be retained in the workflow cache projection`);
  }
  const oversizedIdentityInput = jsonl([{ ...recoveryLaunch, toolUseResult: {
    ...recoveryLaunch.toolUseResult, taskId: "t".repeat(40000), runId: "r".repeat(40000),
  } }, recoveryFiller(2500000)]);
  const oversizedIdentity = await scanBytes(oversizedIdentityInput);
  assert.equal(oversizedIdentity.proof.reason, "retained_string_limit");
  assert.equal(oversizedIdentity.state, null, "pending identities must not be truncated or silently dropped");
  assert.ok(oversizedIdentity.proof.bytesRead < Buffer.byteLength(oversizedIdentityInput),
    "retained string ceiling is enforced during reduction, before EOF");

  // Five 7 MiB incomplete records would exceed the shared 32 MiB logical
  // fragment allowance. Pause after each holds 6 MiB so the contention is real.
  const largeFragment = Buffer.from(jsonl([recoveryFiller(7 * 1024 * 1024)]));
  let heldReaders = 0;
  let readyReaders;
  let releaseReaders;
  const readersReady = new Promise((resolve) => { readyReaders = resolve; });
  const readersReleased = new Promise((resolve) => { releaseReaders = resolve; });
  const contended = Array.from({ length: 5 }, () => scanBytes(largeFragment, { now: () => 0 },
    async (target, offset, length, position, bytes) => {
      if (position === 6 * 1024 * 1024) {
        if (++heldReaders === 5) readyReaders();
        await readersReleased;
      }
      return { bytesRead: bytes.copy(target, offset, position, position + length) };
    }));
  await readersReady;
  releaseReaders();
  const contentionResults = await Promise.all(contended);
  assert.ok(contentionResults.some(({ proof }) => proof.reason === "buffer_limit"));
  assert.ok(contentionResults.some(({ proof }) => proof.status === "complete"));
  assert.ok(contentionResults.every(({ proof }) => proof.status === "complete" || proof.reason === "buffer_limit"));
  const readFailure = await scanBytes(largeFragment, { now: () => 0 },
    async (target, offset, length, position, bytes) => {
      if (position >= 5 * 1024 * 1024) throw new Error("synthetic failure with held fragments");
      return { bytesRead: bytes.copy(target, offset, position, position + length) };
    });
  assert.equal(readFailure.proof.reason, "read_error");
  let throwClock = false;
  await assert.rejects(scanBytes(largeFragment, { now: () => {
    if (throwClock) throw new Error("synthetic exceptional exit");
    return 0;
  } }, async (target, offset, length, position, bytes) => {
    const bytesRead = bytes.copy(target, offset, position, position + length);
    if (position >= 5 * 1024 * 1024) throwClock = true;
    return { bytesRead };
  }), /synthetic exceptional exit/);
  const afterFailure = await Promise.all(Array.from({ length: 4 }, () =>
    scanBytes(largeFragment, { now: () => 0 })));
  assert.ok(afterFailure.every(({ proof }) => proof.status === "complete"),
    "failure, refusal, success and thrown exits release their exact shared fragment charges");

  // Strict failure cannot be cleared by a later counter/interrupt in the tail.
  fs.writeFileSync(recoveryFile, `${jsonl([recoveryFiller(350000)])}{bad}\n${jsonl([
    recoveryFiller(2200000), recoveryRecord({ timestamp: "2026-08-18T18:00:05Z", pendingWorkflowCount: 0 }),
    recoveryRecord({ timestamp: "2026-08-18T18:00:06Z", interruptedMessageId: "synthetic-interruption" }),
  ])}`);
  const malformedRecovery = await sessionRuntimeObservation({ ...recoveryMetadata, generationId: "malformed" });
  assert.equal(malformedRecovery.workflowActivity.reconstruction.reason, "malformed_record");
  assert.equal(malformedRecovery.workflowActivity.observationUncertain, true);
  assert.equal(malformedRecovery.workflowActivity.pendingCount, null);
  assert.equal(lifecycleBlockReason(signalsWithWorkflowActivity({ state: "idle" }, malformedRecovery.workflowActivity)), "workflow_pending");
  const originalFailureOpen = fs.promises.open;
  let failureReplayReads = 0;
  fs.promises.open = async function (file, ...args) {
    const handle = await originalFailureOpen.call(this, file, ...args);
    if (file !== recoveryFile) return handle;
    return new Proxy(handle, { get(target, property) {
      if (property === "read") return async (...readArgs) => {
        if (readArgs[3] === 0 && readArgs[2] === 256 * 1024) failureReplayReads += 1;
        return target.read(...readArgs);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  try {
    const failureReused = await sessionRuntimeObservation({ ...recoveryMetadata, generationId: "malformed" });
    assert.equal(failureReused.workflowActivity.reconstruction.cacheHit, true);
    assert.equal(failureReused.workflowActivity.observationUncertain, true);
    assert.equal(failureReplayReads, 0, "unchanged deterministic failure must not repeat reconstruction reads");
    fs.appendFileSync(recoveryFile, jsonl([recoveryRecord({ timestamp: "2026-08-18T18:00:07Z", pendingWorkflowCount: 0 })]));
    const failedAgain = await sessionRuntimeObservation({ ...recoveryMetadata, generationId: "malformed" });
    assert.equal(failedAgain.workflowActivity.reconstruction.cacheHit, false);
    assert.equal(failedAgain.workflowActivity.reconstruction.reason, "malformed_record");
    assert.ok(failureReplayReads > 0, "append invalidates a cached refusal and rechecks the complete range");
    assert.equal(failedAgain.workflowActivity.pendingCount, null);
  } finally { fs.promises.open = originalFailureOpen; }

  // A mutation during the complete scan invalidates its candidate. Owned file
  // only; this wrapper never observes or invokes a real Claude session.
  fs.writeFileSync(recoveryFile, jsonl([recoveryLaunch, recoveryFiller(2500000), recoveryTerminal]));
  const originalOpen = fs.promises.open;
  let injectedMutation = false;
  let readsFromZero = 0;
  fs.promises.open = async function (file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (file !== recoveryFile) return handle;
    return new Proxy(handle, { get(target, property) {
      if (property === "read") return async (...readArgs) => {
        const result = await target.read(...readArgs);
        if (readArgs[3] === 0 && readArgs[2] === 256 * 1024) readsFromZero += 1;
        if (!injectedMutation && readsFromZero === 2) {
          injectedMutation = true;
          fs.appendFileSync(recoveryFile, jsonl([recoveryRecord({ timestamp: "2026-08-18T18:00:07Z", pendingWorkflowCount: 1 })]));
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  let changedRecovery;
  try { changedRecovery = await sessionRuntimeObservation({ ...recoveryMetadata, generationId: "changed-during-scan" }); }
  finally { fs.promises.open = originalOpen; }
  assert.equal(injectedMutation, true);
  assert.equal(changedRecovery.workflowActivity.reconstruction.reason, "file_changed");
  assert.equal(changedRecovery.workflowActivity.observationUncertain, true);
  assert.equal((await sessionRuntimeObservation({ ...recoveryMetadata,
    generationId: "changed-during-scan" })).workflowActivity.pendingCount, 1);

  // No workflow records establishes not_observed, not an invented zero count.
  const stableMetadata = { ...recoveryMetadata, generationId: "stable-cache" };
  fs.writeFileSync(recoveryFile, jsonl([recoveryHead, recoveryFiller(2500000)]));
  const noWorkflow = await sessionRuntimeObservation(stableMetadata);
  assert.equal(noWorkflow.workflowActivity.state, "not_observed");
  assert.equal(noWorkflow.workflowActivity.pendingCount, null);
  assert.equal(noWorkflow.workflowActivity.observationUncertain, false);
  assert.equal((await sessionRuntimeObservation(stableMetadata)).workflowActivity.reconstruction.cacheHit, true);
  fs.appendFileSync(recoveryFile, jsonl([recoveryLaunch]));
  const appendAfterProof = await sessionRuntimeObservation(stableMetadata);
  assert.equal(appendAfterProof.workflowActivity.pendingCount, 1);
  assert.equal(appendAfterProof.workflowActivity.reconstruction.cacheHit, false);
  fs.appendFileSync(recoveryFile, '{"sessionId":');
  const invalidAppend = await sessionRuntimeObservation(stableMetadata);
  assert.equal(invalidAppend.workflowActivity.pendingCount, null);
  assert.equal(invalidAppend.workflowActivity.reconstruction.reason, "partial_record");
  assert.equal(invalidAppend.workflowActivity.observationUncertain, true);
  const rotatedRecovery = `${recoveryFile}.owned-rotation`;
  fs.renameSync(recoveryFile, rotatedRecovery);
  fs.writeFileSync(recoveryFile, jsonl([recoveryLaunch, recoveryFiller(2500000), recoveryTerminal]));
  const rotated = await sessionRuntimeObservation(stableMetadata);
  assert.equal(rotated.workflowActivity.pendingCount, 0);
  assert.equal(rotated.workflowActivity.reconstruction.cacheHit, false);
  assert.equal(rotated.permissionMode, null);

  // Snapshot release uses workflow completeness while posture/history remains
  // head_tail, and cached proof never permanently applies a snapshot overlay.
  const recoverySnapshotMetadata = { ...recoveryMetadata, generationId: "recovery-snapshot" };
  fs.writeFileSync(recoveryFile, jsonl([recoveryHead, recoveryLaunch, recoveryFiller(2500000)]));
  bindSnapshotLog(recoverySnapshotMetadata, recoveryFile);
  const recoverySnapshotDir = path.join(projectDirectory, recoverySession, "workflows");
  fs.mkdirSync(recoverySnapshotDir, { recursive: true });
  fs.writeFileSync(path.join(recoverySnapshotDir, "recover-run.json"), JSON.stringify({
    status: "completed", taskId: "recover-task", runId: "recover-run",
    startTime: Date.parse("2026-08-18T18:00:02Z"), timestamp: "2026-08-18T18:00:03Z",
  }));
  const recoveredSnapshot = await sessionRuntimeObservation(recoverySnapshotMetadata);
  assert.equal(recoveredSnapshot.workflowActivity.pendingCount, 0);
  assert.equal(recoveredSnapshot.workflowActivity.completedSnapshotCount, 1);
  assert.equal(recoveredSnapshot.workflowActivity.observationCoverage, "head_tail");
  assert.equal(recoveredSnapshot.permissionMode, null);
  fs.rmSync(path.join(recoverySnapshotDir, "recover-run.json"));
  const snapshotRemoved = await sessionRuntimeObservation(recoverySnapshotMetadata);
  assert.equal(snapshotRemoved.workflowActivity.pendingCount, 1);
  assert.equal(snapshotRemoved.workflowActivity.completedSnapshotCount, 0);
  assert.equal(snapshotRemoved.workflowActivity.reconstruction.cacheHit, true);

  // A future timestamp is time-dependent, not an immutable source failure.
  // The same cold file/generation must recover when the controlled clock moves.
  fs.writeFileSync(recoveryFile, jsonl([recoveryLaunch, recoveryFiller(2500000)]));
  const futureMetadata = { ...recoveryMetadata, generationId: "future-clock" };
  const futureFileStat = fs.statSync(recoveryFile);
  const originalDateNow = Date.now;
  try {
    Date.now = () => Date.parse(recoveryLaunch.timestamp) - 1000;
    const future = await sessionRuntimeObservation(futureMetadata);
    assert.equal(future.workflowActivity.reconstruction.reason, "future_timestamp");
    assert.equal(future.workflowActivity.observationUncertain, true);
    assert.equal(future.workflowActivity.pendingCount, null);
    Date.now = () => Date.parse(recoveryLaunch.timestamp) + 1000;
    const current = await sessionRuntimeObservation(futureMetadata);
    assert.equal(current.workflowActivity.reconstruction.cacheHit, false);
    assert.equal(current.workflowActivity.reconstruction.status, "complete");
    assert.equal(current.workflowActivity.observationUncertain, false);
    assert.equal(current.workflowActivity.pendingCount, 1);
    assert.equal(current.workflowActivity.state, "pending");
  } finally { Date.now = originalDateNow; }
  const currentFileStat = fs.statSync(recoveryFile);
  for (const field of ["dev", "ino", "birthtimeMs", "size", "mtimeMs", "ctimeMs"]) {
    assert.equal(currentFileStat[field], futureFileStat[field], `${field} unchanged across clock-only recovery`);
  }

  // The normal reducer supports session_id when the primary field is absent,
  // null or empty. Complete replay must retain that compatibility and still
  // require an explicit matching identity before canonicalizing the record.
  const aliasRecord = ({ sessionId: omitted, ...record }) => ({ ...record, session_id: recoverySession });
  const aliasLaunch = aliasRecord(recoveryLaunch);
  const aliasTerminal = aliasRecord(recoveryTerminal);
  const aliasFiller = aliasRecord(recoveryFiller(2500000));
  const aliasIncrementalMetadata = { ...recoveryMetadata, generationId: "alias-incremental" };
  fs.writeFileSync(recoveryFile, jsonl([aliasLaunch]));
  assert.equal((await sessionRuntimeObservation(aliasIncrementalMetadata)).workflowActivity.pendingCount, 1);
  fs.appendFileSync(recoveryFile, jsonl([aliasFiller, aliasTerminal]));
  const aliasIncremental = await sessionRuntimeObservation(aliasIncrementalMetadata);
  const aliasCold = await sessionRuntimeObservation({ ...recoveryMetadata, generationId: "alias-cold" });
  assert.deepEqual(workflowConclusion(aliasCold), workflowConclusion(aliasIncremental));
  assert.equal(aliasCold.workflowActivity.reconstruction.status, "complete");
  assert.equal(aliasCold.workflowActivity.observationCoverage, "head_tail");
  assert.equal(aliasCold.workflowActivity.pendingCount, 0);
  fs.writeFileSync(recoveryFile, jsonl([aliasLaunch, aliasFiller]));
  const aliasPending = await sessionRuntimeObservation({ ...recoveryMetadata, generationId: "alias-pending" });
  assert.equal(aliasPending.workflowActivity.pendingCount, 1);
  assert.equal(aliasPending.workflowActivity.observationUncertain, false);
  for (const primary of [undefined, null, ""]) {
    const fallback = await scanBytes(jsonl([{ ...aliasLaunch, sessionId: primary },
      { ...aliasTerminal, sessionId: primary }]));
    assert.equal(fallback.proof.status, "complete");
    assert.equal(fallback.state.pendingWorkflowCount, 0);
  }
  for (const rejected of [
    { ...aliasLaunch, session_id: sessionId },
    { ...aliasLaunch, session_id: undefined },
    { ...aliasLaunch, sessionId, session_id: recoverySession },
  ]) assert.equal((await scanBytes(jsonl([rejected]))).proof.reason, "identity_ambiguous");
  const primaryPrecedence = await scanBytes(jsonl([
    { ...recoveryLaunch, session_id: sessionId }, { ...recoveryTerminal, session_id: sessionId },
  ]));
  assert.equal(primaryPrecedence.state.pendingWorkflowCount, 0,
    "matching primary identity retains existing matcher precedence over a foreign fallback");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("runtime-observation-file ok");
