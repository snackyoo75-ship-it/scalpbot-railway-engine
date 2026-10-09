import { describe, expect, it } from "vitest";
import type { Candle } from "../indicators/core.js";
import type { Cluster } from "../structure/cluster.js";
import { DEFAULT_REGIME_CONFIG } from "../regime/regime.js";
import { DEFAULT_STRATEGY_CONFIG, orbRetest, sweepReversal, trendPullback, type StrategyContext, type StrategyResult } from "./strategies.js";

const T0 = Date.parse("2026-01-06T10:00:00Z");
type Row = [number, number, number, number];
const bar = (m: number): Row => [m, m + 1, m - 1, m];
const mk = (rows: Row[]): Candle[] => rows.map(([o, h, l, c], i) => ({ time: new Date(T0 + i * 300_000).toISOString(), open: o, high: h, low: l, close: c, complete: true }));
const closeOf = (c: Candle[]) => new Date(Date.parse(c.at(-1)!.time) + 300_000).toISOString();
const key = (price: number, isKey = true): Cluster => ({ price, low: price, high: price, strength: 2, isKey, constituents: [], availableAt: new Date(T0).toISOString() });

function ctx(rows: Row[], over: Partial<StrategyContext> = {}): StrategyContext {
  const m5 = mk(rows);
  const n = m5.length;
  return {
    pair: "XAUUSD", asOf: closeOf(m5), m5, atr14: new Array(n).fill(10), ema20: new Array(n).fill(120), ema50: new Array(n).fill(110),
    rsi14: [...new Array(n - 1).fill(52), 58], slope50: 0, regime: "TREND_UP", m15Bias: "bull", spread: 0.5, keyLevels: [],
    previousDay: null, openingRange: null, recent: [], orbAttempts: [], roundTripCost: null, estimatedWinRate: null, ...over,
  };
}
const failed = (r: StrategyResult) => r.rules.filter((x) => !x.pass).map((x) => x.rule);

// L=99 (idx2), H=141 (idx7), P=117 (idx11, confirmed at 13); trigger displacement idx14.
const PULL: Row[] = [110, 105, 100, 106, 112, 120, 130, 140, 135, 130, 125, 118, 122, 124].map(bar);
PULL.push([124, 134, 123.5, 133.5]);

describe("trend pullback", () => {
  it("positive: produces a candidate with structural stop and full breakdown", () => {
    const r = trendPullback(ctx(PULL));
    expect(failed(r)).toEqual([]);
    expect(r.status).toBe("candidate");
    if (r.status !== "candidate") return;
    expect(r.side).toBe("BUY");
    expect(r.stopLoss).toBeCloseTo(117 - 2 - 0.5, 9);
    expect(r.stopAtr).toBeCloseTo(1.9, 9);
    expect(r.tp1).toBeCloseTo(133.5 + 19, 9);
    expect(r.tp2).toBeCloseTo(133.5 + 38, 9);
    expect(r.grossRR).toBe(2);
    expect(r.netEV.status).toBe("unavailable");
    expect(r.rules.length).toBeGreaterThan(10);
  });
  it("net EV after costs when cost and validated win rate are known", () => {
    const r = trendPullback(ctx(PULL, { roundTripCost: 1.9, estimatedWinRate: 0.4 }));
    if (r.status !== "candidate" || r.netEV.status !== "ok") throw new Error("expected EV");
    expect(r.netEV.perTradeR).toBeCloseTo(0.4 * 2 - 0.6 - 0.1, 12);
  });
  it.each([
    ["eligible regime", { regime: "RANGE" as const }],
    ["M15 bias agrees", { m15Bias: "bear" as const }],
    ["RSI14 > 50 and rising", { rsi14: [...new Array(14).fill(60), 58] }],
    ["RSI14 > 50 and rising", { rsi14: [...new Array(14).fill(40), 49] }],
    ["pulled toward EMA20 within window", { ema20: new Array(15).fill(100) }],
    ["no pullback close beyond EMA50", { ema50: new Array(15).fill(119) }],
    ["spread valid", { spread: null }],
    ["outside duplicate cooldown", { recent: [{ pair: "XAUUSD" as const, side: "BUY" as const, time: new Date(T0 + 14 * 300_000).toISOString() }] }],
    ["no qualified opposing key level before TP1", { keyLevels: [key(150)] }],
    ["trigger candle is latest closed bar", { asOf: new Date(T0 + 16 * 300_000).toISOString() }],
  ])("negative: %s", (rule, over) => {
    const r = trendPullback(ctx(PULL, over as Partial<StrategyContext>));
    expect(r.status).toBe("rejected");
    expect(failed(r)).toContain(rule);
  });
  it("cooldown boundary: exactly 15 minutes later is allowed", () => {
    const at = Date.parse(closeOf(mk(PULL))) - 15 * 60_000;
    expect(trendPullback(ctx(PULL, { recent: [{ pair: "XAUUSD", side: "BUY", time: new Date(at).toISOString() }] })).status).toBe("candidate");
  });
  it("non-key level in path does not block", () => {
    expect(trendPullback(ctx(PULL, { keyLevels: [key(150, false)] })).status).toBe("candidate");
  });
  it("forming trigger candle rejected", () => {
    const c = ctx(PULL);
    c.m5[c.m5.length - 1] = { ...c.m5.at(-1)!, complete: false };
    expect(failed(trendPullback(c))).toContain("trigger candle completed");
  });
  it("trigger must close beyond previous high", () => {
    const rows = [...PULL.slice(0, -1), [116, 125, 115.8, 124.9] as Row];
    expect(failed(trendPullback(ctx(rows)))).toContain("trigger closes beyond previous candle boundary");
  });
  it("too-wide structural stop is rejected, never tightened", () => {
    const r = trendPullback(ctx(PULL, { atr14: new Array(15).fill(9) }));
    expect(failed(r)).toContain("stop distance within ATR band");
  });
  it("retracement too shallow rejected", () => {
    const rows = PULL.map((x) => [...x] as Row);
    rows[11] = bar(128);
    rows[10] = bar(131);
    rows[12] = bar(132);
    rows[13] = bar(133);
    rows[14] = [133, 143, 132.5, 142.5];
    expect(failed(trendPullback(ctx(rows)))).toContain("retracement in 0.382–0.786 context of last swing");
  });
});

// Immediate sell-side sweep of key level 100 on the last bar.
const SWEEP: Row[] = [bar(95), bar(96), bar(95), [99, 105, 98, 99]];

describe("sweep reversal", () => {
  const base = { regime: "RANGE" as const, keyLevels: [key(100)] };
  it("positive: immediate-on-close SELL", () => {
    const r = sweepReversal(ctx(SWEEP, base));
    expect(failed(r)).toEqual([]);
    if (r.status !== "candidate") throw new Error("expected candidate");
    expect(r.side).toBe("SELL");
    expect(r.entryMode).toBe("immediate_on_close");
    expect(r.stopLoss).toBeCloseTo(105 + 2 + 0.5, 9);
    expect(r.stopAtr).toBeCloseTo(0.85, 9);
  });
  it("negative: wrong regime", () => {
    expect(failed(sweepReversal(ctx(SWEEP, { ...base, regime: "TREND_UP" })))).toContain("regime permits strategy/direction");
  });
  it("negative: level not qualified", () => {
    expect(failed(sweepReversal(ctx(SWEEP, { ...base, keyLevels: [key(100, false)] })))).toContain("sweep or fakeout at qualified key level");
  });
  it("negative: entry mode mismatch with configuration", () => {
    const r = sweepReversal(ctx(SWEEP, base), { ...DEFAULT_STRATEGY_CONFIG, sweepEntryMode: "confirmation" });
    expect(failed(r)).toContain("entry mode matches configuration");
  });
  it("countertrend slope >= 0.6 rejected unless at previous-day high", () => {
    expect(failed(sweepReversal(ctx(SWEEP, { ...base, slope50: 0.6 })))).toContain("countertrend slope filter");
    expect(sweepReversal(ctx(SWEEP, { ...base, slope50: 0.59 })).status).toBe("candidate");
    expect(sweepReversal(ctx(SWEEP, { ...base, slope50: 0.9, previousDay: { high: 101.5, low: 50 } })).status).toBe("candidate");
    expect(failed(sweepReversal(ctx(SWEEP, { ...base, slope50: 0.9, previousDay: { high: 101.6, low: 50 } })))).toContain("countertrend slope filter");
  });
  it("negative: opposing key level within 1R", () => {
    expect(failed(sweepReversal(ctx(SWEEP, { ...base, keyLevels: [key(100), key(95)] })))).toContain("no qualified opposing key level before TP1");
  });
  it("negative: invalidated setup (confirmation mode)", () => {
    // sweep bar 1 (high 105), bar 2 trades above the sweep extreme (111), bar 3 confirms below 99
    const rows: Row[] = [bar(95), [100, 105, 99, 103], [103, 111, 100.5, 101], [100, 100.2, 97, 98]];
    const r = sweepReversal(ctx(rows, base), { ...DEFAULT_STRATEGY_CONFIG, sweepEntryMode: "confirmation" });
    expect(failed(r)).toContain("setup not invalidated");
  });
});

// OR 80–100 (width 2 ATR); breakout displacement idx1, pin-bar retest idx3.
const ORB: Row[] = [bar(95), [99, 110, 99, 109], bar(108), [105, 106.5, 96, 106]];
describe("ORB retest", () => {
  const or = { high: 100, low: 80, availableAt: new Date(T0).toISOString(), dayKey: "2026-01-06" };
  const regime = { ...DEFAULT_STRATEGY_CONFIG.regime, orbValidatedRegimes: ["TREND_UP" as const] };
  const cfg = { ...DEFAULT_STRATEGY_CONFIG, regime };
  it("positive: BUY with stop at retest low", () => {
    const r = orbRetest(ctx(ORB, { openingRange: or }), cfg);
    expect(failed(r)).toEqual([]);
    if (r.status !== "candidate") throw new Error("expected candidate");
    expect(r.stopLoss).toBeCloseTo(95.5, 9);
    expect(r.structuralInvalidation).toBe(96);
  });
  it("disabled by default until a regime is validated", () => {
    expect(failed(orbRetest(ctx(ORB, { openingRange: or })))).toContain("regime permits strategy/direction");
    expect(DEFAULT_REGIME_CONFIG.orbValidatedRegimes).toEqual([]);
  });
  it("one attempt per direction per day", () => {
    expect(failed(orbRetest(ctx(ORB, { openingRange: or, orbAttempts: ["2026-01-06:BUY"] }), cfg))).toContain("one attempt per direction per day");
    expect(orbRetest(ctx(ORB, { openingRange: or, orbAttempts: ["2026-01-06:SELL", "2026-01-05:BUY"] }), cfg).status).toBe("candidate");
  });
  it("OR width band (1.5–6 ATR inclusive)", () => {
    expect(orbRetest(ctx(ORB, { openingRange: { ...or, low: 85 } }), cfg).status).toBe("candidate");
    expect(failed(orbRetest(ctx(ORB, { openingRange: { ...or, low: 85.1 } }), cfg))).toContain("OR width / ATR14 within band");
    expect(failed(orbRetest(ctx(ORB, { openingRange: { ...or, low: 39 } }), cfg))).toContain("OR width / ATR14 within band");
  });
  it("opening range not formed yet", () => {
    const r = orbRetest(ctx(ORB, { openingRange: { ...or, availableAt: new Date(T0 + 3_600_000).toISOString() } }), cfg);
    expect(failed(r)).toContain("opening range fully formed");
  });
  it("structural stop too tight is rejected (no swapping to OR boundary)", () => {
    const rows = [...ORB.slice(0, 3), [104, 106, 100.5, 105.5] as Row];
    expect(failed(orbRetest(ctx(rows, { openingRange: or }), cfg))).toContain("stop distance within ATR band");
  });
});
