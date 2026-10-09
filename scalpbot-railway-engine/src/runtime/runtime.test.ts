import { describe, expect, it } from "vitest";
import type { Candle } from "../indicators/core.js";
import { INITIAL_TRACKER } from "../regime/regime.js";
import { analyze, type AnalysisInput } from "./analysis.js";
import { closingTimeframes, fetchCount, fromRest, MarketStore } from "./market-store.js";
import { Engine } from "./engine.js";
import type { AppClient } from "./app-client.js";

// Synthetic candles are TEST FIXTURES ONLY — never used by the running engine.
function series(endIso: string, stepMin: number, n: number, base: number): Candle[] {
  const end = Date.parse(endIso);
  const out: Candle[] = [];
  for (let k = n; k >= 1; k--) {
    const t = end - k * stepMin * 60_000;
    const x = base + Math.sin(k / 7) * base * 0.001 + (n - k) * base * 0.00001;
    out.push({ time: new Date(t).toISOString(), open: x, high: x * 1.0004, low: x * 0.9996, close: x * 1.0001, complete: true });
  }
  return out;
}

const ASOF = "2026-10-07T14:00:00.000Z"; // Wednesday
const STAGES = ["accepted", "feed", "candles", "indicators", "structure", "patterns", "regime", "strategies", "gates", "entry", "publish"];

function input(over: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    pair: "EURUSD", asOf: ASOF,
    m1: series(ASOF, 1, 400, 1.1), m5: series(ASOF, 5, 600, 1.1), m15: series(ASOF, 15, 300, 1.1),
    spreads: [], quote: { bid: 1.10009, ask: 1.10011, time: ASOF }, feedFresh: true, feedDetail: "test",
    tracker: INITIAL_TRACKER, news: { status: "unavailable", manualBlackouts: [] }, recent: [], orbAttempts: [],
    costs: { commissionPerSide: null, units: null, accountToQuote: null, slippagePerSide: null }, outcomes: null,
    globalRisk: { ok: true, detail: "ok" }, ...over,
  };
}
const clock = () => new Date(Date.parse(ASOF) + 2_000);

describe("analysis pass", () => {
  it("reports every workflow stage in order", () => {
    const r = analyze(input(), clock);
    expect(r.stages.map((s) => s.stage)).toEqual(STAGES);
  });

  it("stale feed fails the feed stage and skips the rest", () => {
    const r = analyze(input({ feedFresh: false, feedDetail: "feed stale" }), clock);
    expect(r.stages.find((s) => s.stage === "feed")?.status).toBe("failed");
    expect(r.stages.slice(2).every((s) => s.status === "skipped")).toBe(true);
    expect(r.payload).toBeNull();
  });

  it("missing candles are reported, never filled", () => {
    const m5 = series(ASOF, 5, 600, 1.1);
    m5.splice(300, 1);
    const r = analyze(input({ m5 }), clock);
    expect(r.stages.find((s) => s.stage === "candles")?.status).toBe("failed");
    expect(r.payload).toBeNull();
  });

  it("never produces a signal without validated out-of-sample outcomes", () => {
    const r = analyze(input(), clock);
    expect(r.decision.result).toBe("NO_VALID_SETUP");
    expect(r.payload).toBeNull();
  });
});

describe("market store", () => {
  it("keeps only complete REST candles", () => {
    const ohlc = { o: 1, h: 2, l: 0.5, c: 1.5 };
    expect(fromRest({ time: ASOF, complete: false, tickVolume: 3, mid: ohlc, bid: null, ask: null })).toBeNull();
    expect(fromRest({ time: ASOF, complete: true, tickVolume: 3, mid: ohlc, bid: null, ask: null })?.close).toBe(1.5);
  });

  it("detects new or changed candles and trims to the buffer limit", () => {
    const s = new MarketStore();
    const c = { time: ASOF, open: 1, high: 2, low: 0.5, close: 1.5, complete: true, tickVolume: 1, bidClose: 1.4, askClose: 1.6 };
    expect(s.upsert("EURUSD", "M15", [c])).toHaveLength(1);
    expect(s.upsert("EURUSD", "M15", [c])).toHaveLength(0);
    expect(s.upsert("EURUSD", "M15", [{ ...c, close: 1.6 }])).toHaveLength(1);
    const many = Array.from({ length: 700 }, (_, k) => ({ ...c, time: new Date(Date.parse(ASOF) + k * 900_000).toISOString() }));
    s.upsert("EURUSD", "M15", many);
    expect(s.candles("EURUSD", "M15")).toHaveLength(600);
    expect(s.spreads("EURUSD")).toHaveLength(0);
  });

  it("fetches enough candles to overlap the last stored bar", () => {
    expect(fetchCount(null, "M5", Date.parse(ASOF))).toBe(1500);
    expect(fetchCount(new Date(Date.parse(ASOF) - 300_000).toISOString(), "M5", Date.parse(ASOF))).toBe(5);
    expect(fetchCount(new Date(Date.parse(ASOF) - 100 * 300_000).toISOString(), "M5", Date.parse(ASOF))).toBe(103);
  });

  it("knows which bars close at a minute boundary", () => {
    expect(closingTimeframes(Date.parse("2026-10-07T14:15:00Z"))).toEqual(["M1", "M5", "M15"]);
    expect(closingTimeframes(Date.parse("2026-10-07T14:05:00Z"))).toEqual(["M1", "M5"]);
    expect(closingTimeframes(Date.parse("2026-10-07T14:07:00Z"))).toEqual(["M1"]);
  });
});

describe("engine request handling", () => {
  function fakeApp() {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const app = { call: async (method: string, path: string, body?: unknown) => (calls.push({ method, path, body }), { status: 200, body: { ok: true } }) } as unknown as AppClient;
    return { app, calls };
  }
  const oanda = { OANDA_TOKEN: "x".repeat(20), OANDA_ACCOUNT_ID: "101-004-1234567-001", OANDA_ENV: "practice" as const, CANDLE_FETCH_DELAY_MS: 0, DRY_RUN: "false" as const, rest: "http://none", stream: "http://none" };

  it("rejects a request with NO_VALID_SETUP when there is no live data, reporting real stages", async () => {
    const { app, calls } = fakeApp();
    const e = new Engine({ oanda, app, workerId: "test", dryRun: false, costs: { commissionPerSide: null, units: null, accountToQuote: null, slippagePerSide: null }, manualBlackouts: [], now: clock, log: () => undefined });
    await e.processRequest("00000000-0000-4000-8000-000000000001", "XAUUSD");
    const stages = calls.filter((c) => c.path === "report-stage").map((c) => c.body as { stage: string; status: string; request_status?: string; rejection_reason?: string });
    expect(stages.map((s) => s.stage)).toEqual(STAGES);
    expect(stages[1]!.status).toBe("failed");
    expect(stages.at(-1)!.request_status).toBe("rejected");
    expect(stages.at(-1)!.rejection_reason).toMatch(/^NO_VALID_SETUP/);
    expect(calls.some((c) => c.path === "ingest-signal")).toBe(false);
  });

  it("ignores untradeable prices and records tradeable ones", () => {
    const { app } = fakeApp();
    const e = new Engine({ oanda, app, workerId: "test", dryRun: true, costs: { commissionPerSide: null, units: null, accountToQuote: null, slippagePerSide: null }, manualBlackouts: [], now: clock, log: () => undefined });
    e.onStream({ kind: "price", instrument: "EUR_USD", time: ASOF, bid: 1.1, ask: 1.1002, mid: 1.1001, tradeable: false });
    expect(e.pairState("EURUSD").quote).toBeNull();
    e.onStream({ kind: "price", instrument: "EUR_USD", time: ASOF, bid: 1.1, ask: 1.1002, mid: 1.1001, tradeable: true });
    expect(e.pairState("EURUSD").quote).toEqual({ bid: 1.1, ask: 1.1002, time: ASOF });
  });
});
