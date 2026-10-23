import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;

const DEFAULT_COLS = 140;
const DEFAULT_ROWS = 40;
const DEFAULT_SCROLLBACK = 4000;

const TERMINAL_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u;

function terminalControlFreeText(text) {
  return typeof text === "string" && !TERMINAL_CONTROL_RE.test(text);
}

export function assertFramedPromptText(text) {
  if (!terminalControlFreeText(text)) {
    const error = new Error("Framed prompt text must contain no terminal control characters other than tab, newline, or carriage return.");
    error.code = "EINVAL";
    throw error;
  }
  return text;
}

// Explicit transport intent, never inferred from quoted/pasted prompt contents.
export function workflowKeywordPrefixLength(text) {
  if (
    !terminalControlFreeText(text) ||
    !text.startsWith("ultracode:") ||
    !text.slice(10).trim()
  ) {
    const error = new Error(
      "Keyword delivery requires an intentional leading ultracode: prefix, a nonempty body, and no terminal control characters."
    );
    error.code = "EINVAL";
    throw error;
  }
  return 10;
}

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
    async flush() {
      await pendingWrite;
    },
    async capture(lines) {
      await pendingWrite;
      return terminalText(terminal, lines);
    },
    async cursorLineStyle() {
      await pendingWrite;
      const buffer = terminal.buffer.active;
      const line = buffer.getLine(buffer.baseY + buffer.cursorY);
      if (!line) return null;
      const spans = [];
      for (let column = 0; column < terminal.cols; column += 1) {
        const cell = line.getCell(column);
        if (!cell?.getChars()?.trim()) continue;
        const style = { dim: Boolean(cell.isDim()), italic: Boolean(cell.isItalic()), inverse: Boolean(cell.isInverse()), fgMode: cell.getFgColorMode(), fg: cell.getFgColor(), bgMode: cell.getBgColorMode(), bg: cell.getBgColor() };
        const previous = spans.at(-1);
        if (previous && previous.end === column && JSON.stringify(previous.style) === JSON.stringify(style)) previous.end += cell.getWidth();
        else spans.push({ start: column, end: column + cell.getWidth(), style });
      }
      // Read-only diagnostics: no input text or terminal escapes leave the renderer.
      return { cursorX: buffer.cursorX, spans };
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
