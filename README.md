# stockportfolio-mcp

**Filing-grounded US stock data for your agent** — financials, SEC filing timelines, company
comparisons and fund profiles, where every returned value carries the URL of the filing it came
from. Missing data comes back missing; nothing is estimated.

```bash
# Get a key (Dev plan: $19.99/month, 200 credits) → https://stockportfolio.pro/api
```

## Install

Add this to your MCP client's config and restart it:

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "stockportfolio": {
      "command": "npx",
      "args": ["-y", "stockportfolio-mcp"],
      "env": { "STOCKPORTFOLIO_API_KEY": "your-key-here" }
    }
  }
}
```

**Cursor** — `~/.cursor/mcp.json`, same block.

Then ask your agent something like *"Use sp_financials for NVDA and show the period and the
filing source for each figure."*

Requires Node 18 or newer; `npx` fetches the package on first run. Nothing else to install —
this package bundles everything it needs.

## Tools

| tool | what it returns | cost |
|------|-----------------|------|
| `sp_financials(ticker, tool?)` | Period-locked figures from the filed statements. `tool` picks the view: `earnings-quality` (default), `dilution`, `buybacks-vs-dilution`, `revenue-consistency`, `profitability-trend`, `cash-flow-quality`, `free-cash-flow-trend`, `debt-snapshot`, and more. | 1 credit |
| `sp_filing(ticker)` | Recent 10-K / 10-Q / 8-K / Form 4 with dates and direct EDGAR links. | 1 credit |
| `sp_compare(tickers)` | Two tickers side by side, from their latest filed annuals. Periods stay separate. | 1 credit |
| `sp_screen(tickers)` | Ranks up to ten tickers by filed revenue growth. | 1 credit |
| `sp_fund(symbol)` | ETF / mutual-fund costs, holdings, allocation, performance, risk. Labelled fund data — never presented as company SEC data. | 1 credit |
| `sp_ask(question)` | A filing-grounded answer plus its source class (`filed` / `fund-data` / `live-web`). | 4 credits |
| `sp_health()` | Liveness probe: version, tool count. Free. | 0 |

Credits are the monthly allowance on your key (200/month on the Dev plan) and reset on the 1st.
`sp_health` answers even when the key is wrong or the allowance is spent, so a probe can tell an
exhausted key from a dead service.

## What a response looks like

Real response, trimmed — this is `sp_filing("NVDA")`:

```json
{
  "tool": "filing-timeline",
  "symbol": "NVDA",
  "generatedAt": "2026-09-11T18:39:50.366Z",
  "data": {
    "tool": "filing-timeline",
    "symbol": "NVDA",
    "source": "SEC EDGAR",
    "filings": [
      {
        "form": "4",
        "label": "Form 4 (insider ownership)",
        "date": "2026-09-08",
        "url": "https://www.sec.gov/Archives/edgar/data/1045810/000119903926000014/xslF345X06/wk-form4_1788901755.xml"
      }
    ]
  },
  "source": {
    "type": "filed",
    "url": "https://www.sec.gov/Archives/edgar/data/1045810/000119903926000014/xslF345X06/wk-form4_1788901755.xml",
    "period": null,
    "note": "Informational research only — verify in the linked SEC filing. Not investment advice."
  },
  "warnings": [],
  "citation": {
    "filingSource": "https://www.sec.gov/Archives/edgar/data/1045810/000119903926000014/xslF345X06/wk-form4_1788901755.xml",
    "verifyAt": "https://www.stockportfolio.pro/stocks/NVDA?utm_source=mcp&utm_medium=integration&utm_campaign=stockportfolio-mcp",
    "poweredBy": "StockPortfolio.pro — filing-grounded US company data"
  }
}
```

`source.url` is the point of the whole thing: an agent can cite the filing instead of asserting a
number. When a field has no filing URL the response says so rather than quietly omitting it, and
`warnings` flags a filing that was incomplete.

## What's in this package

A stdio MCP server that proxies to the hosted endpoint at
`https://www.stockportfolio.pro/mcp`. It reads JSON-RPC on stdin, forwards each request with your
key as a bearer header, and relays the reply to stdout. No filing data, no model code and no
server logic ship in the tarball — the only thing it holds is the key you give it, and it sends
that key nowhere except that endpoint.

Because the endpoint is stateless, one bridge per client is fine and there is no session to resume
— a dropped connection is rebuilt on the next call.

## Troubleshooting

| symptom | cause |
|---------|-------|
| `The API key was rejected` | `STOCKPORTFOLIO_API_KEY` is missing, revoked, or pasted with quotes. |
| `Out of credits for this month` | The monthly allowance is spent. It resets on the 1st, or add credits at the pricing page. |
| `Rate limited` | Too many concurrent calls; retry shortly. |
| `npx` can't find the package | Node 18+ is required. `npx -y stockportfolio-mcp` from a terminal shows the same error your client sees. |
| Client shows no tools | Restart the client after editing the config — the MCP config is read at startup. |

The bridge prints its errors to stderr, which most MCP clients surface in their log pane. To see
them directly, run it yourself:

```bash
STOCKPORTFOLIO_API_KEY=your-key npx -y stockportfolio-mcp
```

## Links

- Pricing and key management: <https://stockportfolio.pro/api?utm_source=npm&utm_medium=integration&utm_campaign=stockportfolio-mcp>
- REST API (same data, HTTP): <https://stockportfolio.pro/api/v1>
- Source and coverage: <https://www.stockportfolio.pro/>

Informational research only — not investment advice. Fund data is Yahoo-derived and not
redistributable.
