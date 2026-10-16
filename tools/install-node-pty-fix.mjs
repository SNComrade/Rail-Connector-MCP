import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export const nodePtyFixSpecPath = fileURLToPath(new URL("../patches/node-pty-1.2.0-beta.15-readiness.json", import.meta.url));
// Resolve from the broker's location so validation covers its actual dependency,
// including ordinary npm hoisting. Resolution reads metadata; it loads no PTY.
const brokerRequire = createRequire(new URL("../src/windows-broker.js", import.meta.url));
const defaultPackageRoot = () => path.dirname(brokerRequire.resolve("node-pty/package.json"));
const permittedFiles = new Set(["lib/windowsTerminal.js", "lib/windowsPtyAgent.js", "typings/node-pty.d.ts"]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function refuse(message) {
  const error = new Error(`node-pty compatibility fix: ${message}. Run the reviewed checkout's npm ci; do not hand-edit the dependency.`);
  error.code = "EPTYCOMPAT";
  throw error;
}

function plainDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("linked or non-directory dependency path");
}

function readPlainFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) refuse("linked or non-regular dependency file");
  return { bytes: fs.readFileSync(file), mode: stat.mode & 0o777 };
}

function inspect(packageRoot) {
  const root = path.resolve(packageRoot);
  plainDirectory(path.dirname(root));
  plainDirectory(root);
  const spec = JSON.parse(fs.readFileSync(nodePtyFixSpecPath, "utf8"));
  const metadata = JSON.parse(readPlainFile(path.join(root, "package.json")).bytes);
  if (spec.format !== 1 || spec.package !== "node-pty" || spec.version !== "1.2.0-beta.15" ||
      metadata.name !== spec.package || metadata.version !== spec.version || spec.patches.length !== 3) {
    refuse("unsupported package or fix specification");
  }
  const seen = new Set();
  const files = spec.patches.map((patch) => {
    if (!permittedFiles.has(patch.path) || seen.has(patch.path) ||
        !/^[a-f0-9]{64}$/.test(patch.sha256Before) || !/^[a-f0-9]{64}$/.test(patch.sha256After)) {
      refuse("unsupported fix target");
    }
    seen.add(patch.path);
    const target = path.join(root, patch.path);
    plainDirectory(path.dirname(target));
    const original = readPlainFile(target);
    const actualHash = sha256(original.bytes);
    if (actualHash === patch.sha256After) return { target, path: patch.path, state: "patched", ...original };
    if (actualHash !== patch.sha256Before) refuse(`unrecognized upstream bytes in ${patch.path}`);
    let text = original.bytes.toString("utf8");
    for (const { from, to } of patch.replacements) {
      if (!from || text.split(from).length !== 2) refuse(`fix anchor mismatch in ${patch.path}`);
      text = text.replace(from, to);
    }
    const replacement = Buffer.from(text);
    if (sha256(replacement) !== patch.sha256After) refuse(`fix output mismatch in ${patch.path}`);
    return { target, path: patch.path, state: "unpatched", replacement, ...original };
  });
  return { spec, files };
}

export function verifyNodePtyFix({ packageRoot = defaultPackageRoot() } = {}) {
  const { spec, files } = inspect(packageRoot);
  if (files.some((file) => file.state !== "patched")) refuse("required readiness-budget fix is not installed");
  return { fix: spec.fix, version: spec.version, verifiedFiles: files.map((file) => file.path) };
}

export function applyNodePtyFix({ packageRoot = defaultPackageRoot() } = {}) {
  // Validate every source before the first write. A partial interrupted install
  // can be completed only when each target matches an exact known before/after
  // hash; arbitrary dependency edits are never adopted.
  const { spec, files } = inspect(packageRoot);
  let appliedFiles = 0;
  for (const file of files) {
    if (file.state === "patched") continue;
    const temporary = `${file.target}.readiness-${randomUUID()}.tmp`;
    let descriptor;
    let ownsTemporary = false;
    let primaryError;
    const cleanupErrors = [];
    try {
      descriptor = fs.openSync(temporary, "wx", file.mode);
      ownsTemporary = true;
      fs.writeFileSync(descriptor, file.replacement);
      fs.closeSync(descriptor);
      descriptor = undefined;
      // Recheck the owned destination immediately before replacing it. These
      // cooperative checks are not a sandbox against concurrent hostile writes.
      if (!readPlainFile(file.target).bytes.equals(file.bytes)) refuse(`dependency changed during install: ${file.path}`);
      fs.renameSync(temporary, file.target);
      ownsTemporary = false;
      appliedFiles++;
    } catch (error) {
      primaryError = error;
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (error) { cleanupErrors.push(error); }
      }
      if (ownsTemporary) {
        try { fs.unlinkSync(temporary); }
        catch (error) { if (error.code !== "ENOENT") cleanupErrors.push(error); }
      }
    }
    if (primaryError && cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], "Compatibility install and owned staging cleanup failed", { cause: primaryError });
    if (primaryError) throw primaryError;
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Owned compatibility staging cleanup failed");
  }
  verifyNodePtyFix({ packageRoot });
  return { fix: spec.fix, version: spec.version, appliedFiles, verifiedFiles: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(applyNodePtyFix()));
}
