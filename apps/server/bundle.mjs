/**
 * Produce a self-contained server for the packaged desktop app.
 *
 * The dev path runs `dist/index.js` straight out of the workspace, where pnpm
 * has linked everything. A packaged .app has no workspace, so the whole core is
 * bundled into one file. better-sqlite3 is a native addon and cannot be
 * inlined, so it is copied next to the bundle instead.
 */

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist-bundle");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(here, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: join(out, "index.js"),
  external: ["better-sqlite3"],
  // Some deps reference CJS globals; provide them in the ESM output.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __ftp } from 'node:url';",
      "import { dirname as __dn } from 'node:path';",
      "const require = __cr(import.meta.url);",
      "const __filename = __ftp(import.meta.url);",
      "const __dirname = __dn(__filename);",
    ].join("\n"),
  },
  logLevel: "info",
});

// Ship the native addon and its runtime deps beside the bundle. pnpm stores
// packages in an isolated content-addressed tree, so the real locations are
// found by resolution rather than by guessing a node_modules path.
const nm = join(out, "node_modules");
mkdirSync(nm, { recursive: true });

const requireFromCore = createRequire(
  join(here, "../../packages/core/package.json"),
);

/** Directory a package actually lives in, via its package.json. */
function packageDir(name, from = requireFromCore) {
  const json = from.resolve(`${name}/package.json`);
  return dirname(json);
}

const copied = new Set();
function copyPackage(name, from) {
  if (copied.has(name)) return;
  let dir;
  try {
    dir = packageDir(name, from);
  } catch {
    return;
  }
  cpSync(dir, join(nm, name), { recursive: true, dereference: true });
  copied.add(name);

  // Follow runtime dependencies so the copied tree is complete.
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const next = createRequire(join(dir, "package.json"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    copyPackage(dep, next);
  }
}

copyPackage("better-sqlite3");
console.log(`native deps copied: ${[...copied].join(", ")}`);

console.log(`bundled → ${out}`);
