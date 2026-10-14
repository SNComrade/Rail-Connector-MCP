import { register } from "node:module";

// module.register is available throughout the repository's Node 20/22/24 CI
// matrix. The synchronous registerHooks API is unavailable on Node 20.
register("./stubborn-pty-hooks.mjs", import.meta.url);
