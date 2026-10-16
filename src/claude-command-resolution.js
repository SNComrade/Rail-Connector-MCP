import path from "node:path";

const WINDOWS_WRAPPER_EXTENSIONS = new Set([".cmd", ".bat"]);

function platformPath(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathEntries(pathValue, platform, pathApi) {
  return String(pathValue)
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry && pathApi.isAbsolute(entry));
}

function candidateExtensions(command, platform, pathExtValue, pathApi) {
  if (platform !== "win32" || pathApi.extname(command)) return [""];
  const configured = String(pathExtValue)
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  // Keep this order aligned with the MCP's historic normal launch behaviour.
  return [...new Set([".exe", ".cmd", ".bat", ".com", ...configured])];
}

function descriptor(command, selectedPath, platform, normalizePath) {
  const pathApi = platformPath(platform);
  const resolvedPath = normalizePath(selectedPath);
  const extension = pathApi.extname(resolvedPath).toLowerCase();
  const wrapper = platform === "win32" && WINDOWS_WRAPPER_EXTENSIONS.has(extension);
  return Object.freeze({
    schema: "rail-claude-normal-launch-descriptor/v1",
    command: String(command),
    source: "path_order",
    configuredOverride: false,
    path: resolvedPath,
    extension,
    launchKind: wrapper ? "windows_batch_wrapper" : "native_executable",
    wrapper: wrapper ? Object.freeze({ path: resolvedPath, extension }) : null,
    // A batch file has no executable process image. Its target must be bound
    // by a launch observer; static PATH resolution must not guess it.
    target: wrapper
      ? null
      : Object.freeze({ path: resolvedPath, provenance: "selected_native_path" }),
    targetProvenance: wrapper ? "unproven_wrapper_target" : "selected_native_path",
  });
}

/**
 * Resolve exactly the command that the MCP's normal PATH-order launch will
 * select. `isExecutable` and `normalizePath` are injected so callers can use
 * the same pure resolver with either product filesystem checks or fixtures.
 */
export function resolveNormalLaunchDescriptor(
  command,
  {
    platform = process.platform,
    pathValue = process.env.PATH ?? "",
    pathExtValue = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    isExecutable,
    normalizePath = (value) => value,
  } = {}
) {
  if (typeof isExecutable !== "function") {
    throw new TypeError("normal launch resolution requires an executable predicate");
  }
  const requested = String(command);
  const pathApi = platformPath(platform);
  if (pathApi.isAbsolute(requested)) {
    return isExecutable(requested, platform)
      ? descriptor(requested, requested, platform, normalizePath)
      : null;
  }
  for (const directory of pathEntries(pathValue, platform, pathApi)) {
    for (const extension of candidateExtensions(requested, platform, pathExtValue, pathApi)) {
      const candidate = pathApi.resolve(directory, `${requested}${extension}`);
      if (isExecutable(candidate, platform)) {
        return descriptor(requested, candidate, platform, normalizePath);
      }
    }
  }
  return null;
}

/** Resolve the exact command selected by the product's normal launch path. */
export function resolveProductClaudeLaunchDescriptor({
  env = process.env,
  commandEnvironmentVariable = "RAIL_CONNECTOR_CLAUDE_PATH",
  platform = process.platform,
  pathValue = env.PATH ?? "",
  pathExtValue = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
  isExecutable,
  normalizePath,
} = {}) {
  const configured = env[commandEnvironmentVariable];
  if (configured) {
    const pathApi = platformPath(platform);
    if (!pathApi.isAbsolute(String(configured))) {
      const error = new Error(`${commandEnvironmentVariable} must be an absolute executable path: ${configured}`);
      error.code = "claude_command_override_invalid";
      throw error;
    }
    const resolved = resolveNormalLaunchDescriptor(configured, {
      platform, pathValue, pathExtValue, isExecutable, normalizePath,
    });
    if (!resolved) {
      const error = new Error(`${commandEnvironmentVariable} does not point to an executable file: ${configured}`);
      error.code = "claude_command_override_missing";
      throw error;
    }
    return Object.freeze({ ...resolved, source: "configured_override", configuredOverride: true });
  }
  const resolved = resolveNormalLaunchDescriptor("claude", {
    platform, pathValue, pathExtValue, isExecutable, normalizePath,
  });
  return resolved ? Object.freeze({ ...resolved, source: "path_order", configuredOverride: false }) : null;
}

export function isNormalLaunchWrapper(value) {
  return value?.launchKind === "windows_batch_wrapper"
    && value?.target === null
    && value?.targetProvenance === "unproven_wrapper_target";
}
