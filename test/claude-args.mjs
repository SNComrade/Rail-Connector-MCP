import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertBypassPolicy,
  bypassPolicyStatus,
  assertSafeManagedSessionName,
  assertSafeSessionId,
  claudeChildLaunchEnvironmentStatus,
  claudeArgs,
  compareLaunchMetadata,
  managedSessionName,
  requestedLaunchPosture,
  requestedLaunchPostureFromArgs,
  resolveCommandFromPath,
  resolveAllowedCwd,
  textChunks,
  tmuxChildEnvironmentArgs,
  upgradeLaunchMetadataToV3,
  upgradeLaunchMetadataToV4,
  validateLaunchMetadata,
  windowsPtyLaunchDescriptor,
} from "../src/index.js";

const resumeId = "00000000-0000-0000-0000-000000000000";
const newId = "11111111-1111-4111-8111-111111111111";

assert.doesNotThrow(() => assertSafeSessionId(resumeId));
assert.throws(() => assertSafeSessionId("../session"), /Invalid Claude session id/);
assert.throws(() => assertSafeSessionId("00000000-0000-0000-0000-00000000000z"), /Invalid Claude session id/);
assert.throws(() => assertSafeSessionId("11111111-1111-1111-1111-111111111111"), /Invalid Claude session id/);
assert.doesNotThrow(() => assertSafeManagedSessionName("claude-review_1"));
assert.throws(() => assertSafeManagedSessionName("a:b"), /Invalid managed session name/);
assert.throws(() => assertSafeManagedSessionName("../session"), /Invalid managed session name/);
assert.throws(() => assertSafeManagedSessionName("a".repeat(81)), /Invalid managed session name/);
assert.equal(managedSessionName({}), "rail-connector-managed");
assert.equal(
  managedSessionName({ managedSession: "rail-connector-managed", tmuxSession: "legacy-session" }),
  "legacy-session"
);
assert.equal(managedSessionName({ managedSession: "explicit-session", tmuxSession: "legacy-session" }), "explicit-session");

assert.deepEqual(
  windowsPtyLaunchDescriptor("C:\\Tools\\claude.cmd", ["--model", "sonnet"], {
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
  }),
  {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: [],
    commandLine: '/d /s /c ""C:\\Tools\\claude.cmd" "--model" "sonnet""',
    metadataCommand: "C:\\Tools\\claude.cmd",
    metadataArgs: ["--model", "sonnet"],
  }
);
assert.deepEqual(
  windowsPtyLaunchDescriptor("/usr/bin/claude", ["--help"], { platform: "linux" }),
  {
    command: "/usr/bin/claude",
    args: ["--help"],
    metadataCommand: "/usr/bin/claude",
    metadataArgs: ["--help"],
  }
);

assert.deepEqual(
  claudeArgs({
    remoteName: "Rail-Connector",
    permissionMode: "default",
  }),
  ["--remote-control=Rail-Connector", "--permission-mode=default"]
);

for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
  assert.deepEqual(
    claudeArgs({ remoteName: "Effort", permissionMode: "default", effort }),
    [`--effort=${effort}`, "--remote-control=Effort", "--permission-mode=default"]
  );
}

for (const permissionMode of ["default", "manual", "acceptEdits", "auto", "dontAsk", "plan"]) {
  assert.deepEqual(
    claudeArgs({ remoteName: "Permissions", permissionMode }),
    ["--remote-control=Permissions", `--permission-mode=${permissionMode}`]
  );
}

assert.throws(
  () => claudeArgs({ remoteName: "Bypass", permissionMode: "bypassPermissions" }),
  /confirmBypassPermissions=true/
);
assert.deepEqual(
  claudeArgs({
    remoteName: "Bypass",
    permissionMode: "bypassPermissions",
    confirmBypassPermissions: true,
  }),
  ["--remote-control=Bypass", "--permission-mode=bypassPermissions"]
);

const ultracodeArgs = claudeArgs({
  remoteName: "Ultracode",
  permissionMode: "default",
  ultracode: true,
  confirmUltracode: true,
});
assert.deepEqual(ultracodeArgs, [
  "--effort=ultracode",
  "--remote-control=Ultracode",
  "--permission-mode=default",
]);
assert.equal(ultracodeArgs.includes("--effort=ultracode"), true);
const directUltracodeArgs = claudeArgs({
  remoteName: "Ultracode",
  permissionMode: "default",
  ultracode: true,
  ultracodeMechanism: "effort",
  confirmUltracode: true,
});
assert.deepEqual(directUltracodeArgs, [
  "--effort=ultracode",
  "--remote-control=Ultracode",
  "--permission-mode=default",
]);
const experimentalSettingsUltracodeArgs = claudeArgs({
  remoteName: "Ultracode Settings",
  permissionMode: "default",
  ultracode: true,
  ultracodeMechanism: "settings",
  confirmUltracode: true,
});
assert.deepEqual(experimentalSettingsUltracodeArgs, [
  '--settings={"ultracode":true}',
  "--remote-control=Ultracode Settings",
  "--permission-mode=default",
]);
assert.equal(
  requestedLaunchPostureFromArgs(experimentalSettingsUltracodeArgs)
    .ultracodeMechanism,
  "settings"
);

assert.deepEqual(
  tmuxChildEnvironmentArgs({
    CLAUDE_CONFIG_DIR: "/tmp/claude config",
    CLAUDE_CODE_EFFORT_LEVEL: "xhigh",
    CLAUDE_CODE_DISABLE_WORKFLOWS: "0",
  }),
  [
    "-e",
    "CLAUDE_CONFIG_DIR=/tmp/claude config",
    "-e",
    "CLAUDE_CODE_EFFORT_LEVEL=xhigh",
    "-e",
    "CLAUDE_CODE_DISABLE_WORKFLOWS=0",
    "-e",
    "FORCE_COLOR=1",
  ]
);
const privateLaunchOverride = "private-launch-value-must-not-escape";
const redactedLaunchEnvironment = claudeChildLaunchEnvironmentStatus({
  CLAUDE_CODE_EFFORT_LEVEL: privateLaunchOverride,
});
assert.equal(redactedLaunchEnvironment.status, "blocking");
assert.doesNotMatch(
  JSON.stringify(redactedLaunchEnvironment),
  new RegExp(privateLaunchOverride)
);
assert.throws(
  () => claudeArgs({ remoteName: "Bad", permissionMode: "default", effort: "ultracode" }),
  /Unsupported Claude effort/
);
assert.throws(
  () => claudeArgs({ remoteName: "Bad", permissionMode: "default", ultracode: true }),
  /confirmUltracode=true/
);
assert.throws(
  () =>
    claudeArgs({
      remoteName: "Bad",
      permissionMode: "default",
      ultracode: true,
      confirmUltracode: true,
      effort: "xhigh",
    }),
  /cannot be combined with effort/
);
assert.throws(
  () =>
    claudeArgs({
      remoteName: "Bad",
      permissionMode: "default",
      ultracode: true,
      confirmUltracode: true,
      safeMode: true,
    }),
  /cannot be combined with safeMode/
);

assert.deepEqual(
  requestedLaunchPosture({
    permissionMode: "bypassPermissions",
    model: "opus",
    ultracode: true,
    confirmBypassPermissions: true,
    bypassPolicyMode: "local_host_acknowledged",
  }),
  {
    permissionMode: "bypassPermissions",
    model: "opus",
    effort: "xhigh",
    ultracode: true,
    ultracodeMechanism: "effort",
    bypassPermissionsAcknowledged: true,
    bypassPermissionsPolicyMode: "local_host_acknowledged",
  }
);
assert.deepEqual(requestedLaunchPostureFromArgs(ultracodeArgs), {
  permissionMode: "default",
  model: null,
  effort: "xhigh",
  ultracode: true,
  ultracodeMechanism: "effort",
  bypassPermissionsAcknowledged: null,
  bypassPermissionsPolicyMode: null,
});
assert.deepEqual(requestedLaunchPostureFromArgs(directUltracodeArgs), {
  permissionMode: "default",
  model: null,
  effort: "xhigh",
  ultracode: true,
  ultracodeMechanism: "effort",
  bypassPermissionsAcknowledged: null,
  bypassPermissionsPolicyMode: null,
});

const launchMetadata = {
  cwd: process.cwd(),
  args: ["--permission-mode", "default"],
};
assert.deepEqual(compareLaunchMetadata(launchMetadata, { ...launchMetadata }), {
  comparison: "match",
  launchMismatch: false,
});
assert.deepEqual(
  compareLaunchMetadata(launchMetadata, { ...launchMetadata, args: ["--permission-mode", "plan"] }),
  { comparison: "mismatch", launchMismatch: true }
);
assert.deepEqual(compareLaunchMetadata(null, launchMetadata), {
  comparison: "unknown",
  launchMismatch: null,
});
assert.deepEqual(compareLaunchMetadata({ args: launchMetadata.args }, launchMetadata), {
  comparison: "unknown",
  launchMismatch: null,
});

assert.deepEqual(
  claudeArgs({
    sessionId: resumeId,
    forkSession: true,
    remoteName: "Codex Review",
    permissionMode: "plan",
    model: "sonnet",
    effort: "high",
    allowedTools: ["Read", "Grep", "Bash(git *)"],
    disallowedTools: "Edit,Write",
    tools: ["Read", "Grep"],
    safeMode: true,
    bare: true,
    axScreenReader: true,
  }),
  [
    "--resume",
    resumeId,
    "--fork-session",
    "--model=sonnet",
    "--effort=high",
    "--allowedTools=Read,Grep,Bash(git *)",
    "--disallowedTools=Edit,Write",
    "--tools=Read,Grep",
    "--safe-mode",
    "--bare",
    "--ax-screen-reader",
    "--remote-control=Codex Review",
    "--permission-mode=plan",
  ]
);

assert.deepEqual(
  claudeArgs({
    newSessionId: newId,
    remoteName: "Fresh",
    sessionTitle: "Fresh conversation",
    permissionMode: "default",
  }),
  ["--session-id", newId, "--name=Fresh conversation", "--remote-control=Fresh", "--permission-mode=default"]
);

assert.deepEqual(
  claudeArgs({
    continueLatest: true,
    forkSession: true,
    remoteName: "Continue",
    permissionMode: "default",
  }),
  ["--continue", "--fork-session", "--remote-control=Continue", "--permission-mode=default"]
);

for (const malicious of [
  { remoteName: "--dangerously-skip-permissions" },
  { model: "--dangerously-skip-permissions" },
  { allowedTools: "--dangerously-skip-permissions" },
  { allowedTools: "Read,--dangerously-skip-permissions" },
  { disallowedTools: ["--permission-mode", "Read"] },
  { tools: "--tools\n--dangerously-skip-permissions" },
]) {
  assert.throws(
    () => claudeArgs({ remoteName: "Safe", permissionMode: "plan", ...malicious }),
    /cannot start with|entries cannot start|control characters/
  );
}

assert.doesNotThrow(() => assertBypassPolicy("plan", {}));
assert.throws(() => assertBypassPolicy("bypassPermissions", {}), /disabled by policy/);
assert.doesNotThrow(() =>
  assertBypassPolicy("bypassPermissions", {
    RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS: "I_UNDERSTAND_THIS_REQUIRES_ISOLATION",
  })
);
assert.doesNotThrow(() =>
  assertBypassPolicy("bypassPermissions", {
    RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS:
      "I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS",
  })
);
assert.deepEqual(
  bypassPolicyStatus({
    RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS:
      "I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS",
  }),
  {
    enabled: true,
    mode: "local_host_acknowledged",
    environment: "RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS",
    configured: true,
    recognized: true,
    acceptedValues: {
      localHost: "I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS",
      isolated: "I_UNDERSTAND_THIS_REQUIRES_ISOLATION",
    },
    requiresConfirmation: true,
    requiresPolicyAcknowledgement: true,
    readAtProcessStart: true,
    relaunchRequiredAfterChange: true,
  }
);
assert.deepEqual(
  bypassPolicyStatus({
    RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS: "I_UNDERSTAND_THIS_REQUIRES_ISOLATION",
  }),
  {
    enabled: true,
    mode: "isolated",
    environment: "RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS",
    configured: true,
    recognized: true,
    acceptedValues: {
      localHost: "I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS",
      isolated: "I_UNDERSTAND_THIS_REQUIRES_ISOLATION",
    },
    requiresConfirmation: true,
    requiresPolicyAcknowledgement: true,
    readAtProcessStart: true,
    relaunchRequiredAfterChange: true,
  }
);
for (const invalidPolicy of ["", "yes", "I_UNDERSTAND_THIS_REQUIRES_ISOLATION "]) {
  const invalidStatus = bypassPolicyStatus({
    RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS: invalidPolicy,
  });
  assert.equal(invalidStatus.enabled, false);
  assert.equal(invalidStatus.mode, "disabled");
  assert.equal(invalidStatus.configured, invalidPolicy.length > 0);
  assert.equal(invalidStatus.recognized, false);
  assert.throws(
    () =>
      assertBypassPolicy("bypassPermissions", {
        RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS: invalidPolicy,
      }),
    /newly spawned MCP process/
  );
}

const surrogateBoundary = `${"a".repeat(255)}😀tail`;
assert.deepEqual(textChunks(surrogateBoundary, 256), [`${"a".repeat(255)}`, "😀tail"]);

assert.throws(
  () =>
    claudeArgs({
      sessionId: resumeId,
      continueLatest: true,
      remoteName: "Bad",
      permissionMode: "default",
    }),
  /mutually exclusive/
);

assert.throws(
  () =>
    claudeArgs({
      forkSession: true,
      remoteName: "Bad",
      permissionMode: "default",
    }),
  /requires sessionId or continueLatest/
);

assert.throws(
  () =>
    claudeArgs({
      safeMode: true,
      remoteName: "Bad",
      permissionMode: "bypassPermissions",
    }),
  /safeMode cannot be combined/
);

const commandRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rail-connector-command-"));
const commandFile = path.join(commandRoot, "claude.exe");
fs.writeFileSync(commandFile, "");
assert.equal(
  resolveCommandFromPath("claude", {
    platform: "win32",
    pathValue: commandRoot,
    pathExtValue: ".EXE;.CMD",
  }).toLowerCase(),
  (fs.realpathSync.native?.(commandFile) ?? fs.realpathSync(commandFile)).toLowerCase()
);
assert.equal(
  resolveCommandFromPath("claude", {
    platform: "win32",
    pathValue: "",
    pathExtValue: ".EXE;.CMD",
  }),
  ""
);
assert.equal(
  resolveCommandFromPath("claude", {
    platform: "win32",
    pathValue: ".",
    pathExtValue: ".EXE;.CMD",
  }),
  ""
);
fs.rmSync(commandRoot, { recursive: true, force: true });

const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rail-connector-allowed-"));
const allowedChild = path.join(allowedRoot, "child");
const deniedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rail-connector-denied-"));
const secondAllowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rail-connector-allowed2-"));
const secondAllowedChild = path.join(secondAllowedRoot, "child");
const prefixBase = fs.mkdtempSync(path.join(os.tmpdir(), "rail-connector-prefix-base-"));
const prefixAllowed = path.join(prefixBase, "root");
const prefixSibling = path.join(prefixBase, "root-evil");
fs.mkdirSync(allowedChild);
fs.mkdirSync(secondAllowedChild);
fs.mkdirSync(prefixAllowed);
fs.mkdirSync(prefixSibling);
const previousAllowedRoots = process.env.RAIL_CONNECTOR_ALLOWED_ROOTS;
process.env.RAIL_CONNECTOR_ALLOWED_ROOTS = allowedRoot;
try {
  assert.equal(resolveAllowedCwd(allowedChild), path.resolve(allowedChild));
  const validMetadata = validateLaunchMetadata({
    schemaVersion: 2,
    cwd: allowedChild,
    startedAt: "2026-07-27T00:00:00.000Z",
    paneId: "%42",
    pid: 4242,
    args: ["--permission-mode=plan"],
    requestedPosture: {
      permissionMode: "plan",
      model: null,
      effort: null,
      ultracode: false,
      ultracodeMechanism: null,
      bypassPermissionsAcknowledged: null,
    },
  });
  assert.equal(validMetadata.cwd, path.resolve(allowedChild));
  assert.equal(validMetadata.startedAtMs, Date.parse("2026-07-27T00:00:00.000Z"));
  const upgradedMetadata = upgradeLaunchMetadataToV3(validMetadata);
  assert.equal(upgradedMetadata.schemaVersion, 3);
  assert.equal(upgradedMetadata.requestedPosture.bypassPermissionsPolicyMode, null);
  assert.equal(upgradedMetadata.resolvedPosture.bypassPermissionsPolicyMode, null);
  assert.deepEqual(validateLaunchMetadata(upgradedMetadata), upgradedMetadata);
  const launchEnvironment = claudeChildLaunchEnvironmentStatus({
    CLAUDE_CODE_EFFORT_LEVEL: "xhigh",
    CLAUDE_CODE_DISABLE_WORKFLOWS: "0",
  });
  const currentMetadata = upgradeLaunchMetadataToV4(upgradedMetadata, {
    launchEnvironment,
  });
  assert.equal(currentMetadata.schemaVersion, 4);
  assert.deepEqual(currentMetadata.launchEnvironment, launchEnvironment);
  assert.deepEqual(validateLaunchMetadata(currentMetadata), currentMetadata);
  assert.throws(
    () => upgradeLaunchMetadataToV4(upgradedMetadata),
    /environment provenance is unavailable/
  );
  assert.equal(validateLaunchMetadata({ ...validMetadata, schemaVersion: 1 }), null);
  assert.equal(validateLaunchMetadata({ ...validMetadata, cwd: 1 }), null);
  assert.equal(validateLaunchMetadata({ ...validMetadata, paneId: "0.0" }), null);
  assert.equal(validateLaunchMetadata({ ...validMetadata, pid: null }), null);
  assert.throws(() => resolveAllowedCwd(deniedRoot), /outside RAIL_CONNECTOR_ALLOWED_ROOTS/);

  if (process.platform === "win32") {
    process.env.RAIL_CONNECTOR_ALLOWED_ROOTS = allowedRoot.toUpperCase();
    assert.equal(resolveAllowedCwd(allowedChild.toLowerCase()).toLowerCase(), path.resolve(allowedChild).toLowerCase());
  }

  process.env.RAIL_CONNECTOR_ALLOWED_ROOTS = [allowedRoot, secondAllowedRoot].join(path.delimiter);
  assert.equal(resolveAllowedCwd(secondAllowedChild), path.resolve(secondAllowedChild));

  process.env.RAIL_CONNECTOR_ALLOWED_ROOTS = prefixAllowed;
  assert.throws(() => resolveAllowedCwd(prefixSibling), /outside RAIL_CONNECTOR_ALLOWED_ROOTS/);

  process.env.RAIL_CONNECTOR_ALLOWED_ROOTS = path.join(os.tmpdir(), "rail-connector-missing-a") + path.delimiter + path.join(os.tmpdir(), "rail-connector-missing-b");
  assert.throws(() => resolveAllowedCwd(deniedRoot), /none of its entries are existing directories/);

  const linkInside = path.join(os.tmpdir(), `rail-connector-link-inside-${process.pid}`);
  const linkOutside = path.join(allowedRoot, "outside-link");
  try {
    fs.symlinkSync(allowedChild, linkInside, "junction");
    fs.symlinkSync(deniedRoot, linkOutside, "junction");
    process.env.RAIL_CONNECTOR_ALLOWED_ROOTS = allowedRoot;
    assert.equal(resolveAllowedCwd(linkInside), path.resolve(linkInside));
    assert.throws(() => resolveAllowedCwd(linkOutside), /outside RAIL_CONNECTOR_ALLOWED_ROOTS/);
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
  } finally {
    fs.rmSync(linkInside, { recursive: true, force: true });
    fs.rmSync(linkOutside, { recursive: true, force: true });
  }
} finally {
  if (previousAllowedRoots === undefined) delete process.env.RAIL_CONNECTOR_ALLOWED_ROOTS;
  else process.env.RAIL_CONNECTOR_ALLOWED_ROOTS = previousAllowedRoots;
  fs.rmSync(allowedRoot, { recursive: true, force: true });
  fs.rmSync(deniedRoot, { recursive: true, force: true });
  fs.rmSync(secondAllowedRoot, { recursive: true, force: true });
  fs.rmSync(prefixBase, { recursive: true, force: true });
}

console.log("claude-args ok");
