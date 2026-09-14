#!/usr/bin/env node
// Builds dist/server.js — one file, SDK inlined, minified, no sourcemap.
//
// Why bundle at all when the source is only a bridge: so `npx -y
// stockportfolio-mcp` works with nothing to install. The MCP SDK is inlined
// rather than declared as a dependency, which is why it lives in
// devDependencies — a consumer's npm install pulls no packages at all.
//
// The published entry is dist/server.js, not src/bridge.js: `files: ["dist"]`
// in package.json means the tarball carries the build output only.

import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = require(path.join(packageRoot, 'package.json'));
const { VERSION } = await import(path.join(packageRoot, 'src/version.js'));

// The bridge reports VERSION to MCP clients; npm reports pkg.version to
// consumers. If they drift, users get a bug report naming the wrong build, so
// the build refuses rather than shipping the mismatch.
if (VERSION !== pkg.version) {
  console.error(
    `::error:: src/version.js says ${VERSION} but package.json says ${pkg.version}. ` +
      'Update both, then rebuild.'
  );
  process.exit(1);
}

const outfile = path.join(packageRoot, 'dist/server.js');

await build({
  entryPoints: [path.join(packageRoot, 'src/bridge.js')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  // The entry's shebang is hoisted by esbuild; a banner here would duplicate it.
  banner: {
    js: `// stockportfolio-mcp v${pkg.version} — stdio bridge to https://www.stockportfolio.pro/mcp\n// Source: https://stockportfolio.pro/api  ·  License: UNLICENSED (all rights reserved)\n// This build inlines its dependencies; the file is generated, not hand-edited.`,
  },
  define: { 'process.env.NODE_ENV': '"production"' },
});

fs.chmodSync(outfile, 0o755);

const bytes = fs.statSync(outfile).size;
console.log(`built dist/server.js — ${(bytes / 1024).toFixed(1)} KB, v${pkg.version}`);
