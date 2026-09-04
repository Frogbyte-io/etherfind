#!/usr/bin/env node
// Regression check for a bug that shipped in etherfind@0.1.0: esbuild's ESM
// bundle rewrites every require() call from bundled CJS deps (e.g. ink's
// signal-exit) into a shim that only works if a real `require` is already in
// scope. Pure ESM has none, so the very first real terminal to reach
// `await import("ink")` crashed with "Dynamic require of ... is not
// supported". --version, --help and --simulate --json never load ink, so no
// existing smoke test caught it before publish.
//
// This fakes just enough of a TTY to force the CLI down the ink import path
// without needing a real pty. Getting past that import is all this checks —
// it does not assert the TUI renders correctly, which needs a real terminal.
import { pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) {
  console.error("usage: verify-tui-import.mjs <path-to-cli.js>");
  process.exit(2);
}

process.stdout.isTTY = true;
process.stdin.isTTY = true;
process.argv = [process.argv[0], target, "--simulate"];

setTimeout(() => {
  console.log("OK: ink import path did not hit the dynamic-require bug");
  process.exit(0);
}, 2000);

try {
  await import(pathToFileURL(target).href);
} catch (err) {
  if (String(err?.message).includes("Dynamic require")) {
    console.error("FAIL:", err.message);
    process.exit(1);
  }
  // Any other failure here is an artifact of faking a TTY without a real
  // pty (e.g. ink calling stdin.ref()); not what this check targets.
}
