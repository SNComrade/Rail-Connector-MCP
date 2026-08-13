import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;

const DEFAULT_COLS = 140;
const DEFAULT_ROWS = 40;
const DEFAULT_SCROLLBACK = 4000;

function terminalText(terminal, lines) {
  const buffer = terminal.buffer.active;
  const requestedLines = Number.isInteger(lines) && lines > 0 ? lines : buffer.length;
  const start = Math.max(0, buffer.length - requestedLines);
  const rendered = [];
  for (let index = start; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    rendered.push(line ? line.translateToString(true) : "");
  }
  return rendered.join("\n").replace(/\n+$/g, "");
}

export function createTerminalRenderer({
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  scrollback = DEFAULT_SCROLLBACK,
} = {}) {
  const terminal = new Terminal({
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
  });
  let pendingWrite = Promise.resolve();

  const write = (data) => {
    pendingWrite = pendingWrite.then(
      () =>
        new Promise((resolve) => {
          terminal.write(String(data), resolve);
        })
    );
    return pendingWrite;
  };

  return {
    write,
    onData(listener) {
      return terminal.onData(listener);
    },
    onBinary(listener) {
      return terminal.onBinary(listener);
    },
    get bracketedPasteMode() {
      return terminal.modes.bracketedPasteMode;
    },
    async capture(lines) {
      await pendingWrite;
      return terminalText(terminal, lines);
    },
    async dispose() {
      await pendingWrite;
      terminal.dispose();
    },
  };
}

export async function renderCapture(raw, options = {}) {
  const renderer = createTerminalRenderer(options);
  try {
    await renderer.write(raw);
    return await renderer.capture(options.lines);
  } finally {
    await renderer.dispose();
  }
}
