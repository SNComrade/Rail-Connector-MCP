import assert from "node:assert/strict";
import { parseClaudeCapabilities, resolveLaunchOptionsFromCapabilities } from "../src/index.js";

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
assert.match(current.ultracode.note, /--effort=ultracode/);
assert.equal(
  resolveLaunchOptionsFromCapabilities({ permissionMode: "default", ultracode: true }, current)
    .ultracodeMechanism,
  "effort"
);

const futureHelp = help.replace("(low, medium, high, xhigh, max)", "(low, medium, high, xhigh, max, ultracode)");
const future = parseClaudeCapabilities("future-build (Claude Code)\n", futureHelp, "claude.exe");
assert.deepEqual(future.advertised.effortLevels, ["low", "medium", "high", "xhigh", "max", "ultracode"]);
assert.equal(future.ultracode.advertisedAsEffort, true);
assert.equal(future.ultracode.mcpLaunchRequestAvailable, true);

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

console.log("capabilities ok");
