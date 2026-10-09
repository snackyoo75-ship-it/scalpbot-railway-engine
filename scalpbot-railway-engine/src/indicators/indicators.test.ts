import { describe, expect, it } from "vitest";
import {
  adx, atr, bollinger, candleGeometry, donchian, ema, normalizedSlope, percentileRank, realizedVol,
  rollingPercentile, rsi, spreadStats, trueRange, volRatio, zScore, type Candle,
} from "./core.js";
import { computeSnapshot, prepareSeries } from "./snapshot.js";

const T0 = Date.parse("2026-01-05T00:00:00Z");
function mk(ohlc: [number, number, number, number][], stepMin = 5, start = T0): Candle[] {
  return ohlc.map(([o, h, l, c], i) => ({ time: new Date(start + i * stepMin * 60_000).toISOString(), open: o, high: h, low: l, close: c, complete: true }));
}
function lcg(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
function randomWalk(n: number, seed = 7, stepMin = 5): Candle[] {
  const r = lcg(seed);
  let p = 2000;
  const rows: [number, number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o + (r() - 0.5) * 4;
    rows.push([o, Math.max(o, c) + r() * 2, Math.min(o, c) - r() * 2, c]);
    p = c;
  }
  return mk(rows, stepMin);
}

describe("EMA", () => {
  it("seeds with SMA and applies recurrence (hand calc)", () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e.slice(0, 2)).toEqual([null, null]);
    expect(e[2]!).toBe(2);
    expect(e[3]!).toBeCloseTo(0.5 * 4 + 0.5 * 2, 12); // 3
    expect(e[4]!).toBeCloseTo(0.5 * 5 + 0.5 * 3, 12); // 4
  });
  it("insufficient history is null, never 0", () => {
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });
});

describe("TR / ATR", () => {
  it("first TR is null (no fabricated previous close)", () => {
    const c = mk([[10, 12, 9, 11], [11, 15, 10, 14]]);
    expect(trueRange(c)).toEqual([null, 5]);
  });
  it("uses gap vs previous close", () => {
    const c = mk([[10, 11, 9, 10], [13, 14, 13, 13.5]]);
    expect(trueRange(c)[1]).toBe(4); // |14 - 10|
  });
  it("seeds ATR with mean of first 14 TR, then Wilder", () => {
    const rows: [number, number, number, number][] = [[10, 11, 9, 10]];
    for (let i = 1; i <= 15; i++) rows.push([10, 10 + i / 2, 10 - i / 2, 10]); // TR_i = i
    const a = atr(mk(rows));
    expect(a[13]).toBeNull();
    expect(a[14]!).toBeCloseTo(7.5, 12); // mean(1..14)
    expect(a[15]!).toBeCloseTo((13 * 7.5 + 15) / 14, 12);
  });
});

describe("RSI", () => {
  const up = Array.from({ length: 16 }, (_, i) => 100 + i);
  it("all gains → 100, all losses → 0, flat → 50", () => {
    expect(rsi(up)[14]).toBe(100);
    expect(rsi([...up].reverse())[14]).toBe(0);
    expect(rsi(new Array(16).fill(5))[14]).toBe(50);
  });
  it("insufficient data → null", () => {
    expect(rsi(up.slice(0, 14))[13]).toBeNull();
  });
  it("seed and recurrence (hand calc)", () => {
    // changes: +1 x7, -1 x7 → avgGain=avgLoss=0.5 → RSI 50; next +2
    const closes = [10];
    for (let i = 0; i < 7; i++) closes.push(closes[closes.length - 1]! + 1);
    for (let i = 0; i < 7; i++) closes.push(closes[closes.length - 1]! - 1);
    closes.push(closes[closes.length - 1]! + 2);
    const r = rsi(closes);
    expect(r[14]!).toBeCloseTo(50, 12);
    const g = (13 * 0.5 + 2) / 14, l = (13 * 0.5) / 14;
    expect(r[15]!).toBeCloseTo(100 - 100 / (1 + g / l), 12);
  });
});

describe("normalized slope", () => {
  it("divides by ATR and needs t-5", () => {
    const e = [null, 1, 2, 3, 4, 5, 6, 7];
    const a = [null, null, null, null, null, null, 2, 0];
    const s = normalizedSlope(e, a, 5);
    expect(s[5]).toBeNull();
    expect(s[6]).toBeCloseTo((6 - 1) / 2, 12);
    expect(s[7]!).toBeNull(); // ATR 0
  });
});

describe("ADX", () => {
  it("first DI at index 14, first ADX at index 27, hand-checked seed", () => {
    // strictly rising bars: +DM=1, -DM=0, TR=2 every bar → +DI=50, -DI=0, DX=100
    const rows: [number, number, number, number][] = [];
    for (let i = 0; i < 30; i++) rows.push([10 + i, 11 + i, 9 + i, 10 + i]);
    const d = adx(mk(rows));
    expect(d.plusDI[13]).toBeNull();
    expect(d.plusDI[14]!).toBeCloseTo(50, 9);
    expect(d.minusDI[14]!).toBeCloseTo(0, 12);
    expect(d.dx[14]!).toBeCloseTo(100, 9);
    expect(d.adx[26]).toBeNull();
    expect(d.adx[27]!).toBeCloseTo(100, 9);
  });
  it("zero TR → unavailable, not NaN", () => {
    const rows: [number, number, number, number][] = Array.from({ length: 30 }, () => [5, 5, 5, 5]);
    const d = adx(mk(rows));
    expect(d.adx.every((v) => v === null)).toBe(true);
  });
});

describe("Bollinger / z-score", () => {
  it("uses population SD", () => {
    const closes = [2, 4, 4, 4, 5, 5, 7, 9]; // pop SD = 2, mean 5
    const b = bollinger(closes, 8, 2);
    expect(b.mid[7]!).toBe(5);
    expect(b.upper[7]!).toBeCloseTo(9, 12);
    expect(b.lower[7]!).toBeCloseTo(1, 12);
    expect(b.width[7]!).toBeCloseTo(8 / 5, 12);
    expect(zScore(closes, 8)[7]).toBeCloseTo((9 - 5) / 2, 12);
  });
  it("z-score with zero SD → null (also absorbs float noise)", () => {
    expect(zScore(new Array(20).fill(0.1), 20)[19]).toBeNull();
  });
});

describe("Donchian", () => {
  it("excludes the current candle, so a breakout cannot move its own boundary", () => {
    const rows: [number, number, number, number][] = Array.from({ length: 20 }, () => [10, 11, 9, 10]);
    rows.push([10, 50, 1, 49]);
    const d = donchian(mk(rows), 20);
    expect(d.upper[19]!).toBeNull();
    expect(d.upper[20]!).toBe(11);
    expect(d.lower[20]!).toBe(9);
  });
});

describe("percentile rank (mid-rank ties)", () => {
  it("handles ties", () => {
    expect(percentileRank([1, 2, 2, 3], 2)).toBe(50);
    expect(percentileRank([5, 5, 5], 5)).toBe(50);
    expect(percentileRank([1, 2, 3, 4], 4)).toBe(87.5);
  });
  it("rolling requires full valid lookback", () => {
    const s = rollingPercentile([null, 1, 2, 3], 3);
    expect(s).toEqual([null, null, null, (100 * (2 + 0.5)) / 3]);
  });
});

describe("realized vol", () => {
  it("needs 31 closes and uses sample SD", () => {
    const closes = Array.from({ length: 31 }, (_, i) => 100 * Math.exp(i % 2 ? 0.01 : 0));
    const s = realizedVol(closes, 30);
    expect(s[29]!).toBeNull();
    // returns alternate +0.01/-0.01 (15 each), mean 0 → sample SD = sqrt(30*1e-4/29)
    expect(s[30]!).toBeCloseTo(Math.sqrt((30 * 1e-4) / 29), 12);
  });
  it("volRatio null when median is zero", () => {
    expect(volRatio([0, 0, 0], 3)[2]).toBeNull();
  });
});

describe("candle geometry", () => {
  it("computes parts and aligned close position", () => {
    const g = candleGeometry(mk([[10, 14, 8, 13]])[0]!)!;
    expect(g).toMatchObject({ range: 6, body: 3, upperWick: 1, lowerWick: 2 });
    expect(g.closePos).toBeCloseTo(5 / 6, 12);
    expect(g.bearAlignedClosePos).toBeCloseTo(1 / 6, 12);
  });
  it("zero range → unavailable", () => {
    expect(candleGeometry(mk([[1, 1, 1, 1]])[0]!)).toBeNull();
  });
});

describe("spread stats", () => {
  const asOf = "2026-01-21T10:30:00Z";
  const obs = Array.from({ length: 40 }, (_, d) => ({ time: new Date(Date.parse("2026-01-20T10:15:00Z") - (d % 19) * 86_400_000 - d * 1000).toISOString(), spread: 1 + (d % 3) }));
  it("insufficient history → no z", () => {
    const r = spreadStats(obs.slice(0, 5), asOf, 2);
    expect(r.ok).toBe(false);
  });
  it("median/MAD by UTC hour; excludes stale, future and other hours", () => {
    const extra = [
      { time: "2025-12-01T10:00:00Z", spread: 999 }, // stale
      { time: "2026-01-21T10:45:00Z", spread: 999 }, // future
      { time: "2026-01-20T11:00:00Z", spread: 999 }, // other hour
    ];
    const r = spreadStats([...obs, ...extra], asOf, 4);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.samples).toBe(40);
      expect(r.median).toBe(2);
      expect(r.mad).toBe(1);
      expect(r.z).toBeCloseTo(2 / 1.4826, 9);
    }
  });
  it("zero MAD → z unavailable", () => {
    const flat = obs.map((o) => ({ ...o, spread: 1 }));
    const r = spreadStats(flat, asOf, 3);
    expect(r.ok && r.z).toBe(null);
  });
});

describe("snapshot / timestamp alignment", () => {
  it("drops forming candles and candles closing after asOf", () => {
    const c = randomWalk(5);
    c[4]!.complete = false;
    const asOf = new Date(Date.parse(c[3]!.time) + 300_000).toISOString();
    expect(prepareSeries(c, "M5", asOf).candles.map((k) => k.time)).toEqual(c.slice(0, 4).map((k) => k.time));
    expect(prepareSeries(c.slice(0, 4), "M5", new Date(Date.parse(asOf) - 1).toISOString()).candles).toHaveLength(3);
  });
  it("missing intra-session candles → unavailable with reason", () => {
    const c = randomWalk(60);
    c.splice(30, 1);
    const asOf = new Date(Date.parse(c[c.length - 1]!.time) + 300_000).toISOString();
    const s = computeSnapshot({ asOf, m1: [], m5: c, m15: [], spreads: [], currentSpread: null });
    expect(s.M5.ema20!.status).toBe("unavailable");
    expect((s.M5.ema20 as { reason?: string }).reason).toMatch(/missing/);
  });
  it("source timestamps point at the last completed candle", () => {
    const c5 = randomWalk(300);
    const asOf = new Date(Date.parse(c5[299]!.time) + 300_000).toISOString();
    const s = computeSnapshot({ asOf, m1: [], m5: c5, m15: [], spreads: [], currentSpread: null });
    expect(s.M5.ema50!).toMatchObject({ status: "ok", sourceTime: c5[299]!.time });
    expect(s.M5.atrPercentile200!.status).toBe("ok");
    expect(s.M15.ema200!.status).toBe("unavailable");
    expect(s.M1.sigmaM1!.status).toBe("unavailable");
  });
});

/** Independent naive reference implementations (written differently on purpose). */
describe("cross-check against independent reference", () => {
  const c = randomWalk(400, 42);
  const closes = c.map((k) => k.close);
  it("EMA50", () => {
    const n = 50, a = 2 / 51;
    let ref = closes.slice(0, n).reduce((x, y) => x + y) / n;
    for (let i = n; i < closes.length; i++) ref = closes[i]! * a + ref * (1 - a);
    expect(ema(closes, 50)[399]).toBeCloseTo(ref, 9);
  });
  it("ATR14 & RSI14", () => {
    const trs = c.slice(1).map((k, i) => Math.max(k.high - k.low, Math.abs(k.high - c[i]!.close), Math.abs(k.low - c[i]!.close)));
    let ra = trs.slice(0, 14).reduce((x, y) => x + y) / 14;
    for (const t of trs.slice(14)) ra = (ra * 13 + t) / 14;
    expect(atr(c)[399]).toBeCloseTo(ra, 9);
    const chg = closes.slice(1).map((v, i) => v - closes[i]!);
    let g = chg.slice(0, 14).filter((x) => x > 0).reduce((x, y) => x + y, 0) / 14;
    let l = -chg.slice(0, 14).filter((x) => x < 0).reduce((x, y) => x + y, 0) / 14;
    for (const d of chg.slice(14)) { g = (g * 13 + (d > 0 ? d : 0)) / 14; l = (l * 13 + (d < 0 ? -d : 0)) / 14; }
    expect(rsi(closes)[399]).toBeCloseTo(100 - 100 / (1 + g / l), 9);
  });
  it("ADX14", () => {
    let sTr = 0, sP = 0, sM = 0;
    const dxs: number[] = [];
    for (let i = 1; i < c.length; i++) {
      const tr = Math.max(c[i]!.high - c[i]!.low, Math.abs(c[i]!.high - c[i - 1]!.close), Math.abs(c[i]!.low - c[i - 1]!.close));
      const up = c[i]!.high - c[i - 1]!.high, dn = c[i - 1]!.low - c[i]!.low;
      const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
      if (i <= 14) { sTr += tr; sP += p; sM += m; } else { sTr += tr - sTr / 14; sP += p - sP / 14; sM += m - sM / 14; }
      if (i >= 14) { const pdi = (100 * sP) / sTr, mdi = (100 * sM) / sTr; dxs.push((100 * Math.abs(pdi - mdi)) / (pdi + mdi)); }
    }
    let ref = dxs.slice(0, 14).reduce((x, y) => x + y) / 14;
    for (const d of dxs.slice(14)) ref = (ref * 13 + d) / 14;
    expect(adx(c).adx[399]!).toBeCloseTo(ref, 9);
  });
});
