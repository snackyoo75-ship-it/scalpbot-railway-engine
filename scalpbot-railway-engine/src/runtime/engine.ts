/**
 * The running worker: OANDA practice stream + REST candles → candle store → analysis on every M5 close and on
 * user requests → app endpoints. Every external effect goes through the dashboard's worker API; nothing here
 * writes to the database directly and nothing places broker orders.
 */
import { candlesPath, INSTRUMENTS, type OandaConfig } from "../oanda/config.js";
import { displayPrecisionOf, parseCandlesResponse, type StreamMsg } from "../oanda/parse.js";
import { bucketStart, CandleAggregator, expectedOpen, feedState, findMissingBars, reconcile, TF_MIN, type BuiltCandle, type Timeframe } from "../oanda/pipeline.js";
import { runPricingStream } from "../oanda/stream-client.js";
import { INITIAL_TRACKER, type Pair, type TrackerState } from "../regime/regime.js";
import type { Side } from "../strategies/strategies.js";
import { analyze, fromOandaPair, toOandaPair, CONFIG_VERSION, type AnalysisResult, type BrokerCosts } from "./analysis.js";
import type { AppClient } from "./app-client.js";
import { closingTimeframes, fetchCount, fromRest, MarketStore, type StoredCandle } from "./market-store.js";

export const ENGINE_VERSION = "1.0.0";
const TFS: Timeframe[] = ["M1", "M5", "M15"];
const PAIRS: Pair[] = ["XAUUSD", "EURUSD"];

export type WorkerSettings = {
  system_paused: boolean;
  enabled_pairs: string[];
  controls: Record<string, boolean>;
  risk_config: Record<string, unknown> | null;
  strategies: { strategy_key: string; pair: string; enabled: boolean }[];
  server_time: string;
};

type PairState = {
  quote: { bid: number; ask: number; time: string } | null;
  lastTickAt: string | null;
  lastTradeable: boolean;
  aggregator: CandleAggregator;
  local: Map<string, BuiltCandle>;
  tracker: TrackerState;
  recent: { pair: Pair; side: Side; time: string }[];
  orbAttempts: string[];
  discrepancies: { timeframe: Timeframe; ts: string; field: "open" | "high" | "low" | "close"; local_value: number; source_value: number }[];
  recon: Record<Timeframe, { state: "pending" | "ok" | "discrepancies" | "failed"; count: number; at: string | null }>;
  backfilled: Record<Timeframe, boolean>;
  lastError: string | null;
  precision: number | null;
  lastDecision: { asOf: string; result: string; detail: string } | null;
};

export type EngineDeps = {
  oanda: OandaConfig;
  app: AppClient;
  workerId: string;
  dryRun: boolean;
  costs: BrokerCosts;
  manualBlackouts: { start: string; end: string; reason: string }[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;
};

export class Engine {
  readonly store = new MarketStore();
  private pairs = new Map<Pair, PairState>();
  private streamState: "connecting" | "open" | "degraded" | "disconnected" = "disconnected";
  private lastHeartbeatAt: string | null = null;
  private settings: WorkerSettings | null = null;
  private settingsAt: string | null = null;
  private lastCycleAt: string | null = null;
  private lastRequestAt: string | null = null;
  private startedAt = Date.now();
  private abort = new AbortController();
  private timers: ReturnType<typeof setInterval>[] = [];
  private barTimer: ReturnType<typeof setTimeout> | undefined;
  private busy = { bar: false, request: false, heartbeat: false };
  private readonly f: typeof fetch;
  private readonly now: () => Date;
  private readonly log: NonNullable<EngineDeps["log"]>;

  constructor(private readonly d: EngineDeps) {
    this.f = d.fetchImpl ?? fetch;
    this.now = d.now ?? (() => new Date());
    this.log = d.log ?? ((level, msg, data) => console[level === "info" ? "log" : level](JSON.stringify({ t: new Date().toISOString(), level, msg, ...data })));
    for (const p of PAIRS) {
      this.pairs.set(p, {
        quote: null, lastTickAt: null, lastTradeable: false, aggregator: new CandleAggregator(TFS), local: new Map(), tracker: INITIAL_TRACKER,
        recent: [], orbAttempts: [], discrepancies: [],
        recon: { M1: { state: "pending", count: 0, at: null }, M5: { state: "pending", count: 0, at: null }, M15: { state: "pending", count: 0, at: null } },
        backfilled: { M1: false, M5: false, M15: false }, lastError: null, precision: null, lastDecision: null,
      });
    }
  }

  private ps(p: Pair) {
    return this.pairs.get(p)!;
  }

  /* ------------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    this.log("info", "engine starting", { version: ENGINE_VERSION, config: CONFIG_VERSION, dry_run: this.d.dryRun, worker: this.d.workerId });
    await this.pollSettings();
    await this.loadPrecision();
    for (const p of PAIRS) for (const tf of TFS) await this.syncTf(p, tf);
    void runPricingStream(this.d.oanda, (m) => this.onStream(m), (s) => {
      this.streamState = s.state;
      if (s.error) for (const p of PAIRS) this.ps(p).lastError = `stream: ${s.error}`;
      this.log(s.state === "open" ? "info" : "warn", `stream ${s.state}`, s.error ? { error: s.error } : undefined);
    }, { fetchImpl: this.f, signal: this.abort.signal });
    await this.heartbeat();
    this.timers.push(setInterval(() => void this.heartbeat(), 30_000));
    this.timers.push(setInterval(() => void this.pollSettings(), 60_000));
    this.timers.push(setInterval(() => void this.pollRequests(), 5_000));
    this.scheduleBar();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.barTimer);
    await this.d.app.call("POST", "health", { worker_id: this.d.workerId, status: "down", version: ENGINE_VERSION, details: { reason: "shutdown" } });
    this.log("info", "engine stopped");
  }

  /* ------------------------------------------------------------ market data */

  onStream(m: StreamMsg): void {
    if (m.kind === "heartbeat") {
      this.lastHeartbeatAt = m.time;
      return;
    }
    if (m.kind === "malformed") {
      this.log("warn", "malformed stream line", { reason: m.reason });
      return;
    }
    if (m.kind !== "price") return;
    const pair = fromOandaPair(m.instrument);
    if (!pair) return;
    const s = this.ps(pair);
    s.lastTradeable = m.tradeable;
    if (!m.tradeable || m.bid === null || m.ask === null) return;
    s.quote = { bid: m.bid, ask: m.ask, time: m.time };
    s.lastTickAt = m.time;
    for (const c of s.aggregator.onPrice({ time: m.time, bid: m.bid, ask: m.ask })) this.keepLocal(s, c);
  }

  private keepLocal(s: PairState, c: BuiltCandle) {
    s.local.set(`${c.timeframe}:${c.ts}`, c);
    if (s.local.size > 300) s.local.delete(s.local.keys().next().value!);
  }

  private async loadPrecision() {
    try {
      const res = await this.f(`${this.d.oanda.rest}/v3/accounts/${encodeURIComponent(this.d.oanda.OANDA_ACCOUNT_ID)}/instruments?instruments=${INSTRUMENTS.join(",")}`, {
        headers: { Authorization: `Bearer ${this.d.oanda.OANDA_TOKEN}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { instruments?: { name?: string }[] };
      for (const i of body.instruments ?? []) {
        const p = fromOandaPair(String(i.name));
        if (p) this.ps(p).precision = displayPrecisionOf(i);
      }
    } catch (e) {
      this.log("warn", "instrument metadata unavailable", { error: String(e) });
    }
  }

  /** Fetches completed candles from OANDA REST, stores them, reconciles against local aggregates, sends new ones to the app. */
  async syncTf(pair: Pair, tf: Timeframe): Promise<StoredCandle[]> {
    const s = this.ps(pair);
    const count = fetchCount(this.store.lastTs(pair, tf), tf, this.now().getTime());
    try {
      const res = await this.f(this.d.oanda.rest + candlesPath(toOandaPair(pair), tf, count), { headers: { Authorization: `Bearer ${this.d.oanda.OANDA_TOKEN}` } });
      if (!res.ok) throw new Error(`candles ${tf} HTTP ${res.status}`);
      const parsed = parseCandlesResponse(await res.json());
      if (parsed.rejected.length) this.log("warn", "rejected OANDA candles", { pair, tf, rejected: parsed.rejected.slice(0, 10) });
      const complete = parsed.candles.map(fromRest).filter((c): c is StoredCandle => c !== null);
      const changed = this.store.upsert(pair, tf, complete);
      s.backfilled[tf] = true;
      this.reconcileLocal(pair, tf, changed);
      await this.sendCandles(pair, tf, changed);
      return changed;
    } catch (e) {
      s.lastError = e instanceof Error ? e.message : String(e);
      s.recon[tf].state = "failed";
      this.log("error", "candle sync failed", { pair, tf, error: s.lastError });
      return [];
    }
  }

  private reconcileLocal(pair: Pair, tf: Timeframe, rest: StoredCandle[]) {
    const s = this.ps(pair);
    let compared = 0;
    for (const c of rest) {
      const local = s.local.get(`${tf}:${c.time}`);
      if (!local) continue;
      compared++;
      for (const d of reconcile(local, { o: c.open, h: c.high, l: c.low, c: c.close })) {
        s.discrepancies.push({ timeframe: tf, ts: c.time, field: d.field, local_value: d.local, source_value: d.source });
        s.recon[tf].count++;
      }
    }
    if (s.discrepancies.length > 200) s.discrepancies.splice(0, s.discrepancies.length - 200);
    if (compared) s.recon[tf] = { state: s.recon[tf].count > 0 ? "discrepancies" : "ok", count: s.recon[tf].count, at: this.now().toISOString() };
  }

  private async sendCandles(pair: Pair, tf: Timeframe, candles: StoredCandle[]) {
    const s = this.ps(pair);
    for (let i = 0; i < candles.length; i += 500) {
      const batch = candles.slice(i, i + 500).map((c) => {
        const local = s.local.get(`${tf}:${c.time}`);
        return {
          pair: toOandaPair(pair), timeframe: tf, ts: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
          volume: c.tickVolume, volume_type: c.tickVolume === null ? "none" : "tick",
          bid_close: c.bidClose, ask_close: c.askClose,
          spread_avg: local ? local.spreadSum / local.tickCount : null, spread_max: local ? local.spreadMax : null,
          source: "oanda-practice", is_complete: true,
        };
      });
      const r = await this.d.app.call<{ accepted?: number; quarantined?: unknown[] }>("POST", "ingest-candles", { candles: batch });
      if (r.status !== 200) this.log("error", "ingest-candles failed", { pair, tf, status: r.status, error: r.error, body: r.body as never });
      else if (r.body?.quarantined?.length) this.log("warn", "candles quarantined by app", { pair, tf, count: r.body.quarantined.length });
    }
  }

  /* ------------------------------------------------------------ scheduling */

  private scheduleBar() {
    const nowMs = this.now().getTime();
    const next = Math.floor(nowMs / 60_000) * 60_000 + 60_000;
    this.barTimer = setTimeout(() => void this.onMinute(next), next - nowMs + this.d.oanda.CANDLE_FETCH_DELAY_MS);
  }

  /** Runs once per UTC minute, CANDLE_FETCH_DELAY_MS after the boundary so OANDA has finalised the bar. */
  async onMinute(boundaryMs: number): Promise<void> {
    try {
      if (this.busy.bar) return;
      this.busy.bar = true;
      const nowIso = this.now().toISOString();
      for (const p of PAIRS) for (const c of this.ps(p).aggregator.closeUpTo(nowIso)) this.keepLocal(this.ps(p), c);
      const tfs = closingTimeframes(boundaryMs);
      for (const p of PAIRS) for (const tf of tfs) await this.syncTf(p, tf);
      if (tfs.includes("M5")) {
        const asOf = new Date(boundaryMs).toISOString();
        for (const p of PAIRS) await this.scan(p, asOf);
        this.lastCycleAt = this.now().toISOString();
      }
    } catch (e) {
      this.log("error", "bar cycle failed", { error: String(e) });
    } finally {
      this.busy.bar = false;
      if (!this.abort.signal.aborted) this.scheduleBar();
    }
  }

  /* ------------------------------------------------------------ analysis */

  private feed(pair: Pair) {
    const s = this.ps(pair);
    const state = feedState({ streamOpen: this.streamState === "open", lastUsableTickAt: s.lastTickAt, now: this.now(), lastTradeable: s.lastTradeable });
    return { state, fresh: state === "connected", detail: `stream ${this.streamState}, feed ${state}, last tick ${s.lastTickAt ?? "never"}` };
  }

  private globalRisk(pair: Pair): { ok: boolean; detail: string } {
    const st = this.settings;
    if (!st) return { ok: false, detail: "settings unavailable" };
    const why: string[] = [];
    if (st.system_paused !== false) why.push("system paused");
    if (st.controls["kill_switch"] === true) why.push("kill switch on");
    if (!st.enabled_pairs.includes(toOandaPair(pair))) why.push("pair not enabled");
    if (!st.risk_config) why.push("no active risk config");
    if (!st.strategies.some((x) => x.pair === toOandaPair(pair) && x.enabled)) why.push("no enabled strategy for pair");
    return { ok: why.length === 0, detail: why.length ? why.join(", ") : "ok" };
  }

  runAnalysis(pair: Pair, asOf: string): AnalysisResult {
    const s = this.ps(pair);
    const f = this.feed(pair);
    const res = analyze({
      pair, asOf,
      m1: this.store.candles(pair, "M1"), m5: this.store.candles(pair, "M5"), m15: this.store.candles(pair, "M15"),
      spreads: this.store.spreads(pair), quote: s.quote, feedFresh: f.fresh, feedDetail: f.detail, tracker: s.tracker,
      news: { status: "unavailable", manualBlackouts: this.d.manualBlackouts },
      recent: s.recent, orbAttempts: s.orbAttempts, costs: this.d.costs, outcomes: null, globalRisk: this.globalRisk(pair),
    }, this.now);
    s.tracker = res.tracker;
    if (res.regime?.transition) this.log("info", "regime transition", { pair, ...res.regime.transition });
    const detail = res.decision.result === "PUBLISH" ? `${res.decision.candidate.strategy} ${res.decision.candidate.side}` : res.decision.reasons.map((r) => `${r.strategy}: ${r.reasons[0] ?? ""}`).join(" | ");
    s.lastDecision = { asOf, result: res.decision.result, detail: detail.slice(0, 300) };
    return res;
  }

  /** Scheduled evaluation at each M5 close. The regime tracker always advances; submission respects controls. */
  async scan(pair: Pair, asOf: string): Promise<AnalysisResult> {
    const res = this.runAnalysis(pair, asOf);
    this.log("info", "scan", { pair, asOf, result: res.decision.result, regime: res.regime?.active ?? null, scored: res.scored });
    const st = this.settings;
    if (res.payload && st?.controls["scheduled_signals_enabled"] === true) await this.submit(pair, res);
    return res;
  }

  /** Sends a fully-gated signal. The app re-runs eligibility, breakers and dry-run before anything is published. */
  private async submit(pair: Pair, res: AnalysisResult): Promise<{ status: string; signalId?: string; reason?: string }> {
    if (!res.payload || res.decision.result !== "PUBLISH") return { status: "no_setup" };
    if (this.d.dryRun) {
      this.log("info", "engine DRY_RUN: signal not submitted", { pair, key: res.payload.idempotency_key });
      return { status: "engine_dry_run", reason: "engine DRY_RUN=true: not submitted" };
    }
    if (this.settings?.controls["kill_switch"] === true) return { status: "blocked", reason: "kill switch on" };
    const r = await this.d.app.call<{ signal_id?: string; status?: string; rejected?: boolean; reasons?: { code: string; message: string }[]; duplicate?: boolean }>("POST", "ingest-signal", res.payload);
    const c = res.decision.candidate;
    const s = this.ps(pair);
    if (r.status === 201 || (r.status === 200 && r.body?.duplicate)) {
      s.recent.push({ pair, side: c.side, time: res.asOf });
      if (s.recent.length > 50) s.recent.shift();
      if (c.strategy === "orb_retest") s.orbAttempts.push(`${res.asOf.slice(0, 10)}:${c.side}`);
      this.log("info", "signal accepted by app", { pair, signal_id: r.body?.signal_id, status: r.body?.status });
      if (r.body?.status === "published" && r.body.signal_id && !r.body.duplicate) {
        const n = await this.d.app.call("POST", "notify-signal", { signal_id: r.body.signal_id });
        if (n.status >= 400 || n.status === 0) this.log("warn", "telegram notify failed", { status: n.status, body: n.body as never });
      }
      return { status: r.body?.status ?? "accepted", signalId: r.body?.signal_id };
    }
    const reason = r.body?.reasons?.map((x) => x.message).join("; ") ?? r.error ?? `HTTP ${r.status}`;
    this.log("warn", "signal rejected by app", { pair, status: r.status, reason });
    return { status: "rejected", reason };
  }

  /* ------------------------------------------------------------ user requests */

  async pollRequests(): Promise<void> {
    if (this.busy.request) return;
    this.busy.request = true;
    try {
      const r = await this.d.app.call<{ request: { id: string; symbol: string } | null }>("POST", "claim-request", {});
      if (r.status !== 200 || !r.body?.request) return;
      this.lastRequestAt = this.now().toISOString();
      await this.processRequest(r.body.request.id, r.body.request.symbol);
    } finally {
      this.busy.request = false;
    }
  }

  async processRequest(id: string, symbol: string): Promise<void> {
    const report = (b: Record<string, unknown>) => this.d.app.call("POST", "report-stage", { request_id: id, ...b });
    const pair = symbol === "XAUUSD" || symbol === "EURUSD" ? (symbol as Pair) : null;
    try {
      if (!pair) {
        await report({ stage: "accepted", status: "failed", detail: `unsupported symbol ${symbol}`, request_status: "rejected", rejection_reason: "unsupported symbol" });
        return;
      }
      if (this.settings?.controls["signal_requests_enabled"] === false) {
        await report({ stage: "accepted", status: "failed", detail: "signal requests are disabled", request_status: "rejected", rejection_reason: "signal requests disabled" });
        return;
      }
      const last = this.store.lastTs(pair, "M5");
      const asOf = last ? new Date(Date.parse(last) + 300_000).toISOString() : bucketStart(this.now().toISOString(), "M5");
      const res = this.runAnalysis(pair, asOf);
      const stages = res.stages;
      for (const st of stages.slice(0, -1)) await report({ stage: st.stage, status: st.status, detail: st.detail, started_at: st.started_at, completed_at: st.completed_at });
      const final = stages[stages.length - 1]!;
      let outcome = { request_status: "rejected", rejection_reason: "NO_VALID_SETUP", detail: final.detail };
      if (res.payload) {
        const sub = await this.submit(pair, res);
        outcome = sub.status === "published" || sub.status === "candidate"
          ? { request_status: "completed", rejection_reason: "", detail: `signal ${sub.status}${sub.signalId ? ` (${sub.signalId})` : ""}` }
          : { request_status: "rejected", rejection_reason: (sub.reason ?? sub.status).slice(0, 500), detail: sub.reason ?? sub.status };
      } else {
        const why = res.decision.result === "NO_VALID_SETUP" ? res.decision.reasons.map((r) => `${r.strategy}: ${r.reasons[0] ?? ""}`).join(" | ") : "";
        outcome.rejection_reason = `NO_VALID_SETUP${why ? ` — ${why}` : ""}`.slice(0, 500);
      }
      await report({
        stage: final.stage, status: final.status, detail: outcome.detail.slice(0, 500), started_at: final.started_at, completed_at: this.now().toISOString(),
        request_status: outcome.request_status, ...(outcome.rejection_reason ? { rejection_reason: outcome.rejection_reason } : {}),
      });
    } catch (e) {
      this.log("error", "request failed", { id, error: String(e) });
      await report({ stage: "publish", status: "failed", detail: "engine error while processing", request_status: "failed", rejection_reason: "engine error" });
    }
  }

  /* ------------------------------------------------------------ settings & health */

  async pollSettings(): Promise<void> {
    const r = await this.d.app.call<WorkerSettings>("GET", "worker-settings");
    if (r.status === 200 && r.body) {
      this.settings = r.body;
      this.settingsAt = this.now().toISOString();
    } else {
      this.log("warn", "worker-settings unavailable", { status: r.status, error: r.error });
      if (r.status === 401) this.settings = null; // fail closed
    }
  }

  dataStatus(pair: Pair) {
    const s = this.ps(pair);
    const f = this.feed(pair);
    const now = this.now();
    const discrepancies = s.discrepancies.splice(0, 200);
    return {
      pair: toOandaPair(pair),
      source: "oanda-practice" as const,
      stream_state: this.streamState,
      feed_state: f.state,
      last_tick_at: s.lastTickAt,
      last_heartbeat_at: this.lastHeartbeatAt,
      last_tradeable: s.lastTradeable,
      last_error: s.lastError ? s.lastError.slice(0, 500) : null,
      display_precision: s.precision,
      timeframes: TFS.map((tf) => {
        const c = this.store.candles(pair, tf);
        const from = new Date(now.getTime() - 24 * 3_600_000).toISOString();
        const to = bucketStart(now.toISOString(), tf);
        const gaps = c.length ? findMissingBars(c.map((k) => k.time), tf, c[0]!.time > from ? c[0]!.time : from, to).length : 0;
        return {
          timeframe: tf, last_complete_candle_ts: c.at(-1)?.time ?? null, gap_count: gaps,
          reconciliation_state: s.recon[tf].state, discrepancy_count: s.recon[tf].count, last_reconciled_at: s.recon[tf].at, backfill_complete: s.backfilled[tf],
        };
      }),
      discrepancies,
    };
  }

  async heartbeat(): Promise<void> {
    if (this.busy.heartbeat) return;
    this.busy.heartbeat = true;
    try {
      const open = expectedOpen(this.now());
      const states = PAIRS.map((p) => this.feed(p).state);
      const healthy = this.streamState === "open" && (!open || states.every((s) => s === "connected"));
      const details = {
        engine_version: ENGINE_VERSION,
        config_version: CONFIG_VERSION,
        uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
        last_cycle_at: this.lastCycleAt,
        last_tick: Object.fromEntries(PAIRS.map((p) => [toOandaPair(p), this.ps(p).lastTickAt])),
        last_candle: Object.fromEntries(PAIRS.map((p) => [toOandaPair(p), Object.fromEntries(TFS.map((tf) => [tf, this.store.lastTs(p, tf)]))])),
        regime: Object.fromEntries(PAIRS.map((p) => [toOandaPair(p), this.ps(p).tracker.active])),
        last_decision: Object.fromEntries(PAIRS.map((p) => [toOandaPair(p), this.ps(p).lastDecision])),
        last_settings_poll_at: this.settingsAt,
        last_app_request_at: this.lastRequestAt,
        paused: this.settings ? this.settings.system_paused : null,
        engine_dry_run: this.d.dryRun,
        stream_state: this.streamState,
      };
      const hb = await this.d.app.call("POST", "health", { worker_id: this.d.workerId, status: healthy ? "ok" : "degraded", version: ENGINE_VERSION, details });
      if (hb.status !== 200) this.log("error", "heartbeat failed", { status: hb.status, error: hb.error, body: hb.body as never });
      for (const p of PAIRS) {
        const r = await this.d.app.call("POST", "ingest-data-status", this.dataStatus(p));
        if (r.status !== 200) this.log("error", "data status failed", { pair: p, status: r.status, body: r.body as never });
      }
    } finally {
      this.busy.heartbeat = false;
    }
  }

  /** Test/diagnostic accessor. */
  pairState(p: Pair) {
    const s = this.ps(p);
    return { quote: s.quote, lastTickAt: s.lastTickAt, tracker: s.tracker, lastDecision: s.lastDecision, recon: s.recon };
  }
  get tfMinutes() {
    return TF_MIN;
  }
}
