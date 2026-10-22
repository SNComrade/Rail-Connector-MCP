// Test-only preload: real PTYs and sockets, with deterministic owned faults.
// Inherited fake-terminal processes do not satisfy the broker argv guard.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const broker = fileURLToPath(new URL("../../src/windows-broker.js", import.meta.url));
const directory = process.env.RAIL_TEST_BROKER_ERROR_DIR;
if (process.env.NODE_ENV === "test" && process.argv[1] &&
    path.resolve(process.argv[1]) === broker && directory) {
  const root = fs.realpathSync(directory);
  if (path.dirname(root).toLowerCase() !== fs.realpathSync(os.tmpdir()).toLowerCase() ||
      !path.basename(root).startsWith("rail-connector-broker-")) {
    throw new Error("Broker fault preload requires its dedicated temporary directory.");
  }
  const control = path.join(root, "broker-error-control.json");
  const receipt = path.join(root, "broker-error-receipts.jsonl");
  const terminals = new Map();
  const pty = createRequire(import.meta.url)("node-pty");
  const spawn = pty.spawn;
  pty.spawn = function (file, args, options) {
    const terminal = spawn.call(this, file, args, options);
    const tag = options?.env?.RAIL_TEST_BROKER_ERROR_TARGET;
    if (tag) {
      const entry = { terminal, holdExit: false, exits: [], listener: null, nativeExitCode: null, socketFault: false };
      terminals.set(tag, entry);
      const agent = terminal._agent;
      if (typeof agent?._$onProcessExit !== "function") throw new Error("Missing pinned native exit observation seam.");
      const nativeExit = agent._$onProcessExit;
      agent._$onProcessExit = function (exitCode) {
        if (Number.isInteger(exitCode)) {
          entry.nativeExitCode = exitCode;
          fs.appendFileSync(receipt, JSON.stringify({ kind: "nativeExitObserved", target: tag, exitCode }) + "\n");
        }
        return nativeExit.call(this, exitCode);
      };
      const write = terminal.write;
      terminal.write = function (data) {
        // Synthetic prompts only, inside this exact-owned fake-terminal broker.
        fs.appendFileSync(receipt, JSON.stringify({ kind: "ptyWrite", target: tag, data: String(data) }) + "\n");
        const result = write.call(this, data);
        if (!fs.existsSync(control)) return result;
        const command = JSON.parse(fs.readFileSync(control, "utf8"));
        if (command.stage !== "write" || command.target !== tag || command.afterWrite !== data) return result;
        if (command.kind !== "terminalWrite" || typeof command.asynchronous !== "boolean") {
          throw new Error("Invalid owned send-race fault.");
        }
        fs.unlinkSync(control);
        const fault = () => {
          const error = Object.assign(new Error("private-error-message-must-not-leak"), { code: command.code });
          terminal.emit("error", error);
          fs.appendFileSync(receipt, JSON.stringify({ id: command.id, kind: command.kind,
            stage: "write", target: tag, afterWrite: String(data), asynchronous: command.asynchronous }) + "\n");
        };
        if (command.asynchronous) setImmediate(fault);
        else fault();
        return result;
      };
      const onExit = terminal.onExit;
      Object.defineProperty(terminal, "onExit", { value(listener) {
        entry.listener = listener;
        return onExit((event) => {
          fs.appendFileSync(receipt, JSON.stringify({ kind: "onExitObserved", target: tag,
            numeric: Number.isInteger(event.exitCode), exitCode: event.exitCode ?? null, held: entry.holdExit }) + "\n");
          if (entry.holdExit) {
            entry.exits.push(event);
            fs.appendFileSync(receipt, JSON.stringify({ kind: "actualExitBuffered", target: tag, exitCode: event.exitCode }) + "\n");
          }
          else listener(event);
        });
      } });
    }
    return terminal;
  };
  function inject(stage, socket, response) {
    if (!fs.existsSync(control)) return;
    const command = JSON.parse(fs.readFileSync(control, "utf8"));
    if (command.stage !== stage) return;
    fs.unlinkSync(control);
    const error = Object.assign(new Error("private-error-message-must-not-leak"), {
      code: command.code,
    });
    let observedExit = null;
    if (command.kind === "disarm") {
      for (const entry of terminals.values()) {
        entry.holdExit = false;
        for (const event of entry.exits.splice(0)) entry.listener(event);
      }
    } else if (command.kind === "cleanupNativeExits") {
      // Called only after the controller's authenticated retained-handle ledger
      // has reaped its owned fixtures. This is a synthetic test cleanup bridge,
      // not a production onExit callback or a product recovery mechanism.
      for (const [target, entry] of terminals) {
        if (!entry.socketFault || !Number.isInteger(entry.nativeExitCode)) continue;
        entry.listener({ exitCode: entry.nativeExitCode });
        fs.appendFileSync(receipt, JSON.stringify({ kind: "syntheticNativeExitCleanup", target,
          exitCode: entry.nativeExitCode, synthetic: true }) + "\n");
      }
    } else if (command.kind === "socket") {
      socket.emit("error", error);
      socket.emit("error", error);
    } else {
      const entry = terminals.get(command.target);
      if (!entry?.listener) throw new Error("Missing owned fault target.");
      if (command.kind === "terminal") {
        entry.holdExit = true;
        entry.terminal.emit("error", error);
        entry.terminal.emit("error", error);
      } else if (command.kind === "outputSocket" || command.kind === "inputSocket") {
        if (entry.holdExit) throw new Error("Actual socket destruction must not hold onExit.");
        entry.socketFault = true;
        const channel = command.kind === "outputSocket" ? entry.terminal._socket : entry.terminal._agent.inSocket;
        if (!(channel instanceof net.Socket)) throw new Error("Missing actual pinned PTY socket.");
        channel.destroy(error);
      } else if (command.kind === "releaseExit") {
        if (!entry.exits.length || !Number.isInteger(entry.exits[0].exitCode)) throw new Error("No numeric actual owned exit to release.");
        entry.holdExit = false;
        observedExit = entry.exits[0].exitCode;
        for (const event of entry.exits.splice(0)) entry.listener(event);
        // Duplicate callback and a later error must not overwrite exit evidence.
        entry.listener({ exitCode: 197 });
        entry.terminal.emit("error", error);
      } else throw new Error("Unknown owned fault kind.");
    }
    fs.appendFileSync(receipt, JSON.stringify({
      id: command.id, kind: command.kind, stage, destroyed: socket.destroyed,
      responseOk: response ? JSON.parse(String(response)).ok : null,
      observedExit,
    }) + "\n");
  }
  const createServer = net.createServer;
  net.createServer = function (listener) {
    return createServer.call(this, (socket) => {
      const setEncoding = socket.setEncoding;
      socket.setEncoding = function (...args) {
        inject("setup", socket);
        return setEncoding.apply(this, args);
      };
      const end = socket.end;
      socket.end = function (...args) {
        inject("reply", socket, args[0]);
        return end.apply(this, args);
      };
      listener(socket);
    });
  };
}
