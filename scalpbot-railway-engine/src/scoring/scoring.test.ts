import { describe, expect, it } from "vitest";
import type { StrategyResult } from "../strategies/strategies.js";
import {
  binaryEvDiagnostic, decide, DEFAULT_SCORE_CONFIG, displayableProbability, estimateCost, evNet, inPrimeIstWindow, publicationGate, score,
  type CostInput, type GateInput, type ScoreInput,
} from "./scoring.js";

const PRIME = "2026-01-06T14:00:00Z"; // 19:30 IST
const OFF = "2026-01-06T10:00:00Z"; // 15:30 IST

const base: ScoreInput = {
  side: "BUY", m15Bias: "bull", patterns: [{ id: "engulfing", barTime: "t", q: 1 }], clearPathR: Infinity, rsi14: 70, slope50: 1,
  atrPercentile: 50, asOf: PRIME, usdProxyAlignment: null, costR: 0.05, countertrendValidated: false, newsPenaltyWindow: false, newsHardBlock: false,
};

describe("score arithmetic", () => {
  it("perfect without USD proxy → 95/95 = 100", () => {
    const s = score(base);
    expect(s.rawTotal).toBe(95);
    expect(s.availableMax).toBe(95);
    expect(s.score).toBe(100);
    expect(s.components.usdProxy).toBeUndefined();
  });
  it("with a configured USD proxy source the max is 100", () => {
    const s = score({ ...base, usdProxyAlignment: 0.5 }, { ...DEFAULT_SCORE_CONFIG, usdProxySource: "DXY feed" });
    expect(s.availableMax).toBe(100);
    expect(s.rawTotal).toBe(97.5);
  });
  it("neutral bias 10, breakout pattern 10·Q, path 1.5–2R = 8, off-window timing 5", () => {
    const s = score({ ...base, m15Bias: null, patterns: [{ id: "breakout_retest", barTime: "t", q: 0.5 }], clearPathR: 1.5, asOf: OFF });
    expect(s.components.bias!.points).toBe(10);
    expect(s.components.pattern!.points).toBe(5);
    expect(s.components.path!.points).toBe(8);
    expect(s.components.timing!.points).toBe(5);
    expect(s.rawTotal).toBe(10 + 5 + 8 + 10 + 10 + 5 + 5);
  });
  it("momentum mapping with bounds and missing halves", () => {
    expect(score({ ...base, rsi14: 60, slope50: 0.5 }).components.momentum!.points).toBeCloseTo(2.5 + 2.5, 12);
    expect(score({ ...base, rsi14: 40, slope50: -1 }).components.momentum!.points).toBe(0);
    expect(score({ ...base, side: "SELL", m15Bias: "bear", rsi14: 30, slope50: -2 }).components.momentum!.points).toBe(10);
    expect(score({ ...base, rsi14: null, slope50: 1 }).components.momentum!.points).toBe(5);
  });
  it("ATR percentile 30–80 inclusive; unavailable → 0", () => {
    expect(score({ ...base, atrPercentile: 30 }).components.atr!.points).toBe(10);
    expect(score({ ...base, atrPercentile: 80 }).components.atr!.points).toBe(10);
    expect(score({ ...base, atrPercentile: 80.1 }).components.atr!.points).toBe(0);
    expect(score({ ...base, atrPercentile: null }).components.atr!.points).toBe(0);
  });
  it("cost efficiency boundary and incomplete cost", () => {
    expect(score({ ...base, costR: 0.1 }).components.cost!.points).toBe(5);
    expect(score({ ...base, costR: 0.1001 }).components.cost!.points).toBe(0);
    expect(score({ ...base, costR: null }).components.cost!.points).toBe(0);
  });
  it("duplicate representations of one event count once", () => {
    const s = score({ ...base, patterns: [{ id: "engulfing", barTime: "t", q: 0.5 }, { id: "pin_bar", barTime: "t", q: 0.5 }, { id: "displacement", barTime: "t", q: 1 }] });
    expect(s.components.pattern!.points).toBe(10); // best single: 20·0.5 vs 10·1 → 10, not summed
  });
  it("penalties and clamping to [0,100]", () => {
    const s = score({ ...base, countertrendValidated: true, newsPenaltyWindow: true });
    expect(s.penalties).toEqual({ countertrend: 15, news: 20 });
    expect(s.score).toBeCloseTo((100 * (95 - 35)) / 95, 9);
    const low = score({ ...base, m15Bias: null, patterns: [], clearPathR: 1.5, rsi14: null, slope50: null, atrPercentile: null, costR: null, asOf: OFF, countertrendValidated: true, newsPenaltyWindow: true });
    expect(low.score).toBe(0);
  });
  it("news hard blackout replaces penalty with hard reject", () => {
    const s = score({ ...base, newsPenaltyWindow: true, newsHardBlock: true });
    expect(s.penalties.news).toBeUndefined();
    expect(s.hardRejects).toContain("news hard blackout");
    expect(s.passes).toBe(false);
  });
  it("bias conflict and blocked path are hard rejects", () => {
    expect(score({ ...base, m15Bias: "bear" }).hardRejects).toContain("M15 bias conflicts with direction");
    expect(score({ ...base, clearPathR: 1.49 }).hardRejects).toContain("path to target blocked before 1.5R");
  });
  it("threshold 65 inclusive", () => {
    const s = score(base, { ...DEFAULT_SCORE_CONFIG, threshold: 100 });
    expect(s.passes).toBe(true);
  });
  it("IST window [19:00, 21:30)", () => {
    expect(inPrimeIstWindow("2026-01-06T13:30:00Z")).toBe(true);
    expect(inPrimeIstWindow("2026-01-06T13:29:59Z")).toBe(false);
    expect(inPrimeIstWindow("2026-01-06T16:00:00Z")).toBe(false);
    expect(inPrimeIstWindow("2026-07-06T15:59:00Z")).toBe(true); // no DST in IST
  });
});

const cost: CostInput = { bid: 2000.0, ask: 2000.4, entryPriceSide: "mid", expectedExitSpread: 0.4, slippagePerSide: 0.05, commissionPerSide: 3, units: 10, accountToQuote: 1, otherVerified: 0 };
describe("cost model", () => {
  it("mid entry: half+half spread, 2× slippage, commission in price units", () => {
    const c = estimateCost(cost, 5);
    expect(c.status).toBe("complete");
    if (c.status !== "complete") return;
    expect(c.parts.spread).toBeCloseTo(0.4, 9);
    expect(c.parts.slippage).toBeCloseTo(0.1, 12);
    expect(c.parts.commission).toBeCloseTo(0.6, 12);
    expect(c.costR).toBeCloseTo(1.1 / 5, 9);
  });
  it("executable entry does not double-count the entry half spread", () => {
    const c = estimateCost({ ...cost, entryPriceSide: "executable" }, 5);
    expect(c.status === "complete" && c.parts.spread).toBeCloseTo(0.2, 9);
  });
  it("unknown commission/size/conversion/slippage → incomplete", () => {
    const c = estimateCost({ ...cost, commissionPerSide: null, accountToQuote: null }, 5);
    expect(c.status).toBe("incomplete");
    if (c.status === "incomplete") expect(c.missing).toEqual(["commission", "account currency conversion"]);
  });
});

describe("expected value", () => {
  const key = { strategy: "trend_pullback", pair: "XAUUSD", regime: "TREND_UP", executionPolicy: "tp1-partial-be" };
  const complete = estimateCost(cost, 5);
  const outcomes = (xs: number[], oos = true) => ({ key, outOfSample: oos, netR: xs });
  const hundred = Array.from({ length: 100 }, (_, i) => (i % 2 ? 1.2 : -0.9)); // mean 0.15
  it("supported mean of net R with threshold 0.10", () => {
    const r = evNet(outcomes(hundred), key, complete);
    expect(r.status).toBe("supported");
    if (r.status === "supported") {
      expect(r.mean).toBeCloseTo(0.15, 12);
      expect(r.passes).toBe(true);
    }
  });
  it("unavailable when cost incomplete, too few samples, in-sample, or mismatched key", () => {
    expect(evNet(outcomes(hundred), key, estimateCost({ ...cost, slippagePerSide: null }, 5)).status).toBe("unavailable");
    expect(evNet(outcomes(hundred.slice(0, 99)), key, complete).status).toBe("unavailable");
    expect(evNet(outcomes(hundred, false), key, complete).status).toBe("unavailable");
    expect(evNet(outcomes(hundred), { ...key, regime: "RANGE" }, complete).status).toBe("unavailable");
    expect(evNet(null, key, complete).status).toBe("unavailable");
  });
  it("binary diagnostic only for binary exit classes", () => {
    expect(binaryEvDiagnostic(0.45, 2, 1, 0.1, "binary")).toBeCloseTo(0.45 * 2 - 0.55 - 0.1, 12);
    expect(binaryEvDiagnostic(0.45, 2, 1, 0.1, "multiple")).toBeNull();
  });
  it("probability hidden until validated calibration beats baseline", () => {
    expect(displayableProbability({ status: "not_validated" }, 0.6)).toBeNull();
    const v = { status: "validated" as const, modelVersion: "lr-1", features: ["a"], trainPeriod: "2025", testBrier: 0.2, baselineBrier: 0.25 };
    expect(displayableProbability(v, 0.6)).toBe(0.6);
    expect(displayableProbability({ ...v, testBrier: 0.26 }, 0.6)).toBeNull();
  });
});

describe("publication gate", () => {
  const cand = {
    status: "candidate", strategy: "trend_pullback", rules: [{ rule: "regime permits strategy/direction", pass: true, detail: "" }],
  } as unknown as StrategyResult;
  const complete = estimateCost(cost, 20);
  const ev = { status: "supported" as const, mean: 0.2, stderr: 0.05, n: 150, passes: true };
  const good: GateInput = { candidate: cand, score: score(base), cost: complete, maxCostR: 0.25, spreadOk: true, ev, timingOk: true, invalidationOk: true, globalRiskOk: true, dataQualityOk: true };
  it("publishes when every gate passes", () => {
    expect(publicationGate(good).publish).toBe(true);
  });
  it.each([
    ["spread gate failed", { spreadOk: false }],
    ["cost estimation incomplete", { cost: null }],
    ["EV unavailable: no data", { ev: { status: "unavailable" as const, reason: "no data" } }],
    ["EV 0.050R below threshold", { ev: { ...ev, mean: 0.05, passes: false } }],
    ["entry timing check failed", { timingOk: false }],
    ["invalidation check failed", { invalidationOk: false }],
    ["global risk check failed", { globalRiskOk: false }],
    ["data-quality check failed", { dataQualityOk: false }],
  ])("blocks: %s", (reason, over) => {
    const r = publicationGate({ ...good, ...over });
    expect(r.publish).toBe(false);
    if (!r.publish) expect(r.reasons).toContain(reason);
  });
  it("blocks low score and cost_R over limit", () => {
    const r = publicationGate({ ...good, score: score({ ...base, m15Bias: null, asOf: OFF, rsi14: 50, slope50: 0, atrPercentile: null }), maxCostR: 0.01 });
    expect(r.publish).toBe(false);
    if (!r.publish) {
      expect(r.reasons.some((x) => x.startsWith("score "))).toBe(true);
      expect(r.reasons.some((x) => x.startsWith("cost_R"))).toBe(true);
    }
  });
  it("decide returns NO_VALID_SETUP with per-strategy reasons", () => {
    const rejected = { status: "rejected", strategy: "orb_retest", reason: "opening range fully formed", rules: [] } as unknown as StrategyResult;
    const d = decide([{ ...good, ev: null }, { ...good, candidate: rejected }]);
    expect(d.result).toBe("NO_VALID_SETUP");
    if (d.result === "NO_VALID_SETUP") {
      expect(d.reasons[0]!.reasons).toContain("EV unavailable");
      expect(d.reasons[1]!.reasons).toContain("strategy rejected: opening range fully formed");
    }
    expect(decide([good]).result).toBe("PUBLISH");
  });
});
