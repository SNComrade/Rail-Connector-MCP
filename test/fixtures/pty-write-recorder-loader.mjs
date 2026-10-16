import { register } from "node:module";

// Test only. Loaded into the Windows broker process (through NODE_OPTIONS) by
// test/windows-broker.mjs on Node versions below 22, where a fake terminal run
// by Node cannot see bracketed-paste markers. It records the broker's PTY
// writes so keyword framing can be verified at the broker boundary.
register("./pty-write-recorder-hooks.mjs", import.meta.url);
