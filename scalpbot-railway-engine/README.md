# ScalpBot Quant Engine (practice mode)

A separate Node.js 20 + TypeScript (ESM) worker that runs continuously on Railway. It reads OANDA **practice**
prices, builds candles, runs the strategies and gates, and talks to the dashboard only through
`/api/public/worker/*`. It never places broker orders and never writes to the database directly.

## Run it
```
cd engine && npm install && npm run build && npm start
```
Railway: Root Directory = `engine`; `railway.json` sets build/start. Copy the variable names from `.env.example`.

## Environment
| Var | Purpose |
| --- | --- |
| `APP_URL` | Dashboard base URL (published or `project--<id>-dev`) |
| `WORKER_SECRET` | Same value as the dashboard's `WORKER_SECRET` (≥ 32 chars) |
| `WORKER_ID` | Heartbeat id, default `quant-engine` |
| `OANDA_TOKEN` / `OANDA_ACCOUNT_ID` / `OANDA_ENV=practice` | Practice feed; other environments are refused |
| `CANDLE_FETCH_DELAY_MS` | Wait after each minute boundary before fetching closed candles (default 3000) |
| `DRY_RUN` | `true` (default) = analyse/report only, never submit. The dashboard's own dry-run switch still applies when `false` |
| `BROKER_COMMISSION_PER_SIDE`, `BROKER_POSITION_UNITS`, `BROKER_ACCOUNT_TO_QUOTE`, `BROKER_SLIPPAGE_PER_SIDE` | Cost inputs; any missing → cost incomplete → nothing passes the gates |
| `NEWS_BLACKOUTS_JSON` | Optional manual blackout windows (no calendar connected) |

Invalid or missing settings stop the process at start-up with a list of problems; an unreachable dashboard also stops it.

## Runtime loop (`src/runtime/`)
- **Start-up:** poll `worker-settings`, read instrument precision, backfill M1 3000 / M5 1500 / M15 600 completed REST candles per pair, send them to `ingest-candles`, open the pricing stream.
- **Every minute** (+ `CANDLE_FETCH_DELAY_MS`): close local aggregates, fetch the bars that just closed (count grows automatically after an outage so gaps self-heal), reconcile REST vs local, send new candles.
- **Every M5 close:** `analyze()` per pair. The regime tracker always advances; a signal is submitted only when `decide()` returns PUBLISH **and** `scheduled_signals_enabled` is on **and** engine `DRY_RUN=false` **and** the kill switch is off. The app then re-runs eligibility, breakers and its dry-run rule. Published signals trigger `notify-signal` (Telegram, if enabled in the app).
- **Every 5 s:** `claim-request` takes the oldest queued user request (conditional update, no double-processing); each workflow stage is reported to `report-stage` with real timestamps and the request ends `completed` or `rejected` (`NO_VALID_SETUP — reasons`).
- **Every 30 s:** `POST health` heartbeat (details: versions, last ticks/candles, regime, last decision, pause state) and `ingest-data-status` per pair.
- **Every 60 s:** `worker-settings`. A 401 clears settings → fail closed.
- **Spread history** comes from real M1 bid/ask closes; the current live spread is used as the exit-spread estimate.
- **No signal can publish until validated history exists:** EV outcomes are `null` (no validation report yet), so the gate returns NO_VALID_SETUP with "EV unavailable". This is intended.
- **Not built yet:** tracking outcomes (TP/SL hits) of published signals via `ingest-event`, and a news calendar.


Schemas for every payload are in `src/contract.ts`.

## Phase 2 worker API (`/api/public/worker/*`)
All routes except `GET health` need `Authorization: Bearer $WORKER_SECRET`. Responses: 401 bad secret, 400 invalid payload, 422 business rejection (nothing is stored), 500 storage error.

| Route | Purpose |
| --- | --- |
| `POST ingest-candles` | `{ candles: Candle[] }`, 1–500. Invalid rows are quarantined (`market_candle_quarantine`), never repaired. Completed candles are never overwritten by partial/unvalidated ones. |
| `POST ingest-signal` | Full signal payload (see `src/domain/signal-contract.ts`). Runs the eligibility gate; repeated `idempotency_key` returns the existing signal. |
| `POST ingest-event` | `tp1_hit`, `tp2_hit`, `sl_hit`, `breakeven`, `expired`, `invalidated`, `note`. Idempotent per key. |
| `GET open-trades` | Open manual trades, no user identifiers. |
| `GET worker-settings` | Pause flag, enabled pairs, active risk config, enabled strategies. Missing values report paused / none. |
| `GET health` / `POST health` | Public liveness probe / authenticated heartbeat upsert. |

**Ticks:** raw ticks are not stored (cost). Each candle carries `bid_close`, `ask_close`, `spread_avg`, `spread_max`; `volume_type` records whether volume is `tick` or `real` volume.

**Score vs probability:** `score` is a 0–100 ranking, never a win probability. `calibrated_probability` is accepted only with a `calibration_version`; `expected_value_r` only with a `validation_reports` id.

## Phase 3 — OANDA practice data pipeline (`src/oanda/`)
- `config.ts` reads `OANDA_TOKEN`, `OANDA_ACCOUNT_ID`, `OANDA_ENV=practice` from env; any other env is refused. Hosts: `api-fxpractice.oanda.com` (REST), `stream-fxpractice.oanda.com` (stream).
- `parse.ts` parses PRICE / HEARTBEAT lines and `/candles?price=MBA` responses. Prices are decimal strings, parsed strictly. Mid = (bid+ask)/2 only when both are valid and not crossed. Heartbeats never count as prices.
- `pipeline.ts` builds M1/M5/M15 candles in UTC buckets, emitting only closed candles. It also detects gaps (skipping the documented weekend closure), reconciles candles, classifies feed state and computes backoff with jitter.
- `stream-client.ts` keeps the stream connected, reconnects with backoff, and runs a 20s watchdog on usable ticks.
- **Source of truth:** a complete REST candle from OANDA wins. Local aggregates are compared and differences beyond tolerance are sent to `ingest-data-status` → `candle_reconciliation_discrepancies`.
- **Volume:** OANDA `volume` is the number of price updates in the bar (tick volume), not exchange volume. Store it with `volume_type = 'tick'`.
- **Market schedule:** the expected closure is Fri 21:00 to Sun 21:00 UTC. OANDA's real hours shift with US daylight saving and holidays, so a pair counts as closed only when the schedule says closed AND no tradeable prices are arriving.
- **Operations:** heartbeat (`POST health`) every 30s; poll `worker-settings` every 60s; report `POST ingest-data-status` each heartbeat. Dry-run never disables ingestion, heartbeats or monitoring.
- **Still to build:** startup backfill, the scheduler, and gap-gating of signals inside the running worker.

## Indicators (Phase 4) — `src/indicators/`
Pure, deterministic functions (no I/O), version `INDICATOR_VERSION` + `configVersion`. `computeSnapshot()` returns every indicator as `{status, value, sourceTime, reason?}`; missing values are `unavailable`, never 0.
- Only completed candles with close time <= `asOf`; intra-session gaps (< 36h) make the timeframe unavailable until backfilled.
- First candle: no TR/change/DM (previous close never fabricated).
- EMA seeded by SMA(n); ATR/RSI/ADX use Wilder; ADX first at index 27 (DX seed = mean of first 14 DX). Smoothed TR = 0 → unavailable; +DI + -DI = 0 → DX 0.
- Percentiles: mid-rank `(less + 0.5*equal)/N*100`, window includes current. ATR pct: 200 M5 ATRs; BB width pct: 100 widths.
- Bollinger/z-score: population SD; SD treated as zero when <= 1e-12·|mean| → z unavailable.
- Donchian: previous 20 candles, current excluded.
- Realized vol: 30 log returns, sample SD (n-1); sigma_1s = sigma/sqrt(60) assumes i.i.d. returns (approximation). Vol ratio vs median of last 200 sigmas.
- Spread: UTC hour-of-day buckets, last 20 days, min 30 samples, stale/future excluded, z uses 1.4826·MAD; MAD 0 → no z.
- Precision: float64, unrounded.

## Market structure & patterns (Phase 5) — `src/structure/`
Pure functions over completed M5 candles; each takes `asOfIndex`/`i` and reads only candles[0..i].
- Swings: fractal n=2, strict `>`/`<`; `availableAt` = close of bar t+2. BOS/CHoCH use only swings confirmed before the breaking bar and fire on the first close beyond.
- Levels carry `availableAt`, `availableIndex`, `sourceId`. Forex day rolls 17:00 America/New_York; Asia 00–07 UTC; London 08–13 Europe/London; opening range = first 30 min of configured window. Sessions require every bar, else unavailable. Round levels computed in integer steps (XAUUSD 10.00, EURUSD 0.0050).
- Clusters: single-linkage, gap <= 0.15·ATR14; strength = Σ exp(-age/100) over unique sources (same sourceId or kind+price counted once); key level when strength >= 1.5.
- Retracement context (0.382–0.618 reached, no close beyond 0.786) is context only.
- Patterns return id, direction, barTime, confirmationTime (close of confirming bar), entryMode (`immediate_on_close` | `confirmation`), keyLevel, quality {q, bodyAtr, alignedClosePos}, invalidation, sources. Patterns are evidence, not trade instructions.

## Regime classification (Phase 6) — `src/regime/`
`classify()` (pure) + `step()` (hysteresis tracker). Precedence: DATA_UNAVAILABLE → news VOLATILE → other VOLATILE → DEAD → TREND_UP/DOWN → RANGE → MIXED.
- Data: M15 context must be the latest completed bar (age < 15 min + 2 min tolerance); M5 must be the bar being evaluated; M1 age <= 3 min. Forming bars (close time after asOf) → DATA_UNAVAILABLE.
- Hysteresis: 3 consecutive contiguous completed M5 bars to switch. DATA_UNAVAILABLE and news/external blocks apply immediately; leaving them needs 3 bars. Re-submitted or forming M5 bars never add a confirmation; a gap resets the count.
- News: verified calendar events only (high impact, relevant currency, absolute UTC times). Hard block ±10 min; ±30 min is a penalty flag only. Calendar unavailable → manual blackout windows. No calendar integration is connected yet.
- Permissions: pullback in matching trend; sweep reversal in RANGE (weak-countertrend exception off until validated); ORB only after the opening range completes and only in regimes listed in `orbValidatedRegimes` (empty by default). Every transition is returned on `output.transition` for logging.

## Strategies (Phase 7) — `src/strategies/`
`trendPullback`, `sweepReversal`, `orbRetest` each return a `candidate` or `rejected` result with every rule's pass/fail. They never publish; risk, cost, timing gates and the publication validator still apply.
- Common: trigger = latest completed M5 bar closing at `asOf`; stop distance 0.8–2.0 × ATR14 (structural stop, never tightened); TP1 = 1R, TP2 = 2R; gross RR >= 1.5; reject when a key-level cluster sits between entry and TP1; 15-minute pair+side cooldown; net EV computed only when round-trip cost AND a validated win rate are supplied.
- Pullback: impulse L→H, confirmed pullback swing P must sit between the 0.382 and 0.786 retracement; touch of EMA20 within 8 bars; no close beyond EMA50; engulfing/pin/displacement closing beyond the previous bar; RSI side + direction. SL = P ∓ (0.2 ATR + spread buffer).
- Sweep reversal: sweep/fakeout at a key cluster; entry mode must match `sweepEntryMode`; |slope50| >= 0.6 against direction rejected unless the level is within 0.15 ATR of the previous-day extreme; rejected if price traded beyond the sweep extreme after the sweep. SL = extreme ± (0.2 ATR + spread buffer).
- ORB: OR complete, width 1.5–6 ATR, displacement breakout + retest within 6 bars, one attempt per side per forex day, only in regimes listed in `orbValidatedRegimes`. SL = retest extreme ± spread buffer.

## Scoring, cost & EV (Phase 8) — `src/scoring/`
Score is a ranking value, not a win probability. Components: bias 25 aligned / 10 neutral (conflict = hard reject); pattern 20·Q (engulfing, pin, sweep, fakeout) or 10·Q (breakout types), best single pattern only, one event counted once; path 15 (≥2R clear) / 8 (≥1.5R) else hard reject; momentum 5·clamp(±(RSI−50)/20) + 5·clamp(±slope50/1), missing half = 0; ATR pct 30–80 → 10; timing 10 in 19:00–21:30 IST else 5; USD proxy 5 only with a configured real source; cost_R ≤ 0.10 → 5. Penalties: validated countertrend −15, news ±30 min −20 (hard blackout rejects instead). Final = clamp(100·(points − penalties)/availableMax); without a USD proxy availableMax = 95. Threshold 65 (research starting point).
- Cost: spread vs mid = half entry + half exit (entry half skipped when entry is already ask/bid), 2× slippage, commission ×2 converted to price units per unit. Any unknown input → cost incomplete → no EV.
- EV_net = mean net realized R of out-of-sample outcomes for the exact strategy/pair/regime/policy, min 100 samples, threshold +0.10R; else unavailable and publication is refused. The p·W − (1−p)·L − cost formula is diagnostic only for binary exits.
- Win probability is never displayed unless a validated calibration (≤ 8 features) beat its baseline Brier score on untouched test data.
- `decide()` publishes the best fully-gated candidate or returns NO_VALID_SETUP with reasons per strategy.
