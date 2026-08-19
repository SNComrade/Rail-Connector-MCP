import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const WINDOWS_BROKER_PROTOCOL = 1;
export const WINDOWS_BROKER_VERSION = "1.0.0-beta.2+broker.2";
const BROKER_START_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_BROKER_LOG_BYTES = 2 * 1024 * 1024;
const BROKER_READY_CACHE_TTL_MS = 1000;
const COMPATIBILITY_CLEANUP_OPERATIONS = new Set([
  "acquireCleanupLease",
  "releaseCleanupLease",
  "cleanupStop",
]);
const BROKER_SCRIPT = fileURLToPath(new URL("./windows-broker.js", import.meta.url));
const readyBrokerCache = new Map();

export function railConnectorStateDir(env = process.env) {
  return path.resolve(
    env.RAIL_CONNECTOR_STATE_DIR || path.join(os.homedir(), ".rail-connector-mcp", "state", "v1")
  );
}

export function windowsBrokerLaunchPolicyFingerprint(env = process.env) {
  const configured = String(env.RAIL_CONNECTOR_CLAUDE_PATH || "").trim();
  let policy = "basename:claude";
  if (configured) {
    const resolved = path.resolve(configured);
    let canonical = resolved;
    try {
      canonical =
        fs.realpathSync.native?.(resolved) ?? fs.realpathSync(resolved);
    } catch {
      // The broker will reject an unreadable configured command at launch.
    }
    policy = `configured:${canonical.toLowerCase()}`;
  }
  return createHash("sha256").update(policy).digest("hex").slice(0, 24);
}

function brokerIdentity(stateDir, token = "") {
  return createHash("sha256")
    .update(`${os.userInfo().username}\0${stateDir.toLowerCase()}\0${token}`)
    .digest("hex")
    .slice(0, 24);
}

export function windowsBrokerPaths(env = process.env, token = "") {
  const stateDir = railConnectorStateDir(env);
  const identity = brokerIdentity(stateDir, token);
  return {
    stateDir,
    pipeName:
      process.platform === "win32"
        ? `\\\\.\\pipe\\rail-connector-${identity}`
        : path.join(os.tmpdir(), `rail-connector-${identity}.sock`),
    tokenFile: path.join(stateDir, "broker-token"),
    startLock: path.join(stateDir, "broker-start.lock"),
  };
}

function ensureBrokerToken(paths) {
  fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const existing = fs.readFileSync(paths.tokenFile, "utf8").trim();
      if (existing.length >= 32) return existing;
      try {
        fs.unlinkSync(paths.tokenFile);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const token = randomBytes(32).toString("hex");
    try {
      fs.writeFileSync(paths.tokenFile, `${token}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return token;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Unable to establish a valid Windows broker token file: ${paths.tokenFile}`);
}

function requestOnce(
  paths,
  token,
  operation,
  payload,
  timeoutMs,
  launchPolicyFingerprint
) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.pipeName);
    let response = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`Windows broker request timed out: ${operation}`);
      error.code = "ETIMEDOUT";
      finish(error);
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          protocol: WINDOWS_BROKER_PROTOCOL,
          clientVersion: WINDOWS_BROKER_VERSION,
          launchPolicyFingerprint,
          token,
          operation,
          payload,
        })}\n`
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
        const error = new Error("Windows broker response exceeded the maximum size.");
        error.code = "EMSGSIZE";
        finish(error);
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(response.slice(0, newline));
        if (!parsed.ok) {
          const error = new Error(parsed.error || `Windows broker operation failed: ${operation}`);
          error.code = parsed.code || "EBROKER";
          finish(error);
        } else {
          finish(null, parsed.result);
        }
      } catch (error) {
        finish(new Error(`Invalid Windows broker response: ${error.message}`));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      if (!settled && !response.includes("\n")) {
        const error = new Error(
          `Windows broker closed without a response: ${operation}`
        );
        error.code = "ECONNRESET";
        finish(error);
      }
    });
  });
}

function isBrokerUnavailable(error) {
  return [
    "ENOENT",
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "EPIPE",
  ].includes(error?.code);
}

function brokerReadyCacheKey(paths, launchPolicyFingerprint) {
  return `${paths.pipeName}\0${launchPolicyFingerprint}`;
}

function rememberReadyBroker(paths, launchPolicyFingerprint) {
  const pipePrefix = `${paths.pipeName}\0`;
  for (const key of readyBrokerCache.keys()) {
    if (key.startsWith(pipePrefix)) readyBrokerCache.delete(key);
  }
  readyBrokerCache.set(
    brokerReadyCacheKey(paths, launchPolicyFingerprint),
    Date.now() + BROKER_READY_CACHE_TTL_MS
  );
}

function recentlyVerifiedBroker(paths, launchPolicyFingerprint) {
  const key = brokerReadyCacheKey(paths, launchPolicyFingerprint);
  const expiresAt = readyBrokerCache.get(key) ?? 0;
  if (expiresAt > Date.now()) return true;
  readyBrokerCache.delete(key);
  return false;
}

function forgetReadyBroker(paths) {
  const pipePrefix = `${paths.pipeName}\0`;
  for (const key of readyBrokerCache.keys()) {
    if (key.startsWith(pipePrefix)) readyBrokerCache.delete(key);
  }
}

function assertCompatibleBroker(status, launchPolicyFingerprint) {
  if (
    status.version !== WINDOWS_BROKER_VERSION ||
    status.launchPolicyFingerprint !== launchPolicyFingerprint
  ) {
    const error = new Error(
      "Windows broker build or Claude launch policy does not match this MCP process."
    );
    error.code = "EBROKERUPGRADE";
    throw error;
  }
  return status;
}

async function waitForBroker(paths, token, launchPolicyFingerprint) {
  const deadline = Date.now() + BROKER_START_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return assertCompatibleBroker(
        await requestOnce(
          paths,
          token,
          "ping",
          {},
          1500,
          launchPolicyFingerprint
        ),
        launchPolicyFingerprint
      );
    } catch (error) {
      if (error?.code === "EBROKERUPGRADE") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Windows broker did not become ready: ${lastError?.message || "unknown error"}`);
}

async function startBroker(
  paths,
  token,
  env = process.env,
  retryStaleLock = true
) {
  const launchPolicyFingerprint =
    windowsBrokerLaunchPolicyFingerprint(env);
  let lockHandle = null;
  try {
    lockHandle = fs.openSync(paths.startLock, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  if (lockHandle !== null) {
    let logHandle = null;
    try {
      const logPath = path.join(paths.stateDir, "broker.log");
      const previousLogPath = `${logPath}.1`;
      try {
        if (fs.statSync(logPath).size > MAX_BROKER_LOG_BYTES) {
          fs.rmSync(previousLogPath, { force: true });
          fs.renameSync(logPath, previousLogPath);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      logHandle = fs.openSync(logPath, "a", 0o600);
      const child = spawn(
        process.execPath,
        [BROKER_SCRIPT, "--pipe", paths.pipeName, "--token-file", paths.tokenFile],
        {
          detached: true,
          stdio: ["ignore", logHandle, logHandle],
          windowsHide: true,
          cwd: path.dirname(BROKER_SCRIPT),
          env: { ...env },
        }
      );
      child.unref();
      fs.closeSync(logHandle);
      logHandle = null;
      return await waitForBroker(
        paths,
        token,
        launchPolicyFingerprint
      );
    } finally {
      if (logHandle !== null) fs.closeSync(logHandle);
      fs.closeSync(lockHandle);
      try {
        fs.unlinkSync(paths.startLock);
      } catch {
        // Another starter may already have cleared a stale lock.
      }
    }
  }

  try {
    return await waitForBroker(paths, token, launchPolicyFingerprint);
  } catch (error) {
    let removedStaleLock = false;
    try {
      const stat = fs.statSync(paths.startLock);
      if (Date.now() - stat.mtimeMs > BROKER_START_TIMEOUT_MS * 2) {
        fs.unlinkSync(paths.startLock);
        removedStaleLock = true;
      }
    } catch {
      // The competing starter cleared the lock.
    }
    if (removedStaleLock && retryStaleLock) {
      return startBroker(paths, token, env, false);
    }
    throw error;
  }
}

async function stopInactiveBroker(
  paths,
  token,
  launchPolicyFingerprint
) {
  forgetReadyBroker(paths);
  const status = await requestOnce(
    paths,
    token,
    "status",
    {},
    2000,
    launchPolicyFingerprint
  );
  if (status.managedSessions?.some((session) => !session.exited)) {
    const error = new Error(
      "A previous Rail Connector broker build still owns active sessions. Stop those sessions with the prior MCP process, then retry so the broker can be upgraded without losing them."
    );
    error.code = "EBROKERUPGRADE";
    throw error;
  }
  await requestOnce(
    paths,
    token,
    "shutdown",
    {},
    5000,
    launchPolicyFingerprint
  );
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await requestOnce(
        paths,
        token,
        "ping",
        {},
        500,
        launchPolicyFingerprint
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      if (isBrokerUnavailable(error)) return;
      if (!["ETIMEDOUT", "ESHUTDOWN"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const error = new Error("Previous Rail Connector broker did not shut down for upgrade.");
  error.code = "EBROKERUPGRADE";
  throw error;
}

async function readyBrokerPaths(env, startIfMissing) {
  const tokenPaths = windowsBrokerPaths(env);
  const token = ensureBrokerToken(tokenPaths);
  const paths = windowsBrokerPaths(env, token);
  const launchPolicyFingerprint =
    windowsBrokerLaunchPolicyFingerprint(env);
  if (recentlyVerifiedBroker(paths, launchPolicyFingerprint)) {
    return { paths, token, launchPolicyFingerprint };
  }
  try {
    const ping = await requestOnce(
      paths,
      token,
      "ping",
      {},
      1500,
      launchPolicyFingerprint
    );
    if (
      ping.version !== WINDOWS_BROKER_VERSION ||
      ping.launchPolicyFingerprint !== launchPolicyFingerprint
    ) {
      if (!startIfMissing) {
        const error = new Error(
          `Windows broker build or Claude launch policy does not match this MCP process.`
        );
        error.code = "EBROKERUPGRADE";
        throw error;
      }
      await stopInactiveBroker(paths, token, launchPolicyFingerprint);
      await startBroker(paths, token, env);
    }
    rememberReadyBroker(paths, launchPolicyFingerprint);
    return { paths, token, launchPolicyFingerprint };
  } catch (error) {
    if (!isBrokerUnavailable(error)) throw error;
  }

  if (!startIfMissing) {
    const error = new Error(`No Windows broker is listening at ${paths.pipeName}.`);
    error.code = "ENOENT";
    throw error;
  }
  await startBroker(paths, token, env);
  rememberReadyBroker(paths, launchPolicyFingerprint);
  return { paths, token, launchPolicyFingerprint };
}

export async function windowsBrokerRequest(
  operation,
  payload = {},
  { startIfMissing = true, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, env = process.env } = {}
) {
  const { paths, token, launchPolicyFingerprint } =
    await readyBrokerPaths(env, startIfMissing);
  try {
    const result = await requestOnce(
      paths,
      token,
      operation,
      payload,
      timeoutMs,
      launchPolicyFingerprint
    );
    if (operation === "shutdown") forgetReadyBroker(paths);
    return result;
  } catch (error) {
    if (isBrokerUnavailable(error)) forgetReadyBroker(paths);
    throw error;
  }
}

export async function windowsBrokerCleanupRequest(
  operation,
  payload = {},
  { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, env = process.env } = {}
) {
  if (!COMPATIBILITY_CLEANUP_OPERATIONS.has(operation)) {
    const error = new Error(
      `Unsupported Windows broker compatibility cleanup operation: ${operation}`
    );
    error.code = "EINVAL";
    throw error;
  }
  const tokenPaths = windowsBrokerPaths(env);
  let token;
  try {
    token = fs.readFileSync(tokenPaths.tokenFile, "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      const unavailable = new Error("No Windows broker token is available.");
      unavailable.code = "ENOENT";
      throw unavailable;
    }
    throw error;
  }
  if (token.length < 32) {
    const error = new Error("The Windows broker token is invalid.");
    error.code = "EAUTH";
    throw error;
  }
  const paths = windowsBrokerPaths(env, token);
  try {
    return await requestOnce(
      paths,
      token,
      operation,
      payload,
      timeoutMs,
      windowsBrokerLaunchPolicyFingerprint(env)
    );
  } catch (error) {
    if (isBrokerUnavailable(error)) forgetReadyBroker(paths);
    throw error;
  }
}

export async function probeWindowsBroker(env = process.env) {
  const tokenPaths = windowsBrokerPaths(env);
  let token;
  try {
    token = fs.readFileSync(tokenPaths.tokenFile, "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (token.length < 32) return null;
  const paths = windowsBrokerPaths(env, token);
  const launchPolicyFingerprint =
    windowsBrokerLaunchPolicyFingerprint(env);
  try {
    const status = await requestOnce(
      paths,
      token,
      "status",
      {},
      2000,
      launchPolicyFingerprint
    );
    const result = {
      ...status,
      compatible:
        status.version === WINDOWS_BROKER_VERSION &&
        status.launchPolicyFingerprint === launchPolicyFingerprint,
      launchPolicyCompatible:
        status.launchPolicyFingerprint === launchPolicyFingerprint,
      legacyPipe: false,
    };
    if (result.compatible) rememberReadyBroker(paths, launchPolicyFingerprint);
    else forgetReadyBroker(paths);
    return result;
  } catch (error) {
    if (isBrokerUnavailable(error)) {
      forgetReadyBroker(paths);
      return null;
    }
    throw error;
  }
}
