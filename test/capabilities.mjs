import assert from "node:assert/strict";
import {
  parseClaudeCapabilities,
  resolveLaunchOptionsFromCapabilities,
  ultracodeEnvironmentStatus,
} from "../src/index.js";

const help = `Usage: claude [options]

Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan")
  --remote-control [name]                Start Remote Control
  --safe-mode                           Start with customizations disabled
  --settings <file-or-json>             Load additional settings
`;

const legacy = parseClaudeCapabilities("2.1.198 (Claude Code)\n", help, "claude.exe");
assert.equal(legacy.available, true);
assert.equal(legacy.version, "2.1.198 (Claude Code)");
assert.deepEqual(legacy.advertised.effortLevels, ["low", "medium", "high", "xhigh", "max"]);
assert.deepEqual(legacy.advertised.permissionModes, [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
]);
assert.equal(legacy.mcp.bypassPermissionsRequiresConfirmation, true);
assert.equal(typeof legacy.mcp.bypassPermissionsEnabled, "boolean");
assert.equal(legacy.mcp.bypassPermissionsPolicyReadAtProcessStart, true);
assert.equal(legacy.mcp.bypassPermissionsPolicyRelaunchRequiredAfterChange, true);
assert.deepEqual(Object.keys(legacy.mcp.bypassPermissionsPolicyAcceptedValues).sort(), [
  "isolated",
  "localHost",
]);
assert.equal(legacy.ultracode.mcpLaunchRequestAvailable, false);
assert.equal(legacy.ultracode.experimentalSessionSettingsRequestAvailable, true);
assert.equal(legacy.ultracode.launchMechanism, "experimental_session_settings");

const current = parseClaudeCapabilities("2.1.220 (Claude Code)\n", help, "claude.exe");
assert.equal(current.ultracode.supportedByInstalledVersion, true);
assert.equal(current.ultracode.mcpLaunchRequestAvailable, true);
assert.equal(current.ultracode.launchMechanism, "effort_flag");
assert.equal(current.ultracode.capabilityStatus, "officially_supported_unprobed");
assert.equal(current.ultracode.supportSource, "official_version_contract");
assert.equal(current.ultracode.directLaunchVersionFloor, "2.1.203");
assert.equal(
  current.ultracode.documentationUrl,
  "https://code.claude.com/docs/en/settings#available-settings"
);
assert.match(current.ultracode.note, /--effort=ultracode/);
assert.equal(
  resolveLaunchOptionsFromCapabilities({ permissionMode: "default", ultracode: true }, current)
    .ultracodeMechanism,
  "effort"
);

const acceptedUnadvertised = parseClaudeCapabilities(
  "2.1.234 (Claude Code)\n",
  help,
  "claude.exe",
  {
    attempted: true,
    succeeded: true,
    exitCode: 0,
    stdout: "2.1.234 (Claude Code)\n",
    stderr: "",
    controlAttempted: true,
    controlSucceeded: false,
    controlExitCode: 64,
    controlStderr:
      "Unknown --effort value 'rail-invalid-probe'. Valid values: low, medium, high, xhigh, max",
  }
);
assert.equal(acceptedUnadvertised.ultracode.capabilityStatus, "accepted_unadvertised");
assert.equal(acceptedUnadvertised.ultracode.supportSource, "parser_probe");
assert.equal(acceptedUnadvertised.ultracode.argumentProbe.accepted, true);
assert.equal(acceptedUnadvertised.ultracode.argumentProbe.rejected, false);
assert.equal(acceptedUnadvertised.ultracode.argumentProbe.exitCode, 0);
assert.equal(acceptedUnadvertised.ultracode.argumentProbe.controlExitCode, 64);
assert.equal(acceptedUnadvertised.ultracode.argumentProbe.controlRejected, true);
assert.equal(acceptedUnadvertised.ultracode.argumentProbe.result, "accepted");
assert.equal(
  acceptedUnadvertised.ultracode.argumentProbe.evidenceBasis,
  "exit_status_calibrated"
);

const uncalibratedProbe = parseClaudeCapabilities(
  "2.1.234 (Claude Code)\n",
  help,
  "claude.exe",
  {
    attempted: true,
    succeeded: true,
    stdout: "2.1.234 (Claude Code)\n",
    controlAttempted: true,
    controlSucceeded: true,
    controlStdout: "2.1.234 (Claude Code)\n",
  }
);
assert.equal(uncalibratedProbe.ultracode.argumentProbe.accepted, false);
assert.equal(uncalibratedProbe.ultracode.argumentProbe.result, "inconclusive");
assert.equal(
  uncalibratedProbe.ultracode.capabilityStatus,
  "officially_supported_probe_inconclusive"
);

const rejectedByParser = parseClaudeCapabilities(
  "2.1.234 (Claude Code)\n",
  help,
  "claude.exe",
  {
    attempted: true,
    succeeded: false,
    exitCode: 2,
    stderr: "Unknown --effort value 'ultracode'. Valid values: low, medium, high, xhigh, max",
  }
);
assert.equal(rejectedByParser.ultracode.capabilityStatus, "rejected");
assert.equal(rejectedByParser.ultracode.supportSource, "parser_probe_rejected");
assert.equal(rejectedByParser.ultracode.argumentProbe.rejected, true);
assert.equal(rejectedByParser.ultracode.mcpLaunchRequestAvailable, false);
assert.equal(rejectedByParser.ultracode.launchMechanism, "experimental_session_settings");

const acceptedDespiteMisleadingText = parseClaudeCapabilities(
  "2.1.234 (Claude Code)\n",
  help,
  "claude.exe",
  {
    attempted: true,
    succeeded: true,
    exitCode: 0,
    stderr: "Unknown --effort value ultracode appeared in a diagnostic example",
    controlAttempted: true,
    controlSucceeded: false,
    controlExitCode: 64,
    controlStderr: "fixture rejected the requested effort selection",
  }
);
assert.equal(
  acceptedDespiteMisleadingText.ultracode.argumentProbe.accepted,
  true
);
assert.equal(
  acceptedDespiteMisleadingText.ultracode.argumentProbe.rejectionTextMatched,
  true
);
assert.equal(
  acceptedDespiteMisleadingText.ultracode.argumentProbe.controlRejectionTextMatched,
  false
);

for (const excludedProbe of [
  { timedOut: true },
  { terminated: true, signal: "SIGTERM" },
]) {
  const excluded = parseClaudeCapabilities(
    "2.1.234 (Claude Code)\n",
    help,
    "claude.exe",
    {
      attempted: true,
      succeeded: false,
      exitCode: 1,
      stderr: "Unknown --effort value ultracode",
      ...excludedProbe,
      controlAttempted: true,
      controlSucceeded: false,
      controlExitCode: 64,
    }
  );
  assert.equal(excluded.ultracode.argumentProbe.accepted, false);
  assert.equal(excluded.ultracode.argumentProbe.rejected, false);
  assert.equal(excluded.ultracode.argumentProbe.result, "inconclusive");
  assert.equal(
    excluded.ultracode.capabilityStatus,
    "officially_supported_probe_inconclusive"
  );
}

const futureHelp = help.replace("(low, medium, high, xhigh, max)", "(low, medium, high, xhigh, max, ultracode)");
const future = parseClaudeCapabilities("future-build (Claude Code)\n", futureHelp, "claude.exe");
assert.deepEqual(future.advertised.effortLevels, ["low", "medium", "high", "xhigh", "max", "ultracode"]);
assert.equal(future.ultracode.advertisedAsEffort, true);
assert.equal(future.ultracode.mcpLaunchRequestAvailable, true);

const advertisedButRejected = parseClaudeCapabilities(
  "2.1.234 (Claude Code)\n",
  futureHelp,
  "claude.exe",
  {
    attempted: true,
    succeeded: false,
    stderr: "Unknown --effort value 'ultracode'. Valid values: low, medium, high, xhigh, max",
  }
);
assert.equal(advertisedButRejected.ultracode.advertisedAsEffort, true);
assert.equal(advertisedButRejected.ultracode.capabilityStatus, "rejected");
assert.equal(advertisedButRejected.ultracode.supportSource, "parser_probe_rejected");
assert.equal(advertisedButRejected.ultracode.mcpLaunchRequestAvailable, false);
assert.match(advertisedButRejected.ultracode.note, /do not override that rejection/);

const manualHelp = help.replace(
  '"acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"',
  '"acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"'
);
const manual = parseClaudeCapabilities("2.1.220 (Claude Code)\n", manualHelp, "claude.exe");
assert.deepEqual(manual.advertised.permissionModes, [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
]);
assert.deepEqual(resolveLaunchOptionsFromCapabilities({ permissionMode: "default" }, manual), {
  permissionMode: "manual",
  requestedPermissionMode: "default",
});
assert.deepEqual(resolveLaunchOptionsFromCapabilities({ permissionMode: "manual" }, legacy), {
  permissionMode: "default",
  requestedPermissionMode: "manual",
});
assert.deepEqual(
  resolveLaunchOptionsFromCapabilities({ permissionMode: "bypassPermissions" }, manual),
  {
    permissionMode: "bypassPermissions",
    requestedPermissionMode: "bypassPermissions",
  }
);
assert.throws(
  () => resolveLaunchOptionsFromCapabilities({ permissionMode: "acceptEdits" }, {
    ...manual,
    advertised: { ...manual.advertised, permissionModes: ["manual", "plan"] },
  }),
  /does not advertise permission mode acceptEdits/
);
assert.throws(
  () =>
    resolveLaunchOptionsFromCapabilities(
      { permissionMode: "default", effort: "max" },
      {
        ...legacy,
        advertised: { ...legacy.advertised, effortLevels: ["low", "medium"] },
      }
    ),
  /does not advertise effort level max/
);

const unsupported = parseClaudeCapabilities(
  "1.0.0\n",
  '--effort <level> (low, medium)\n  --permission-mode <mode> (choices: "default")\n',
  "claude"
);
assert.equal(unsupported.ultracode.mcpLaunchRequestAvailable, false);
assert.equal(unsupported.ultracode.launchMechanism, "unavailable");
assert.throws(
  () => resolveLaunchOptionsFromCapabilities({ permissionMode: "default", ultracode: true }, unsupported),
  /no supported or explicitly confirmed experimental Ultracode launch path/
);

assert.deepEqual(ultracodeEnvironmentStatus({}), {
  status: "compatible",
  evidenceScope: "mcp_process_environment",
  effortOverrideStatus: "unset",
  workflowsDisabled: false,
  blockers: [],
  note:
    "No blocking UltraCode override was found in the MCP process environment. Claude settings or child-process configuration can still differ.",
});
assert.equal(
  ultracodeEnvironmentStatus({ CLAUDE_CODE_EFFORT_LEVEL: "xhigh" }).status,
  "compatible"
);
assert.deepEqual(
  ultracodeEnvironmentStatus({
    CLAUDE_CODE_EFFORT_LEVEL: "max",
    CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
  }).blockers,
  ["non_xhigh_effort_override", "workflows_disabled"]
);
const privateEffortSentinel = "private-effort-value-must-not-escape";
const redactedEnvironment = ultracodeEnvironmentStatus({
  CLAUDE_CODE_EFFORT_LEVEL: privateEffortSentinel,
});
assert.equal(redactedEnvironment.effortOverrideStatus, "blocking_non_xhigh");
assert.doesNotMatch(JSON.stringify(redactedEnvironment), new RegExp(privateEffortSentinel));
assert.throws(
  () =>
    resolveLaunchOptionsFromCapabilities(
      { permissionMode: "default", ultracode: true },
      {
        ...current,
        ultracode: {
          ...current.ultracode,
          environment: ultracodeEnvironmentStatus({ CLAUDE_CODE_EFFORT_LEVEL: "high" }),
        },
      }
    ),
  /process environment blocks UltraCode: non_xhigh_effort_override/
);

console.log("capabilities ok");
