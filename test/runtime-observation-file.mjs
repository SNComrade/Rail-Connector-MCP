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

const { sessionRuntimeObservation } = await import(
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
      },
    },
    {
      ...baseRecord,
      timestamp: "2026-08-18T08:00:04Z",
      pendingWorkflowCount: 0,
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
  assert.equal(initial.permissionMode, "bypassPermissions");
  assert.equal(initial.model, "claude-fable-5");
  assert.equal(initial.effort, "xhigh");
  assert.equal(initial.workflowActivity.state, "not_observed");
  assert.equal(initial.workflowActivity.pendingCount, null);
  assert.equal(initial.workflowActivity.observationCoverage, "head_tail");
  assert.ok(initial.workflowActivity.observationSkippedBytes > 0);
  assert.doesNotMatch(JSON.stringify(initial), /private-name-must-not-escape/);

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
  assert.equal(appended.permissionMode, "bypassPermissions");
  assert.equal(appended.effort, "max");
  assert.equal(appended.workflowActivity.launchObserved, false);
  assert.equal(appended.workflowActivity.observationCoverage, "head_tail");

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
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("runtime-observation-file ok");
