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
  // Note: the shebang in src/cli.ts is preserved automatically — do not add
  // a banner, or the output ends up with two and Node rejects it.
});
