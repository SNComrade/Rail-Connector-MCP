// Test only: route the broker's "node-pty" import through a recording wrapper.
// The wrapper itself imports the real node-pty.
const wrapperUrl = new URL("./pty-write-recorder.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node-pty" && context.parentURL !== wrapperUrl) {
    return { url: wrapperUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
