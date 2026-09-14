// Tests the published bridge (src/bridge.js, built to dist/server.js) against a
// fake hosted endpoint built on the MCP SDK's own HTTP transport — the protocol
// is real, the network is not. Three things are worth testing and nothing else
// survives a refactor: the key reaches the endpoint as a bearer header, each
// JSON-RPC request is forwarded and its reply relayed, and the two failures a
// user actually hits (bad key, out of credits) come back as sentences rather
// than as "Error POSTing to endpoint (HTTP 402)".

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/sdk/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(packageRoot, 'src/bridge.js');

const TOOLS = [
  {
    name: 'sp_financials',
    description: 'Filing-grounded financials',
    inputSchema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  },
];

// A stand-in for https://stockportfolio.pro/mcp. `refuse` lets a test make one
// method fail with a chosen HTTP status before the transport sees it, which is
// how the real endpoint answers a bad key (401) or a spent allowance (402).
function startFakeEndpoint({ refuse = () => null, seen = [], onCall } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let parsed;
      try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = undefined; }

      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, rpc: parsed?.method });

      const rejection = refuse(parsed, req);
      if (rejection) {
        res.writeHead(rejection.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: rejection.error }));
        return;
      }

      const mcp = new Server({ name: 'fake-hosted', version: '0.0.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
      mcp.setRequestHandler(CallToolRequestSchema, async (r) => onCall(r.params));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Drives the bridge exactly as an MCP client does: newline-delimited JSON-RPC
// on stdin, replies on stdout. Returns a handle whose waitFor(id) resolves with
// that request's `result` (or its `error`).
function startBridge(env) {
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const replies = new Map();
  const waiters = new Map();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let nl;
    while ((nl = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, nl).trim();
      stdout = stdout.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined) continue;
      replies.set(msg.id, msg);
      const waiter = waiters.get(msg.id);
      if (waiter) { waiters.delete(msg.id); waiter(msg); }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  return {
    child,
    get stderr() { return stderr; },
    send(msg) { child.stdin.write(`${JSON.stringify(msg)}\n`); },
    waitFor(id, ms = 15000) {
      if (replies.has(id)) return Promise.resolve(replies.get(id));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no reply to id ${id} within ${ms}ms; stderr:\n${stderr}`)), ms);
        waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      });
    },
    stop() {
      child.kill('SIGKILL');
      return new Promise((resolve) => child.on('exit', resolve));
    },
  };
}

async function handshake(bridge) {
  bridge.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'bridge-test', version: '0' } },
  });
  const init = await bridge.waitFor(1);
  bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return init;
}

test('the bridge relays tools and calls, and carries the key as a bearer header', { timeout: 30000 }, async () => {
  const seen = [];
  const { server, port } = await startFakeEndpoint({
    seen,
    onCall: ({ name, arguments: args }) => ({
      content: [{ type: 'text', text: JSON.stringify({ tool: name, args }) }],
    }),
  });
  const bridge = startBridge({
    STOCKPORTFOLIO_API_KEY: 'test-key-123',
    STOCKPORTFOLIO_MCP_URL: `http://127.0.0.1:${port}/mcp`,
  });

  try {
    const init = await handshake(bridge);
    // The local server identifies itself — a client that sees 'fake-hosted'
    // here would be talking to the wrong layer.
    assert.equal(init.result.serverInfo.name, 'stockportfolio-mcp');

    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = await bridge.waitFor(2);
    assert.equal(listed.result.tools.length, 1);
    assert.equal(listed.result.tools[0].name, 'sp_financials');
    assert.match(listed.result.tools[0].description, /Filing-grounded/);

    bridge.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'sp_financials', arguments: { ticker: 'NVDA' } },
    });
    const called = await bridge.waitFor(3);
    assert.equal(called.result.isError, undefined);
    assert.match(called.result.content[0].text, /NVDA/);

    // Every request that reached the fake endpoint, including the client
    // handshake, carried the key. A bridge that forwards JSON-RPC but drops the
    // header would fail against the real endpoint with a 401.
    assert.ok(seen.length > 0, 'endpoint was never called');
    for (const hit of seen) assert.equal(hit.auth, 'Bearer test-key-123');
    const forwarded = seen.filter((h) => h.rpc === 'tools/call');
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].url, '/mcp');
  } finally {
    await bridge.stop();
    server.close();
  }
});

test('a bad key is reported as a sentence, not as an HTTP status', { timeout: 30000 }, async () => {
  const { server, port } = await startFakeEndpoint({
    refuse: () => ({ status: 401, error: 'unauthorized' }),
    onCall: () => ({ content: [] }),
  });
  const bridge = startBridge({
    STOCKPORTFOLIO_API_KEY: 'revoked-key',
    STOCKPORTFOLIO_MCP_URL: `http://127.0.0.1:${port}/mcp`,
  });

  try {
    await handshake(bridge);
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sp_financials', arguments: { ticker: 'NVDA' } } });
    const reply = await bridge.waitFor(2);
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /API key was rejected/);
    assert.match(reply.result.content[0].text, /stockportfolio\.pro\/api/);
  } finally {
    await bridge.stop();
    server.close();
  }
});

test('a spent allowance points at the reset, not at the transport', { timeout: 30000 }, async () => {
  const { server, port } = await startFakeEndpoint({
    refuse: (rpc) => (rpc?.method === 'tools/call' ? { status: 402, error: 'out of credits' } : null),
    onCall: () => ({ content: [] }),
  });
  const bridge = startBridge({
    STOCKPORTFOLIO_API_KEY: 'tapped-out',
    STOCKPORTFOLIO_MCP_URL: `http://127.0.0.1:${port}/mcp`,
  });

  try {
    await handshake(bridge);
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sp_financials', arguments: { ticker: 'NVDA' } } });
    const reply = await bridge.waitFor(2);
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /Out of credits/);
  } finally {
    await bridge.stop();
    server.close();
  }
});

test('with no key the bridge refuses to start and says where to get one', { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [BRIDGE], {
    // Strip every alias of the key, including anything ambient in this shell.
    env: { ...process.env, STOCKPORTFOLIO_API_KEY: '', SP_API_KEY: '', MCP_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));

  assert.equal(code, 1);
  assert.match(stderr, /No API key set/);
  assert.match(stderr, /stockportfolio\.pro\/api/);
});
