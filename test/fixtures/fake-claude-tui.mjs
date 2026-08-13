process.stdin.setEncoding("utf8");
if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);

let input = "";
process.stdout.write(
  "\x1b[>0q\x1b[?2004hFake Claude TUI\r\nhttps://claude.ai/code/fake_tui\r\n> "
);

process.stdin.on("data", (chunk) => {
  input += chunk.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
  for (;;) {
    const submit = input.search(/[\r\n]/);
    if (submit < 0) break;
    const command = input.slice(0, submit).trim();
    input = input.slice(submit + 1);
    if (command === "/exit") {
      if (process.env.RAIL_CONNECTOR_FAKE_CLAUDE_IGNORE_EXIT === "1") {
        process.stdout.write("\r\nIGNORED_EXIT\r\n> ");
        continue;
      }
      process.stdout.write("\r\nGoodbye\r\n");
      process.exit(0);
    }
    process.stdout.write(`\r\nACK:${command}\r\n> `);
  }
});
