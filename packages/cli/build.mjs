// Build script for the published `etherfind` package.
//
// The npm package must be self-contained: `npx etherfind` downloads exactly
// one tarball with zero runtime dependencies (no npm org required for
// @etherfind/core — the core library is bundled). The repo keeps the
// core/CLI workspace split for development; only the published artifact is
// merged.
import { rmSync } from "node:fs";
import { build } from "esbuild";

// Fresh output; the old tsc emit used to leave stray files here.
rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  legalComments: "none",
  // Keep node builtins external; @etherfind/core, ink and react are bundled.
  packages: "bundle",
  // ink imports react-devtools-core statically in its DEV-mode helper; the
  // CLI never runs with ink's DEV flag, so alias it to a stub instead of
  // shipping the devtools dependency.
  external: ["react-devtools-core"],
  alias: {
    "react-devtools-core": "./src/stub-devtools.js",
  },
  // Bundled CJS deps (e.g. signal-exit, used by ink) call require() for node
  // builtins like "assert". esbuild's ESM output rewrites every require()
  // into a shim that only delegates to a real `require` if one is in scope —
  // and in pure ESM there is none, so it throws "Dynamic require of ... is
  // not supported" instead. Defining `require` via createRequire gives that
  // shim something real to delegate to. esbuild inserts banner.js after the
  // shebang (verified in dist/cli.js), so this does not produce a second one.
  banner: {
    js: "import { createRequire as __etherfindCreateRequire } from 'node:module';\nconst require = __etherfindCreateRequire(import.meta.url);",
  },
});
