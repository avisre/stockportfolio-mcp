#!/usr/bin/env node
// Phase 1 MCP — thin wrapper over existing filing-grounded tools.
// Every tool returns structured JSON + a `source` field (the moat). No estimates.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "../../backend");
const SERVER_VERSION = "0.2.0";
const STARTED_AT = Date.now();

// Load existing deterministic tools (no AI, no net in the hot path beyond cache/Yahoo)
const freeTools = require(path.join(backendRoot, "free-tools.js"));
const assetProfile = require(path.join(backendRoot, "asset-profile.js"));

// ---- key auth + rate limit (protects ongoing compute) ----
const MCP_API_KEY = process.env.MCP_API_KEY || process.env.STOCKPORTFOLIO_MCP_KEY || "";
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(process.env.MCP_RATE_LIMIT || "30");
const MONTHLY_QUOTA = Number(process.env.MCP_MONTHLY_QUOTA || "2000");
const hits = new Map(); // key -> { count, resetAt }
function checkRate(key) {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now > rec.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (rec.count >= MAX_PER_WINDOW) return false;
  rec.count++;
  return true;
}

// ---- monthly quota, persisted ----
// A per-minute window alone does not bound what one key costs over a month, and
// this process is restarted often (stdio: one spawn per client). The counter
// therefore lives on disk in data/quota.json — { key: { month, count } } — and
// is the same shape the file already used. Writes are debounced and atomic
// (tmp + rename) so a kill mid-write cannot leave a truncated JSON file.
const QUOTA_FILE = process.env.MCP_QUOTA_FILE
  ? path.resolve(process.env.MCP_QUOTA_FILE)
  : path.resolve(__dirname, "../data/quota.json");
const QUOTA_DIR = path.dirname(QUOTA_FILE);
const QUOTA_FLUSH_MS = 2_000;
function currentMonth() { return new Date().toISOString().slice(0, 7); }

let quota = {};
try {
  quota = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8"));
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) quota = {};
} catch (_) { quota = {}; } // absent or corrupt file simply starts a fresh month

let flushTimer = null;
let flushPending = false;
function flushQuota() {
  flushPending = false;
  try {
    fs.mkdirSync(QUOTA_DIR, { recursive: true });
    const tmp = `${QUOTA_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(quota));
    fs.renameSync(tmp, QUOTA_FILE);
  } catch (err) {
    // Never fail a tool call because the quota file is unwritable — but say so
    // once on stderr so a read-only deploy is visible instead of silent.
    console.error("[mcp] quota persist failed:", err.message);
  }
}
function scheduleFlush() {
  if (flushPending) return;
  flushPending = true;
  flushTimer = setTimeout(flushQuota, QUOTA_FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref();
}
function quotaState(key) {
  const month = currentMonth();
  const rec = quota[key];
  const used = rec && rec.month === month ? Number(rec.count) || 0 : 0;
  return { month, used, limit: MONTHLY_QUOTA, remaining: Math.max(0, MONTHLY_QUOTA - used) };
}
function consumeQuota(key) {
  const month = currentMonth();
  const rec = quota[key];
  // A new month replaces the record rather than accumulating — this is the
  // rollover, and it is why the month is stored alongside the count.
  const used = rec && rec.month === month ? Number(rec.count) || 0 : 0;
  if (used >= MONTHLY_QUOTA) return false;
  quota[key] = { month, count: used + 1 };
  scheduleFlush();
  return true;
}

// Unkeyed local dev still needs a bucket so the quota path is exercised in
// development rather than only in production.
function bucketFor(provided) {
  return MCP_API_KEY ? String(provided || "").trim() : "__dev__";
}

function requireKey(provided) {
  const bucket = bucketFor(provided);
  if (MCP_API_KEY) {
    const k = String(provided || "").trim();
    if (!k || k !== MCP_API_KEY) {
      const e = new Error("Invalid or missing apiKey. Set MCP_API_KEY env and pass apiKey per tool call.");
      e.code = "UNAUTHORIZED";
      throw e;
    }
    if (!checkRate(k)) {
      const e = new Error(`Rate limit exceeded (${MAX_PER_WINDOW}/min). Try again shortly.`);
      e.code = "RATE_LIMITED";
      throw e;
    }
  }
  if (!consumeQuota(bucket)) {
    const s = quotaState(bucket);
    const e = new Error(`Monthly quota exhausted (${s.used}/${s.limit} for ${s.month}). Raise MCP_MONTHLY_QUOTA or upgrade at ${ATTRIBUTED_SITE}.`);
    e.code = "QUOTA_EXCEEDED";
    throw e;
  }
  return bucket;
}

// ---- attribution: every response carries a backlink ----
// This server is a distribution channel, so each tool return ships a visible
// citation line naming the filing it drew from and linking back to the site.
// It is deliberately part of the text content, not only the JSON, because most
// MCP clients surface the text to the reader and drop unrecognised JSON fields.
const SITE = "https://www.stockportfolio.pro";
const UTM = "utm_source=mcp&utm_medium=integration&utm_campaign=stockportfolio-mcp";
const ATTRIBUTED_SITE = `${SITE}/?${UTM}`;
function siteLink(pathname = "/") {
  return `${SITE}${pathname}${pathname.includes("?") ? "&" : "?"}${UTM}`;
}
function attribution(symbol, sourceUrl, period) {
  const where = symbol ? `/stocks/${encodeURIComponent(symbol)}` : "/";
  return {
    filingSource: sourceUrl || null,
    period: period || null,
    verifyAt: siteLink(where),
    poweredBy: "StockPortfolio.pro — filing-grounded US company data",
  };
}
function citationLine(symbol, sourceUrl, period) {
  const bits = [];
  if (sourceUrl) bits.push(`Filing source: ${sourceUrl}`);
  else bits.push("Filing source: not available for this field — treat the value as unsourced.");
  if (period) bits.push(`Period: ${period}`);
  bits.push(`Verify / full history: ${siteLink(symbol ? `/stocks/${encodeURIComponent(symbol)}` : "/")}`);
  bits.push("Data via StockPortfolio.pro. Informational research only, not investment advice.");
  return `— ${bits.join(" · ")}`;
}
// Every successful tool return goes through here, so no path can ship without
// its citation block and backlink.
function toolText(payload, { symbol = null, sourceUrl = null, period = null } = {}) {
  const withCitation = { ...payload, citation: attribution(symbol, sourceUrl, period) };
  return {
    content: [
      { type: "text", text: JSON.stringify(withCitation, null, 2) },
      { type: "text", text: citationLine(symbol, sourceUrl, period) },
    ],
  };
}

// ---- helpers: source envelope ----
function envelope(tool, symbol, result) {
  // result from freeTools already contains source/sourceUrl/note/warnings — keep it.
  // Add a top-level `source` object for MCP consumers + keep original fields.
  const edgar = result.sourceUrl || result.source || null;
  return {
    tool,
    symbol: symbol || result.symbol || null,
    generatedAt: new Date().toISOString(),
    data: result,
    source: {
      type: /sec\.gov|SEC/i.test(String(edgar)) ? "filed" : String(result.source || "filed"),
      url: edgar,
      period: result.period || result.latest?.period || null,
      note: result.note || "Informational research only — verify in the linked SEC filing. Not investment advice.",
    },
    warnings: result.warnings || [],
  };
}
// Envelope + citation in one step, so a tool cannot return the envelope alone.
function envelopeText(tool, symbol, result) {
  const payload = envelope(tool, symbol, result);
  return toolText(payload, { symbol: payload.symbol, sourceUrl: payload.source.url, period: payload.source.period });
}

// ---- tool definitions ----
const TOOL_DEFS = [
  {
    name: "sp_financials",
    title: "Filing-grounded financials (deterministic)",
    description: "Return period-locked filing figures for one ticker (revenue, net income, OCF, FCF, shares, margins). Uses the same cache as /api/free-tools; every value keeps its fiscal period and SEC source. Missing data stays missing — never estimated.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "US ticker, e.g. NVDA, AAPL" },
        tool: { type: "string", description: "free-tool slug: earnings-quality, dilution, filing-timeline, buybacks-vs-dilution, revenue-consistency, profitability-trend, cash-flow-quality, free-cash-flow-trend, debt-snapshot, etc.", default: "earnings-quality" },
        apiKey: { type: "string", description: "MCP_API_KEY if server is key-gated" },
      },
      required: ["ticker"],
    },
  },
  {
    name: "sp_filing",
    title: "SEC filing timeline",
    description: "Browse recent 10-K/10-Q/8-K/Form 4 with dates and direct EDGAR links. Grounds any claim in its primary document.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string" },
        apiKey: { type: "string" },
      },
      required: ["ticker"],
    },
  },
  {
    name: "sp_compare",
    title: "Company compare (two tickers, filing-grounded)",
    description: "Side-by-side revenue, margins, cash flow and shares for two US companies from their latest filed annuals. Flags the stronger figure. Periods are kept separate.",
    inputSchema: {
      type: "object",
      properties: {
        tickers: { type: "string", description: "Two tickers comma-separated, e.g. 'AAPL,MSFT'" },
        apiKey: { type: "string" },
      },
      required: ["tickers"],
    },
  },
  {
    name: "sp_screen",
    title: "Screener (rank by filed numbers)",
    description: "Rank tickers by a deterministic screener. Phase 1 exposes the raw tool — criteria are validated server-side.",
    inputSchema: {
      type: "object",
      properties: {
        tickers: { type: "string", description: "Optional: comma-separated watchlist to rank (max 10). Empty = uses cached universe." },
        apiKey: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "sp_fund",
    title: "ETF/mutual-fund profile (labelled fund data)",
    description: "ETF/mutual-fund costs, holdings, allocation, performance and risk. Never presented as company SEC 10-K data.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Fund symbol, e.g. SPY, VOO" },
        apiKey: { type: "string" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "sp_ask",
    title: "Filing-grounded Ask (AI, but sourced)",
    description: "Ask a US stock/fund question. Returns the answer plus its source class (filed / fund-data / live-web). For an MCP agent, prefer sp_financials/sp_filing when you need numbers only.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Full research question, e.g. 'Did NVDA diluted shares rise despite buybacks in Q1 FY27?'" },
        apiKey: { type: "string" },
      },
      required: ["question"],
    },
  },
  {
    name: "sp_health",
    title: "Health check",
    description: "Liveness/readiness probe: server version, uptime, whether the backend data modules loaded, and this key's remaining monthly quota. Safe to call before any other tool; does not consume quota.",
    inputSchema: {
      type: "object",
      properties: { apiKey: { type: "string", description: "MCP_API_KEY if server is key-gated" } },
      required: [],
    },
  },
];

// Health is checked without touching the data path so a probe can distinguish
// "server up, data missing" from "server down".
function healthReport(bucket) {
  const checks = {};
  try { checks.freeTools = typeof freeTools.getToolResult === "function"; } catch (_) { checks.freeTools = false; }
  try { checks.assetProfile = typeof assetProfile.fetchAssetProfile === "function"; } catch (_) { checks.assetProfile = false; }
  try { checks.toolCatalog = Object.keys(freeTools.TOOL_DEFINITIONS || {}).length; } catch (_) { checks.toolCatalog = 0; }
  try {
    fs.mkdirSync(QUOTA_DIR, { recursive: true });
    fs.accessSync(QUOTA_DIR, fs.constants.W_OK);
    checks.quotaWritable = true;
  } catch (_) { checks.quotaWritable = false; }
  const ok = checks.freeTools && checks.assetProfile && checks.toolCatalog > 0;
  return {
    tool: "health",
    status: ok ? "ok" : "degraded",
    version: SERVER_VERSION,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    toolCount: TOOL_DEFS.length,
    keyGated: Boolean(MCP_API_KEY),
    checks,
    quota: quotaState(bucket),
    rateLimit: { perMinute: MAX_PER_WINDOW },
    generatedAt: new Date().toISOString(),
  };
}

const server = new Server({ name: "stockportfolio-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    // Health must answer even when the key is wrong or the quota is spent —
    // otherwise a probe cannot tell an exhausted key from a dead server.
    if (name === "sp_health") {
      return toolText(healthReport(bucketFor(args.apiKey)));
    }

    requireKey("apiKey" in args ? args.apiKey : undefined);

    if (name === "sp_financials") {
      const ticker = freeTools.normalizeSymbol(args.ticker);
      if (!ticker) throw new Error("Invalid ticker.");
      const tool = String(args.tool || "earnings-quality").trim().toLowerCase();
      const slugs = new Set(Object.keys(freeTools.TOOL_DEFINITIONS));
      const slug = slugs.has(tool) ? tool : "earnings-quality";
      const result = await freeTools.getToolResult(slug, ticker);
      if (result.error) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }, null, 2) }], isError: true };
      return envelopeText(slug, ticker, result.body || result);
    }

    if (name === "sp_filing") {
      const ticker = freeTools.normalizeSymbol(args.ticker);
      if (!ticker) throw new Error("Invalid ticker.");
      const result = await freeTools.getToolResult("filing-timeline", ticker);
      if (result.error) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }, null, 2) }], isError: true };
      return envelopeText("filing-timeline", ticker, result.body || result);
    }

    if (name === "sp_compare") {
      const raw = String(args.tickers || "").trim();
      const symbols = raw.split(",").map((s) => freeTools.normalizeSymbol(s)).filter(Boolean);
      if (symbols.length !== 2) throw new Error("Pass exactly two tickers as 'tickers', e.g. 'AAPL,MSFT'.");
      const result = await freeTools.getToolResult("company-comparison", symbols.join(","));
      // getToolResult for company-comparison expects a single string "AAPL,MSFT" as symbol arg
      // Fallback to computeMultiTool if needed
      let body = result.body || result;
      if (body && body.error) body = await freeTools.computeMultiTool ? await freeTools.computeMultiTool("company-comparison", symbols) : body;
      return envelopeText("company-comparison", symbols.join(","), body);
    }

    if (name === "sp_fund") {
      const symbol = freeTools.normalizeSymbol(args.symbol);
      if (!symbol) throw new Error("Invalid fund symbol.");
      const profile = await assetProfile.fetchAssetProfile(symbol);
      const isFund = assetProfile.isFundAsset(profile.assetType);
      if (!isFund) return { content: [{ type: "text", text: JSON.stringify({ error: `${symbol} is not an ETF or mutual fund.` }, null, 2) }], isError: true };
      const payload = {
        tool: "fund",
        symbol,
        generatedAt: new Date().toISOString(),
        profile,
        source: { type: "fund-data", url: profile.source || null, note: "Fund data via Yahoo fund profiles — not company SEC 10-K/10-Q." },
      };
      return toolText(payload, { symbol, sourceUrl: profile.source || null });
    }

    if (name === "sp_screen") {
      // Thin wrapper: reuse the same deterministic screener path the web app uses.
      // For Phase 1 keep it simple — return the portfolio-revenue ranking for the supplied watchlist,
      // or a hint to call sp_financials per ticker when no list is supplied.
      const raw = String(args.tickers || "").trim();
      if (!raw) {
        return toolText({ tool: "screen", note: "Pass tickers='AAPL,MSFT,NVDA' (max 10) to rank by filed revenue growth; or use sp_financials per ticker.", source: { type: "filed" } });
      }
      const symbols = raw.split(",").map((s) => freeTools.normalizeSymbol(s)).filter(Boolean).slice(0, 10);
      const result = await freeTools.getToolResult("portfolio-revenue", symbols.join(","));
      return envelopeText("portfolio-revenue", symbols.join(","), result.body || result);
    }

    if (name === "sp_ask") {
      // Phase 1: delegate to the existing Ask endpoint via direct import to avoid HTTP hop.
      // Keep the answer and its source class visible; do not strip periods or URLs.
      const question = String(args.question || "").trim();
      if (!question) throw new Error("Missing question.");
      const aiChat = require(path.join(backendRoot, "ai-chat.js"));
      // Use the non-streaming path; it already tags sources as filed/fund-data/live-web
      const result = await aiChat.ask({ question, history: [], ctx: { holdings: [] } }).catch((e) => ({ error: e.message }));
      if (result && result.error) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }, null, 2) }], isError: true };
      const payload = {
        tool: "ask",
        question,
        answer: result.text || result.answer || result.body || result,
        generatedAt: new Date().toISOString(),
        source: { type: result.sourceClass || result.source || "filed", note: "Verify figures in the cited SEC filing before acting. Not investment advice." },
      };
      return toolText(payload, { sourceUrl: result.sourceUrl || null });
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    const msg = String(err.message || err);
    const isAuth = err.code === "UNAUTHORIZED" || err.code === "RATE_LIMITED" || err.code === "QUOTA_EXCEEDED";
    // Errors carry the backlink too — a rejected call is still a place the
    // reader learns where the data would have come from.
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: msg, code: err.code || "ERROR", moreAt: ATTRIBUTED_SITE }, null, 2) },
        { type: "text", text: `— StockPortfolio.pro (${ATTRIBUTED_SITE})` },
      ],
      isError: !isAuth,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mcp] stockportfolio-mcp ${SERVER_VERSION} listening on stdio (${TOOL_DEFS.length} tools, citation + backlink on every return)`);
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { if (flushPending) flushQuota(); process.exit(0); });
}
process.on("exit", () => { if (flushPending) flushQuota(); });

main().catch((e) => {
  console.error("[mcp] fatal", e);
  process.exit(1);
});
