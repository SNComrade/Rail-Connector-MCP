// Used only by windows-broker-timeout.mjs. The broker sees a PTY whose first
// kill request does not report exit, then whose second request does.
const mockPty = `
export function spawn() {
  let onExit = () => {};
  let killCount = 0;
  return {
    pid: 424242,
    onData() {},
    onExit(callback) { onExit = callback; },
    write() {},
    kill() {
      killCount += 1;
      if (killCount === 2) queueMicrotask(() => onExit({ exitCode: 1 }));
    },
  };
}
`;
const mockUrl = `data:text/javascript,${encodeURIComponent(mockPty)}`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node-pty") {
    return { url: mockUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
