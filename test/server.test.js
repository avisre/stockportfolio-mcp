import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "path";

import os from "node:os";
import fs from "node:fs";

// Each spawn gets its own quota file so tests never touch the real counters.
function callMcp(method, params = {}, env = {}) {
  return new Promise((resolve, reject) => {
    const quotaFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-quota-")), "quota.json");
    const child = spawn("node", ["src/server.js"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, MCP_QUOTA_FILE: quotaFile, ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    const payloads = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: method, params }),
    ];
    setTimeout(() => child.stdin.write(payloads.join("\n") + "\n"), 100);
    setTimeout(() => child.kill(), 8000);
    child.on("close", () => {
      for (const line of out.split("\n")) {
        if (line.includes('"id":3')) {
          try { resolve(JSON.parse(line)); return; } catch {}
        }
      }
      reject(new Error("no id:3 response: " + out.slice(0, 2000)));
    });
  });
}

test("tools/list exposes 7 tools including sp_health", async () => {
  const res = await callMcp("tools/list", {});
  assert.ok(res.result.tools.length === 7, "expected 7 tools");
  assert.ok(res.result.tools.some((t) => t.name === "sp_financials"));
  assert.ok(res.result.tools.some((t) => t.name === "sp_health"));
});

// Offline-safe: health must not touch the data path.
test("sp_health reports ok, quota and a backlink", async () => {
  const res = await callMcp("tools/call", { name: "sp_health", arguments: {} });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.status, "ok");
  assert.equal(payload.toolCount, 7);
  assert.ok(payload.quota.limit > 0);
  assert.ok(Number.isInteger(payload.quota.used));
  assert.match(payload.citation.verifyAt, /stockportfolio\.pro/);
  assert.match(res.result.content[1].text, /stockportfolio\.pro/);
});

test("every successful tool return carries a visible citation line", async () => {
  const res = await callMcp("tools/call", { name: "sp_screen", arguments: {} });
  assert.equal(res.result.content.length, 2);
  const line = res.result.content[1].text;
  assert.match(line, /Verify \/ full history: https:\/\/www\.stockportfolio\.pro/);
  assert.match(line, /utm_source=mcp/);
  assert.match(line, /not investment advice/i);
});

test("monthly quota is enforced and rejects once exhausted", async () => {
  const res = await callMcp("tools/call", { name: "sp_screen", arguments: {} }, { MCP_MONTHLY_QUOTA: "0" });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.code, "QUOTA_EXCEEDED");
  assert.match(payload.moreAt, /stockportfolio\.pro/);
});

test("health still answers when the quota is exhausted", async () => {
  const res = await callMcp("tools/call", { name: "sp_health", arguments: {} }, { MCP_MONTHLY_QUOTA: "0" });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.quota.limit, 0);
  assert.equal(payload.status, "ok");
});

test("sp_financials dilution returns source", async () => {
  const res = await callMcp("tools/call", { name: "sp_financials", arguments: { ticker: "AAPL", tool: "dilution" } });
  const text = res.result.content[0].text;
  const payload = JSON.parse(text);
  assert.equal(payload.symbol, "AAPL");
  assert.ok(payload.source.url.includes("sec.gov"));
  assert.ok(payload.data.percentageChange !== null);
});

test("sp_fund returns fund-data source", async () => {
  const res = await callMcp("tools/call", { name: "sp_fund", arguments: { symbol: "SPY" } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.source.type, "fund-data");
});
