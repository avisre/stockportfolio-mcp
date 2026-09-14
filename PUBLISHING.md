# Publishing

Two steps, in this order. The second fails without the first.

## 1. npm (needs a token — the only manual step)

The MCP registry refuses a package whose published `package.json` lacks an
`mcpName` field. `mcpName` was added in **0.3.1**; npm currently serves
**0.3.0**, which does not have it. So the registry cannot accept this server
until 0.3.1 is on npm. Measured, not assumed — the registry returned:

> NPM package 'stockportfolio-mcp' is missing required 'mcpName' field.

```bash
npm login          # or set NODE_AUTH_TOKEN
npm publish        # prepack runs the build + the provider leak gate
```

## 2. MCP registry (automatic)

```bash
gh workflow run publish-mcp.yml
```

Authenticates with GitHub OIDC, so there is no token to store and no browser
device flow to sit through. Already verified working — a run on 2026-09-14 got
through `login` and `validate` and failed only on step 1's missing version.

Bump `version` and `packages[0].version` in `server.json` together with
`package.json` and `src/version.js`; `scripts/build-dist.js` enforces that the
last two agree.
