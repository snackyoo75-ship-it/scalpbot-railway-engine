import { describe, expect, it } from "vitest";
import { allowedStrategies, classify, DEFAULT_REGIME_CONFIG, INITIAL_TRACKER, newsState, step, type RegimeInput, type TrackerState } from "./regime.js";

const T = Date.parse("2026-03-09T13:15:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function input(over: Partial<{ asOf: number; m15: Partial<RegimeInput["m15"]>; m5: Partial<RegimeInput["m5"]>; m1: Partial<RegimeInput["m1"]>; news: RegimeInput["news"] }> = {}): RegimeInput {
  const asOf = over.asOf ?? T;
  const m15Close = Math.floor(asOf / 900_000) * 900_000;
  return {
    pair: "XAUUSD",
    asOf: iso(asOf),
    m15: { closeTime: iso(m15Close), close: 2010, ema20: 2005, ema50: 2000, ema200: 1990, slope50: 0.5, adx14: 25, ...over.m15 },
    m5: { closeTime: iso(asOf), atrPercentile: 50, bbWidthPercentile: 50, ...over.m5 },
    m1: { closeTime: iso(asOf), volRatio: 1, ...over.m1 },
    news: over.news ?? { status: "verified", events: [] },
  };
}

describe("base classification", () => {
  it("trend up / down / range / mixed", () => {
    expect(classify(input()).regime).toBe("TREND_UP");
    expect(classify(input({ m15: { close: 1980, ema20: 1995, ema50: 2000, slope50: -0.3 } })).regime).toBe("TREND_DOWN");
    expect(classify(input({ m15: { adx14: 19.99, slope50: 0 } })).regime).toBe("RANGE");
    expect(classify(input({ m15: { adx14: 21, slope50: 0 } })).regime).toBe("MIXED");
  });
  it("threshold boundaries: slope 0.3 and ADX 22 inclusive; ADX 20 is not range", () => {
    expect(classify(input({ m15: { slope50: 0.3, adx14: 22 } })).regime).toBe("TREND_UP");
    expect(classify(input({ m15: { slope50: 0.2999 } })).regime).toBe("MIXED");
    expect(classify(input({ m15: { adx14: 20, slope50: 0 } })).regime).toBe("MIXED");
  });
  it("volatile boundaries are strict (> 90, > 2.5)", () => {
    expect(classify(input({ m5: { atrPercentile: 90 } })).regime).toBe("TREND_UP");
    expect(classify(input({ m5: { atrPercentile: 90.01 } })).regime).toBe("VOLATILE");
    expect(classify(input({ m1: { volRatio: 2.5 } })).regime).toBe("TREND_UP");
    expect(classify(input({ m1: { volRatio: 2.51 } })).regime).toBe("VOLATILE");
  });
});

describe("precedence conflicts", () => {
  const news = { status: "verified" as const, events: [{ id: "NFP", currency: "USD", impact: "high" as const, time: iso(T + 5 * 60_000), source: "cal" }] };
  it("1. data unavailable beats news", () => {
    expect(classify(input({ news, m15: { adx14: null } })).regime).toBe("DATA_UNAVAILABLE");
  });
  it("2. news beats other volatility and DEAD and trend", () => {
    const c = classify(input({ news, m5: { atrPercentile: 10, bbWidthPercentile: 10 } }));
    expect(c.regime).toBe("VOLATILE");
    expect(c.reason).toMatch(/NFP/);
  });
  it("3. volatile beats DEAD-looking BB and trend", () => {
    expect(classify(input({ m1: { volRatio: 3 }, m5: { atrPercentile: 10, bbWidthPercentile: 10 } })).regime).toBe("VOLATILE");
  });
  it("4. DEAD beats trend", () => {
    expect(classify(input({ m5: { atrPercentile: 19, bbWidthPercentile: 19 } })).regime).toBe("DEAD");
    expect(classify(input({ m5: { atrPercentile: 20, bbWidthPercentile: 19 } })).regime).toBe("TREND_UP");
  });
  it("5. trend beats range when ADX satisfies both? (impossible) — range requires ADX<20", () => {
    expect(classify(input({ m15: { adx14: 15 } })).regime).toBe("RANGE"); // slope ok but ADX too low for trend
  });
});

describe("staleness and forming bars", () => {
  it("M15 context older than one bar + tolerance is stale", () => {
    const at = T + 10 * 60_000; // latest M15 close is T
    expect(classify(input({ asOf: at, m15: { closeTime: iso(T) } })).regime).toBe("TREND_UP");
    const c = classify(input({ asOf: T + 20 * 60_000, m15: { closeTime: iso(T - 900_000) } }));
    expect(c.regime).toBe("DATA_UNAVAILABLE");
    expect(c.reason).toMatch(/M15 stale/);
  });
  it("a forming M15 or M5 bar never counts", () => {
    expect(classify(input({ m15: { closeTime: iso(T + 900_000) } })).reason).toMatch(/forming/);
    expect(classify(input({ m5: { closeTime: iso(T + 300_000) } })).reason).toMatch(/forming/);
  });
});

describe("news", () => {
  const ev = (minFromT: number, currency = "USD", impact: "high" | "medium" = "high") => ({ id: `e${minFromT}`, currency, impact, time: iso(T + minFromT * 60_000), source: "cal" });
  it("hard block ±10 inclusive, penalty ±30, irrelevant currency ignored", () => {
    expect(newsState({ status: "verified", events: [ev(10)] }, "XAUUSD", iso(T)).hardBlock).toBe(true);
    const s = newsState({ status: "verified", events: [ev(-11)] }, "XAUUSD", iso(T));
    expect(s).toMatchObject({ hardBlock: false, penalty: true });
    expect(newsState({ status: "verified", events: [ev(0, "EUR")] }, "XAUUSD", iso(T)).hardBlock).toBe(false);
    expect(newsState({ status: "verified", events: [ev(0, "USD", "medium")] }, "EURUSD", iso(T)).hardBlock).toBe(false);
  });
  it("calendar unavailable → manual blackout only", () => {
    const n = { status: "unavailable" as const, manualBlackouts: [{ start: iso(T - 60_000), end: iso(T + 60_000), reason: "ECB" }] };
    expect(classify(input({ news: n })).regime).toBe("VOLATILE");
    expect(classify(input({ news: { status: "unavailable", manualBlackouts: [] } })).regime).toBe("TREND_UP");
  });
  it("DST: event times are absolute UTC, so the US spring-forward day blocks at the right instant", () => {
    // 2026-03-09 08:30 EDT = 12:30 UTC (EST would be 13:30)
    const nfp = { id: "cpi", currency: "USD", impact: "high" as const, time: "2026-03-09T12:30:00Z", source: "cal" };
    expect(newsState({ status: "verified", events: [nfp] }, "XAUUSD", "2026-03-09T12:35:00Z").hardBlock).toBe(true);
    expect(newsState({ status: "verified", events: [nfp] }, "XAUUSD", "2026-03-09T13:30:00Z").hardBlock).toBe(false);
  });
});

describe("hysteresis", () => {
  const run = (start: TrackerState, seq: RegimeInput[]) => {
    let s = start;
    return seq.map((x) => {
      const r = step(s, x);
      s = r.state;
      return r.output;
    });
  };
  const bars = (n: number, m15: Partial<RegimeInput["m15"]> = {}, from = T) => Array.from({ length: n }, (_, i) => input({ asOf: from + i * 300_000, m15 }));

  it("needs 3 consecutive M5 bars to leave DATA_UNAVAILABLE, then logs one transition", () => {
    const out = run(INITIAL_TRACKER, bars(3));
    expect(out.map((o) => o.active)).toEqual(["DATA_UNAVAILABLE", "DATA_UNAVAILABLE", "TREND_UP"]);
    expect(out.map((o) => o.confirmations)).toEqual([1, 2, 0]);
    expect(out[2]!.transition).toMatchObject({ from: "DATA_UNAVAILABLE", to: "TREND_UP", immediate: false });
    expect(out[2]!.allowed).toEqual([{ strategy: "pullback", direction: "long" }]);
  });
  it("a single noisy bar does not switch; an interruption resets the count", () => {
    const up: TrackerState = { active: "TREND_UP", proposed: null, count: 0, lastM5Close: iso(T - 300_000), activeSince: null };
    const range = { adx14: 15 };
    const seq = [input({ asOf: T, m15: range }), input({ asOf: T + 300_000 }), input({ asOf: T + 600_000, m15: range }), input({ asOf: T + 900_000, m15: range }), input({ asOf: T + 1_200_000, m15: range })];
    const out = run(up, seq);
    expect(out.map((o) => o.active)).toEqual(["TREND_UP", "TREND_UP", "TREND_UP", "TREND_UP", "RANGE"]);
  });
  it("re-submitting the same M5 bar does not add a confirmation", () => {
    const x = input();
    const out = run(INITIAL_TRACKER, [x, x, x]);
    expect(out.map((o) => o.confirmations)).toEqual([1, 1, 1]);
  });
  it("gap in M5 bars resets confirmation", () => {
    const out = run(INITIAL_TRACKER, [input({ asOf: T }), input({ asOf: T + 300_000 }), input({ asOf: T + 900_000 })]);
    expect(out.map((o) => o.confirmations)).toEqual([1, 2, 1]);
  });
  it("news block and data loss are immediate", () => {
    const up: TrackerState = { active: "TREND_UP", proposed: null, count: 0, lastM5Close: iso(T - 300_000), activeSince: null };
    const news = { status: "verified" as const, events: [{ id: "FOMC", currency: "USD", impact: "high" as const, time: iso(T), source: "cal" }] };
    const r = step(up, input({ news }));
    expect(r.output.active).toBe("VOLATILE");
    expect(r.output.transition?.immediate).toBe(true);
    expect(r.output.allowed).toEqual([]);
    const d = step(up, input({ m15: { closeTime: iso(T - 1_800_000) } }));
    expect(d.output.active).toBe("DATA_UNAVAILABLE");
  });
  it("forming M5 bar never confirms", () => {
    const s: TrackerState = { active: "DATA_UNAVAILABLE", proposed: "TREND_UP", count: 2, lastM5Close: iso(T - 300_000), activeSince: null };
    const r = step(s, input({ m5: { closeTime: iso(T + 300_000) } }));
    expect(r.output.active).toBe("DATA_UNAVAILABLE");
    expect(r.state.proposed).toBeNull(); // data loss clears pending confirmations
    expect(r.state.lastM5Close).toBe(iso(T - 300_000));
  });
});

describe("permissions", () => {
  it("defaults: no trades in VOLATILE/DEAD/MIXED/DATA_UNAVAILABLE; exceptions disabled", () => {
    for (const r of ["VOLATILE", "DEAD", "MIXED", "DATA_UNAVAILABLE"] as const) expect(allowedStrategies(r, { openingRangeComplete: true })).toEqual([]);
    expect(allowedStrategies("RANGE", { openingRangeComplete: true })).toEqual([{ strategy: "sweep_reversal", direction: "both" }]);
    expect(allowedStrategies("TREND_UP", { openingRangeComplete: true, weakCountertrend: true })).toEqual([{ strategy: "pullback", direction: "long" }]);
  });
  it("ORB only after the range completes and only in a validated regime", () => {
    const cfg = { ...DEFAULT_REGIME_CONFIG, orbValidatedRegimes: ["TREND_DOWN" as const] };
    expect(allowedStrategies("TREND_DOWN", { openingRangeComplete: false }, cfg).some((p) => p.strategy === "orb")).toBe(false);
    expect(allowedStrategies("TREND_DOWN", { openingRangeComplete: true }, cfg)).toContainEqual({ strategy: "orb", direction: "short" });
  });
});
