#!/usr/bin/env node
// stockportfolio-mcp — a stdio MCP server that proxies to the hosted endpoint.
//
// Claude Desktop and Cursor speak MCP over stdio to a local process. The data
// lives at https://www.stockportfolio.pro/mcp (stateless Streamable HTTP), so
// this package is a bridge: it reads JSON-RPC on stdin, forwards each request
// to the hosted endpoint with your API key, and writes the reply back to
// stdout. No
// filing data, no AI code, no backend logic ships in this package — the only
// thing it holds is the key you give it, and it sends that key nowhere but the
// endpoint below.
//
// Configuration (env, set in the client's mcpServers block):
//   STOCKPORTFOLIO_API_KEY  required — the key from https://stockportfolio.pro/api
//   STOCKPORTFOLIO_MCP_URL  optional — defaults to the hosted endpoint
// MCP_API_KEY and SP_API_KEY / SP_MCP_URL are accepted as shorter aliases.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from './version.js';

// www, not the bare apex. The apex answers 307 → www, and fetch (Undici, and
// every browser) DROPS the Authorization header when a redirect changes host —
// measured 2026-09-12 against a local 307: the downstream request arrived with
// no auth header at all. Posting at the apex therefore lands as an unauthenticated
// request at www and comes back 401, which reads as "your key is wrong" when the
// real fault is the URL. Keep this on the canonical host.
const DEFAULT_URL = 'https://www.stockportfolio.pro/mcp';
const UTM = 'utm_source=npm&utm_medium=integration&utm_campaign=stockportfolio-mcp';
const SIGNUP_URL = `https://stockportfolio.pro/api?${UTM}`;

const API_KEY = String(
  process.env.STOCKPORTFOLIO_API_KEY || process.env.SP_API_KEY || process.env.MCP_API_KEY || ''
).trim();
const ENDPOINT = String(
  process.env.STOCKPORTFOLIO_MCP_URL || process.env.SP_MCP_URL || DEFAULT_URL
).trim();

if (!API_KEY) {
  // Fail before the client sees a socket. A missing key is the most common
  // first-run failure, so the message says exactly where the key comes from.
  console.error(
    [
      '[stockportfolio-mcp] No API key set.',
      '',
      'Add it to your MCP client config:',
      '',
      '  {',
      '    "mcpServers": {',
      '        "stockportfolio": {',
      '          "command": "npx",',
      '          "args": ["-y", "stockportfolio-mcp"],',
      '          "env": { "STOCKPORTFOLIO_API_KEY": "sp_live_..." }',
      '        }',
      '    }',
      '  }',
      '',
      `Get a key (Dev plan, 200 credits/month): ${SIGNUP_URL}`,
    ].join('\n')
  );
  process.exit(1);
}

// One remote client, connected lazily and re-connected if a call fails at the
// transport level — the hosted endpoint is stateless, so a dropped connection
// costs nothing to rebuild and must never wedge the bridge for the session.
let remote = null;
let connecting = null;

async function connectRemote() {
  const client = new Client(
    { name: 'stockportfolio-mcp-bridge', version: VERSION },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
  });
  await client.connect(transport);
  return client;
}

async function remoteClient() {
  if (remote) return remote;
  if (!connecting) {
    connecting = connectRemote()
      .then((client) => {
        remote = client;
        return client;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

function forgetRemote() {
  remote = null;
}

// Turns a transport/HTTP failure into something a person can act on. The
// hosted endpoint answers 401 for a bad key, 402 when the month's credits are
// spent and 429 when a key is hammering — each has a different fix, and the raw
// SDK error ("Error POSTing to endpoint (HTTP 402)") names none of them.
function explain(err) {
  const code = Number(err?.code ?? err?.status ?? 0);
  const detail = String(err?.message || err);
  if (code === 401) {
    return `The API key was rejected. Check STOCKPORTFOLIO_API_KEY in your MCP config — it must be an active key from ${SIGNUP_URL}\n\n(${detail})`;
  }
  if (code === 402) {
    return `Out of credits for this month. Credits reset on the 1st, or add more at ${SIGNUP_URL}\n\n(${detail})`;
  }
  if (code === 429) {
    return `Rate limited — too many calls at once. Slow down and retry.\n\n(${detail})`;
  }
  if (code >= 500) {
    return `The data service is temporarily unavailable (HTTP ${code}). Retrying usually works.\n\n(${detail})`;
  }
  return detail;
}

const server = new Server(
  { name: 'stockportfolio-mcp', version: VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      'Filing-grounded US company data from StockPortfolio.pro: financial statements, ' +
      'SEC filing timelines, comparisons and fund profiles. Every returned value carries ' +
      'the URL of the filing it came from — cite it. Missing data is reported as missing, ' +
      'never estimated. ' +
      SIGNUP_URL,
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    return await (await remoteClient()).listTools();
  } catch (err) {
    throw new Error(explain(err));
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params || {};
  try {
    return await (await remoteClient()).callTool({ name, arguments: args });
  } catch (err) {
    // A transport-level failure means the connection itself is unusable; drop
    // it so the next call dials fresh instead of reusing a dead client. A tool
    // error (400/402, isError results) keeps the connection.
    const code = Number(err?.code ?? 0);
    if (!code || code >= 500) forgetRemote();
    return {
      content: [{ type: 'text', text: explain(err) }],
      isError: true,
    };
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(
    `[stockportfolio-mcp] v${VERSION} ready — stdio → ${ENDPOINT} (7 tools, every value keeps its filing URL)`
  );
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    const client = remote;
    remote = null;
    if (client && typeof client.close === 'function') {
      Promise.resolve(client.close()).catch(() => {}).finally(() => process.exit(0));
    } else {
      process.exit(0);
    }
  });
}

main().catch((err) => {
  console.error('[stockportfolio-mcp] fatal:', err?.message || err);
  process.exit(1);
});
