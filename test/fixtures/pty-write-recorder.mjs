// Test only: a node-pty spawn that appends every PTY write, in order, with the
// child's process ID, to the file named by RAIL_TEST_PTY_WRITE_RECEIPT.
import fs from "node:fs";
import * as realPty from "node-pty";

const realSpawn = realPty.spawn ?? realPty.default.spawn;
const receipt = process.env.RAIL_TEST_PTY_WRITE_RECEIPT || "";

export function spawn(...args) {
  const ptyProcess = realSpawn(...args);
  const write = ptyProcess.write.bind(ptyProcess);
  ptyProcess.write = (data) => {
    if (receipt) {
      fs.appendFileSync(receipt, `${JSON.stringify({ pid: ptyProcess.pid, data: String(data) })}\n`);
    }
    return write(data);
  };
  return ptyProcess;
}
