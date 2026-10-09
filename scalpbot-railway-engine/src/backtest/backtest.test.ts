import { describe, it, expect } from "vitest";
import * as B from "./backtest.js";

const T0 = Date.parse("2026-01-05T08:00:00Z");
const bar = (i: number, o: number, h: number, l: number, c: number, spread = 0): B.Bar => ({ time: new Date(T0 + i * 300000).toISOString(), open: o, high: h, low: l, close: c, spread });
const spec: B.TradeSpec = { side: "BUY", decisionTime: new Date(T0).toISOString(), delaySec: 0, entryRef: 100, sl: 99, tp1: 101, tp2: 102, atr: 1 };
const cfg0 = { ...B.DEFAULT_SIM, slippageSpreadFrac: 0 };

describe("data quality & lookahead", () => {
  it("flags duplicates, invalid OHLC, misaligned and gaps", () => {
    const r = B.qualityCheck([bar(0, 1, 2, 0.5, 1.5), bar(0, 1, 2, 0.5, 1.5), bar(1, 1, 0.9, 0.5, 1), bar(3, 1, 2, 0.5, 1), { ...bar(4, 1, 2, 0.5, 1), time: "2026-01-05T08:21:13Z" }], 300);
    expect(r.exclusions.map((e) => e.reason).sort()).toEqual(["duplicate", "invalid_ohlc", "misaligned"]);
    expect(r.gaps[0]!.missing).toBe(2);
  });
  it("excludes forming bars at decision time", () => {
    const bars = [bar(0, 1, 1, 1, 1), bar(1, 1, 1, 1, 1)];
    expect(B.availableAt(bars, 300, new Date(T0 + 400000).toISOString()).length).toBe(1);
  });
});

describe("fill simulation", () => {
  it("enters after delay, not at a pre-decision price", () => {
    const r = B.simulateTrade({ ...spec, delaySec: 300 }, [bar(0, 100, 100, 100, 100), bar(1, 100.2, 102.5, 100.1, 102)], 300, cfg0);
    expect(r.status === "FILLED" && r.entryTime).toBe(bar(1, 0, 0, 0, 0).time);
  });
  it("same-bar SL+TP resolves SL first conservatively", () => {
    const r = B.simulateTrade(spec, [bar(0, 100, 101.5, 98.5, 100)], 300, cfg0);
    expect(r.status === "FILLED" && r.netR).toBeCloseTo(-1);
    expect(r.status === "FILLED" && r.ambiguousBars).toBe(1);
    const tp = B.simulateTrade(spec, [bar(0, 100, 101.5, 98.5, 100), bar(1, 100, 102.5, 100, 102)], 300, { ...cfg0, sameBarPolicy: "TP_FIRST" });
    expect(tp.status === "FILLED" && tp.netR).toBeGreaterThan(-1);
  });
  it("partial at TP1 then TP2 = 1.5R gross; spread reduces it", () => {
    const bars = [bar(0, 100, 101.2, 100.05, 101), bar(1, 101, 102.3, 100.9, 102.2)];
    const r = B.simulateTrade(spec, bars, 300, cfg0);
    expect(r.status === "FILLED" && r.netR).toBeCloseTo(1.5);
    const s = B.simulateTrade(spec, bars.map((b) => ({ ...b, spread: 0.1 })), 300, cfg0);
    expect(s.status === "FILLED" && s.netR).toBeLessThan(1.5);
  });
  it("break-even after TP1 is not zero once costs exist", () => {
    const bars = [bar(0, 100, 101.2, 100, 101), bar(1, 101, 101, 99.5, 99.6)];
    const r = B.simulateTrade(spec, bars, 300, { ...cfg0, commissionR: 0.02 });
    expect(r.status === "FILLED" && r.netR).toBeCloseTo(0.5 - 3 * 0.02);
  });
  it("SELL symmetry", () => {
    const r = B.simulateTrade({ ...spec, side: "SELL", sl: 101, tp1: 99, tp2: 98 }, [bar(0, 100, 99.95, 98.8, 99), bar(1, 99, 99.1, 97.7, 97.8)], 300, cfg0);
    expect(r.status === "FILLED" && r.netR).toBeCloseTo(1.5);
  });
});

describe("statistics", () => {
  it("Wilson CI and t-based mean CI", () => {
    const w = B.wilson(50, 100)!;
    expect(w.low).toBeCloseTo(0.4038, 3); expect(w.high).toBeCloseTo(0.5962, 3);
    const m = B.metrics([1, -1, 1, -1, 2]);
    expect(m.status === "OK" && m.meanR).toBeCloseTo(0.4);
    expect(m.status === "OK" && m.profitFactor).toBe(2);
    expect(m.status === "OK" && m.maxDrawdownR).toBe(1);
    expect(B.metrics([]).status).toBe("INSUFFICIENT_DATA");
  });
  it("bootstrap is reproducible with a seed", () => {
    const rs = Array.from({ length: 50 }, (_, i) => (i % 3 === 0 ? -1 : 0.8));
    const a = B.blockBootstrap(rs, { resamples: 500, seed: 7 }), b = B.blockBootstrap(rs, { resamples: 500, seed: 7 });
    expect(a).toEqual(b);
  });
  it("cusum alerts on deterioration; chronological split keeps order", () => {
    expect(B.cusum(Array(10).fill(-1)).alertAt).toBe(3);
    const s = B.chronologicalSplit(Array.from({ length: 10 }, (_, i) => bar(i, 1, 1, 1, 1)));
    expect(s.boundaries.train.count).toBe(7);
    expect(Date.parse(s.train[6]!.time)).toBeLessThan(Date.parse(s.test[0]!.time));
  });
  it("eligibility fails closed and rejects synthetic data", () => {
    expect(B.eligibility([1, 2], true).status).toBe("INSUFFICIENT_DATA");
    const good = Array.from({ length: 120 }, (_, i) => (i % 2 ? 1.2 : -0.6));
    expect(B.eligibility(good, true).status).toBe("PASSED_SCREENING");
    expect(B.eligibility(good, null).status).toBe("FAILED");
    const rep = B.buildReport({ dataset: { source: "x", retrievedAt: "t", pair: "EURUSD", timeframe: "M5", timezone: "UTC", synthetic: true }, codeVersion: "a", configVersion: "b", assumptions: [], generatedAt: "t", oosR: good, stable: true, ambiguousShare: 0 });
    expect(rep.eligibility.status).toBe("INSUFFICIENT_DATA");
    expect(B.harveyThreshold(1)).toBe(1);
  });
});
