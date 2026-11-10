import { register } from "node:module";

// Asynchronous hooks retain compatibility with the repository's Node 22.13 CI.
// All mutation code remains opt-in and isolated to these diagnostic processes.
register(new URL("./mutation-hooks.mjs", import.meta.url), import.meta.url);
