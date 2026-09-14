#!/usr/bin/env node
// Fails the publish if anything that must stay private ends up in the tarball.
//
// This is the boundary where a mistake becomes permanent (npm versions cannot
// be unpublished after 72 hours) — regardless of whether this package's own
// repo is public or private, since the tarball ships independently of that.
// It runs from `prepack`, which npm invokes for both `npm pack` and
// `npm publish`, so it cannot be skipped by publishing a different way.
//
// Two classes of leak are checked:
//   1. The AI provider's identity, which is a trade secret — ai-client.js
//      carries regex backstops for the same words.
//   2. Anything backend-shaped: secrets, database URIs, or an import that would
//      drag server code into a package that is supposed to be a thin bridge.
//
// stockportfolio.pro itself is NOT a leak — pointing at the hosted endpoint is
// the entire job of this package. Only provider identity and secrets are.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(packageRoot, 'dist/server.js');

if (!fs.existsSync(target)) {
  console.error('::error:: dist/server.js does not exist — run `npm run build` first.');
  process.exit(1);
}

const source = fs.readFileSync(target, 'utf8');

const PATTERNS = [
  { what: 'AI provider identity', re: /\bollama\b|\bglm[-_ ]?\d|\bzhipu\b|\bmoonshot\b|\bdeepseek\b|\bminimax\b|\bqwen\b|\bmistral\b|\bgemini\b/i },
  { what: 'AI provider identity (labs)', re: /\bopenai\b|\banthropic\b|\bclaude-\d|\bgpt-\d|\bgpt-\d/i },
  { what: 'model ids / keys', re: /\bsk-[a-z0-9]{8,}|OLLAMA_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY/i },
  { what: 'payment secrets', re: /sk_live_|sk_test_|STRIPE_SECRET|whsec_/ },
  { what: 'database / session secrets', re: /mongodb(\+srv)?:\/\/|MONGODB_URI|JWT_SECRET|SESSION_SECRET/ },
  { what: 'backend internals', re: /free-tools\.js|asset-profile\.js|ai-chat\.js|ai-client\.js|mcp-endpoint\.js|\/backend\// },
];

// Words that legitimately appear in the built file, with the reason they are
// allowed. Each is stripped before the scan, so the rest of the file is still
// checked — an allow rule narrows the search, it does not disable it. This list
// is EMPTY on purpose: the minified bundle (SDK inlined, `legalComments: none`)
// contains none of the words above, so nothing needs excusing. If a future SDK
// upgrade reintroduces one, the check fails and the reason gets added here
// deliberately rather than the pattern being loosened.
const ALLOWED = [];

let haystack = source;
const stripped = [];
for (const rule of ALLOWED) {
  const hits = haystack.match(rule.pattern);
  if (hits) {
    stripped.push(`  allowed: ${hits.length}× ${rule.why} (${rule.pattern})`);
    haystack = haystack.replace(rule.pattern, '');
  }
}

const findings = [];
for (const { what, re } of PATTERNS) {
  const match = haystack.match(re);
  if (!match) continue;
  const at = haystack.indexOf(match[0]);
  findings.push({
    what,
    sample: match[0],
    context: haystack.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ').trim(),
  });
}

if (stripped.length) console.log(stripped.join('\n'));

if (findings.length) {
  console.error(`::error:: ${findings.length} leak(s) found in dist/server.js — refusing to publish.\n`);
  for (const f of findings) {
    console.error(`  ${f.what}: "${f.sample}"`);
    console.error(`    …${f.context}…`);
  }
  console.error('\nIf one of these is legitimate, add it to ALLOWED with the reason.');
  process.exit(1);
}

console.log(`no-leak-check: clean — ${(source.length / 1024).toFixed(1)} KB scanned, ${PATTERNS.length} patterns`);
