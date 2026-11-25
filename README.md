# Signal Desk

## Pip and Niblit Pulse

Open http://127.0.0.1:8765/companion for the local companion and PC dashboard. Pip starts with four deterministic abilities: explicit memory, tasks, PC/service checks, and a downloadable assistant handoff. “Remember: …” saves a memory and “Task: …” saves a task. Review, forget or complete items in the UI. Helpful / Needs work records feedback for later review; it does not train or improve model weights by itself. New executable abilities require reviewed implementation and tests.

Pip stores its last 100 chat messages, up to 200 explicit memories and 200 tasks in ignored `data/pip.json`. Do not enter credentials or sensitive personal information; the simple credential filter is not comprehensive. Back up this file if the memories matter. Pip never executes generated code or shell commands, changes system settings, installs abilities, places trades or contacts other assistants. It can prepare a handoff that you choose to share.

Open-ended conversation can use your **local** Niblit inference endpoint at `http://127.0.0.1:8000/v1/chat/completions`, model `local`. Override with `PIP_MODEL_URL` and `PIP_MODEL` in `.env` and restart. Only loopback HTTP model URLs are accepted, and redirects are rejected. When used, local context includes taught memories, tasks, recent chat and summarized health. There is no cloud-model fallback. When unavailable, built-in abilities keep working and the UI states which reply mode was used.

Pulse reads PC CPU/memory/uptime/disk metrics and checks `/health` on core port 5000 and inference port 8000. Readiness uses recognized health fields, not just HTTP 200. Different ports need a code/configuration change; “no response” does not prove a service is stopped. Four known sibling repositories are inspected using read-only Git commands. Raw health responses, file contents, credentials and chat transcripts are excluded from the system brief; the Pip handoff additionally includes explicitly taught memories and open tasks. Review before sharing. Browser metrics refresh every 15 seconds while the tab is visible; Pulse is not an installed Windows service.

Local integration endpoints:

- `GET /api/companion`: summarized observed PC, service, repo and feed state.
- `GET /api/companion/brief`: downloadable system handoff.
- `GET /api/buddy`: saved Pip state, skills, progress and recent chat.
- `POST /api/buddy/chat` with JSON `{ "message": "Remember: …" }`.
- `POST /api/buddy/update` with JSON `{ "action": "complete-task", "id": "…" }`; also `forget-memory`, `helpful`, `needs-work`.
- `GET /api/buddy/brief`: system snapshot plus explicit memory and open tasks.

These are local interfaces, not authentication for a public server. Writes require JSON and reject foreign browser origins; keep the service loopback-only. Root workspace `AGENTS.md` records the user's standing preference for routine work. Pip memories never override human authorization or applicable tool approvals.

Manual trading dashboard with a local market-data API. Requires Node.js 22+; no packages to install.

## Start

Run `npm start` in this directory, then open http://127.0.0.1:8765. Opening the HTML file directly does not run the API. The server binds only to this computer.

Crypto candles work through Kraken public REST without a key. For forex, gold, stocks and indices, copy `.env.example` to `.env`, set `TWELVE_DATA_API_KEY`, and restart. Do not paste keys into chat or browser code. Twelve Data coverage, delay and quotas depend on your plan and exchange permissions. Do not expose this local server directly to the internet.

## Collection

- `/api/health`: provider configuration and collector subscription status; no secret values.
- `/api/candles?provider=kraken&symbol=XBTUSD&interval=60`: normalized completed OHLCV candles.
- `/api/candles?provider=twelve&symbol=EUR%2FUSD&interval=60`: same format for Twelve Data.
- Supported timeframes: 15, 60, 240, 1440 minutes.

The default BTC/USD subscription starts when the server starts. Requesting a market subscribes it to collection every 60 seconds, even if the browser closes. The server must remain running. Up to 12 subscriptions are held until restart; optionally configure a comma-separated WATCHLIST in `.env` for restart persistence. Basic Twelve Data throttling allows one new upstream request per 15 seconds; larger watchlists may need a paid plan and tuning. No fake data is substituted when a provider fails. Failed requests retry after a 60-second cooldown; expired cache is never presented as fresh. HTTP collection is polling, not a tick-by-tick stream.

Normalized candles contain `t` (UTC milliseconds for intraday; UTC-normalized session date for Twelve Data daily), `o`, `h`, `l`, `c`, `v`. Volume is 0 when unavailable. Kraken's unfinished candle is excluded. Twelve Data intraday candle end times are checked; its newest daily session is conservatively excluded because exchange close times differ. Stale candles may reflect a closed market; the dashboard shows WAIT.

Successful collections merge candles by timestamp into `data/*.json` using atomic file replacement. Each subscription retains up to 10,000 candles; history persists across restarts. This is a single-process local collector, not a multi-user data warehouse. Existing history is retained but never used as a substitute for a failed live fetch. The dashboard displays the recent provider window; the merged history is available in the local data files.

`npm test` runs provider normalization, caching, retries, persistence, input validation and HTTP integration checks with mocked providers. A live provider check is separate and depends on network access and credentials.

## Hosting

The original `.openai/hosting.json` describes the static dashboard only. The Node API runs locally and is not deployed by that static manifest. Hosting the full app requires a Node host or migration to a server-capable Sites project. Keep `.env` and `data/` out of any upload.

Signals remain research rules, not a validated profitable strategy. The displayed price is the latest completed candle close, not a live execution quote. Position sizing assumes a USD-quoted instrument.
