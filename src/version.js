// The version the bridge reports to MCP clients and to the hosted endpoint.
// Kept here rather than read from package.json so the source can run unbundled
// on any Node version (JSON import attributes need 20.10+). scripts/build-dist.js
// asserts it equals package.json's version before writing dist/, so the two
// cannot drift silently.
export const VERSION = '0.3.0';
