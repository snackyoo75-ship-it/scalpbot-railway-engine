import { describe, expect, it } from "vitest";
import type { Candle, Series } from "../indicators/core.js";
import { classifyStructure, confirmedSwings, structureEventAt } from "./swings.js";
import { fibLevel, pivots, previousDay, roundLevels, INSTRUMENTS, asianRange, londonRange, equalLevels, retracementContext, type Level } from "./levels.js";
import { clusterLevels } from "./cluster.js";
import { forexDay, zonedToUtc } from "./time.js";
import { breakoutRetest, compressionBreakout, displacement, engulfing, fakeout, insideBarBreakout, liquiditySweep, pinBar, quality } from "./patterns.js";

const T0 = Date.parse("2026-01-06T00:00:00Z");
type Row = [number, number, number, number];
const mk = (rows: Row[], start = T0): Candle[] =>
  rows.map(([o, h, l, c], i) => ({ time: new Date(start + i * 300_000).toISOString(), open: o, high: h, low: l, close: c, complete: true }));
const bar = (mid: number): Row => [mid, mid + 1, mid - 1, mid];
const atrs = (n: number, v = 10): Series => new Array(n).fill(v);

describe("swings", () => {
  const c = mk([bar(10), bar(11), bar(15), bar(12), bar(11), bar(9)]);
  it("high at t needs strict > on both sides and is confirmed only after t+2 closes", () => {
    expect(confirmedSwings(c, 3)).toHaveLength(0); // t+2 not closed yet
    const s = confirmedSwings(c, 4);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: "high", index: 2, price: 16, confirmIndex: 4, availableAt: new Date(T0 + 5 * 300_000).toISOString() });
  });
  it("equal neighbouring high is not a swing (strict)", () => {
    const e = mk([bar(10), bar(11), bar(15), bar(15), bar(11), bar(9)]);
    expect(confirmedSwings(e, 5).filter((s) => s.kind === "high")).toHaveLength(0);
  });
  it("classifies HH+HL as bullish and emits BOS on first close above last swing high", () => {
    const rows: Row[] = [10, 8, 6, 9, 14, 18, 13, 11, 15, 22, 17, 15, 18, 20].map(bar);
    const c2 = mk(rows);
    const st = classifyStructure(confirmedSwings(c2, 13));
    expect(st.trend).toBe("bullish");
    const k: Row = [20, 26, 19, 25]; // close 25 > swing high 23
    const c3 = mk([...rows, k]);
    const ev = structureEventAt(c3, 14);
    expect(ev).toMatchObject({ type: "BOS", direction: "bull" });
    expect(structureEventAt(mk([...rows, k, k]), 15)).toBeNull(); // already beyond
  });
  it("mixed when fewer than two highs/lows", () => {
    expect(classifyStructure([]).trend).toBe("mixed");
  });
});

describe("time / sessions", () => {
  it("forex day rolls at 17:00 New York incl. DST", () => {
    expect(forexDay(Date.parse("2026-01-06T21:59:00Z"))).toBe("2026-01-06"); // 16:59 EST
    expect(forexDay(Date.parse("2026-01-06T22:00:00Z"))).toBe("2026-01-07"); // 17:00 EST
    expect(forexDay(Date.parse("2026-07-06T20:59:00Z"))).toBe("2026-07-06"); // 16:59 EDT
    expect(forexDay(Date.parse("2026-07-06T21:00:00Z"))).toBe("2026-07-07"); // 17:00 EDT
  });
  it("London 08:00 is 07:00 UTC in summer, 08:00 UTC in winter", () => {
    expect(new Date(zonedToUtc(2026, 7, 6, 8, 0, "Europe/London")).toISOString()).toBe("2026-07-06T07:00:00.000Z");
    expect(new Date(zonedToUtc(2026, 1, 6, 8, 0, "Europe/London")).toISOString()).toBe("2026-01-06T08:00:00.000Z");
  });
  const day = mk(Array.from({ length: 288 }, (_, i) => bar(100 + (i % 50))));
  it("Asian range only after 07:00 UTC with all 84 bars", () => {
    expect(asianRange(day, 82)).toBeNull(); // 06:50 bar, session not over
    const r = asianRange(day, 83)!;
    expect(r.availableAt).toBe("2026-01-06T07:00:00.000Z");
    expect(r.high).toBe(150);
    const gap = [...day.slice(0, 40), ...day.slice(41)];
    expect(asianRange(gap, 82)).toBeNull(); // a missing bar → unavailable
  });
  it("London range available at 13:00 London", () => {
    expect(londonRange(day, 154)).toBeNull();
    expect(londonRange(day, 155)!.availableAt).toBe("2026-01-06T13:00:00.000Z");
  });
  it("previous day HLC uses the 17:00 NY boundary", () => {
    const start = Date.parse("2026-01-06T21:00:00Z"); // 16:00 NY
    const rows: Row[] = Array.from({ length: 24 }, (_, i) => (i < 12 ? [1, 5 + i, 0.5, 2 + i] : bar(50)));
    const c = mk(rows, start);
    const pd = previousDay(c, 23)!;
    expect(pd.key).toBe("2026-01-06");
    expect(pd).toMatchObject({ high: 16, low: 0.5, close: 13 });
  });
});

describe("levels", () => {
  it("pivots", () => {
    const p = pivots(110, 90, 100);
    expect(p).toEqual({ P: 100, R1: 110, S1: 90, R2: 120, S2: 80 });
  });
  it("round numbers without float drift", () => {
    expect(roundLevels(2013.37, INSTRUMENTS.XAUUSD)).toEqual([2010, 2020]);
    expect(roundLevels(1.08731, INSTRUMENTS.EURUSD)).toEqual([1.085, 1.09]);
    expect(roundLevels(1.085, INSTRUMENTS.EURUSD)).toEqual([1.085, 1.09]);
  });
  it("fib up and down", () => {
    const s = (k: "high" | "low", p: number, i: number) => ({ kind: k, price: p, index: i, time: "", availableAt: "", confirmIndex: i + 2 });
    expect(fibLevel({ direction: "up", from: s("low", 100, 0), to: s("high", 200, 5) }, 0.382)).toBeCloseTo(161.8, 9);
    expect(fibLevel({ direction: "down", from: s("high", 200, 0), to: s("low", 100, 5) }, 0.618)).toBeCloseTo(161.8, 9);
  });
  it("healthy retracement: zone reached, no close beyond 0.786", () => {
    const s = (k: "high" | "low", p: number, i: number) => ({ kind: k, price: p, index: i, time: "", availableAt: "", confirmIndex: i });
    const sw = { direction: "up" as const, from: s("low", 100, 0), to: s("high", 200, 1) };
    const c = mk([bar(100), bar(200), [170, 171, 150, 160], [160, 161, 115, 125]]);
    expect(retracementContext(c, sw, 2).healthy).toBe(true);
    expect(retracementContext(c, sw, 3)).toMatchObject({ closedBeyond786: false });
    const c2 = mk([bar(100), bar(200), [170, 171, 115, 120]]);
    expect(retracementContext(c2, sw, 2).closedBeyond786).toBe(true);
  });
  it("equal highs within 0.1*ATR (boundary inclusive)", () => {
    const rows: Row[] = [bar(10), bar(11), [15, 16, 14, 15], bar(12), bar(11), bar(12), [15, 17, 14, 15], bar(12), bar(11)];
    expect(equalLevels(mk(rows), 8, 10)).toHaveLength(1); // |16-17| = 1 = 0.1*10
    expect(equalLevels(mk(rows), 8, 9.99)).toHaveLength(0);
  });
});

describe("clustering", () => {
  const L = (price: number, idx: number, id: string, kind: Level["kind"] = "round"): Level => ({ kind, price, availableAt: `t${idx}`, availableIndex: idx, sourceId: id });
  it("joins within 0.15*ATR (inclusive), counts each underlying source once", () => {
    const cs = clusterLevels([L(100, 0, "a"), L(101.5, 0, "b"), L(101.5, 0, "b"), L(103.1, 0, "c")], 10, 0);
    expect(cs).toHaveLength(2);
    expect(cs[0]!.strength).toBeCloseTo(2, 12); // duplicate "b" not double-counted
    expect(cs[0]!.isKey).toBe(true);
    expect(cs[1]!.isKey).toBe(false);
  });
  it("age decay and lookahead exclusion", () => {
    const cs = clusterLevels([L(100, 0, "a"), L(100.5, 100, "b"), L(100.2, 150, "future")], 10, 100);
    expect(cs[0]!.constituents).toHaveLength(2);
    expect(cs[0]!.strength).toBeCloseTo(Math.exp(-1) + 1, 12);
    expect(cs[0]!.isKey).toBe(false); // 1.37 < 1.5 threshold
  });
});

describe("patterns", () => {
  const ctx = (rows: Row[], a = 10) => ({ c: mk(rows), atr: atrs(rows.length, a) });
  it("bullish engulfing boundary equality is accepted", () => {
    // prev body 5 (105→100); current open = prev close, close = prev open+0.5, body 5.5 = 1.1*5
    const x = ctx([[105, 106, 99, 100], [100, 106, 99, 105.5]]);
    expect(engulfing(x, 1)?.direction).toBe("bull");
    const y = ctx([[105, 106, 99, 100], [100, 106, 99, 105.4]]);
    expect(engulfing(y, 1)).toBeNull();
  });
  it("engulfing needs body >= 0.4 ATR", () => {
    expect(engulfing(ctx([[105, 106, 99, 100], [100, 106, 99, 105.5]], 14), 1)).toBeNull();
  });
  it("pin bar bull and bear", () => {
    expect(pinBar(ctx([[108, 110, 100, 109]]), 0)?.direction).toBe("bull");
    expect(pinBar(ctx([[102, 110, 100, 101]]), 0)?.direction).toBe("bear");
    expect(pinBar(ctx([[108, 110, 100, 109]], 21), 0)).toBeNull(); // range < 0.5 ATR
  });
  it("displacement boundaries", () => {
    expect(displacement(ctx([[100, 110, 100, 108]]), 0)?.direction).toBe("bull"); // body 8 = 0.8*ATR
    expect(displacement(ctx([[100, 110, 100, 107.9]]), 0)).toBeNull(); // body 7.9 < 0.8*ATR
  });
  it("displacement range cap", () => {
    expect(displacement(ctx([[100, 131, 100, 130]]), 0)).toBeNull(); // range 31 > 3*10
  });
  it("inside bar breakout needs close beyond mother (strict)", () => {
    const base: Row[] = [[100, 110, 90, 105], [104, 108, 95, 100]];
    expect(insideBarBreakout(ctx([...base, [104, 112, 103, 111]]), 2)?.direction).toBe("bull");
    expect(insideBarBreakout(ctx([...base, [104, 112, 103, 110]]), 2)).toBeNull(); // close == mother high
  });
  it("liquidity sweep immediate vs confirmation get different timestamps", () => {
    const x = ctx([[99, 105, 98, 99]]); // high 5 above 100 in band, close below, upper wick 6/7
    const p = liquiditySweep(x, 0, 100, "sell")!;
    expect(p.entryMode).toBe("immediate_on_close");
    expect(p.confirmationTime).toBe(new Date(T0 + 300_000).toISOString());
    const rows: Row[] = [[100, 105, 99, 103], [100.5, 100.9, 99.5, 100], [100, 100.2, 97, 98]];
    const y = ctx(rows);
    expect(liquiditySweep(y, 1, 100, "sell")).toBeNull(); // not yet below sweep low (99)
    const q = liquiditySweep(y, 2, 100, "sell")!;
    expect(q.entryMode).toBe("confirmation");
    expect(q.barTime).toBe(y.c[0]!.time);
    expect(q.confirmationTime).toBe(new Date(T0 + 3 * 300_000).toISOString());
  });
  it("sweep beyond 1.0 ATR is not a sweep", () => {
    expect(liquiditySweep(ctx([[99, 111, 98, 99]]), 0, 100, "sell")).toBeNull();
  });
  it("fakeout records breakout and return; expires after 3 bars", () => {
    const rows: Row[] = [bar(98), bar(102), bar(101), bar(99)];
    const p = fakeout(ctx(rows), 3, 100)!;
    expect(p).toMatchObject({ direction: "bear", barTime: mk(rows)[1]!.time });
    const late: Row[] = [bar(98), bar(102), bar(103), bar(104), bar(101), bar(99)];
    expect(fakeout(ctx(late), 5, 100)).toBeNull();
  });
  it("breakout-retest long", () => {
    const rows: Row[] = [bar(95), [99, 110, 99, 109], bar(108), [104, 106, 100.5, 105.5]];
    // retest: low 100.5 <= 100+1.5, close>100, pin: lower wick 3.5>=2*1.5? body 1.5 → 3.5>=3 ✓, 3.5>=0.55*5.5 ✓, closePos .91 ✓, range 5.5>=5 ✓
    expect(breakoutRetest(ctx(rows), 3, 100)?.direction).toBe("bull");
  });
  it("compression breakout needs 6 compressed bars, bias and Donchian break", () => {
    const rows: Row[] = [...Array.from({ length: 20 }, () => bar(100)), [100, 108, 100, 107.5]];
    const x = ctx(rows);
    const w: Series = rows.map(() => 20);
    const don = { upper: rows.map((_, i) => (i >= 20 ? 101 : null)), lower: rows.map((_, i) => (i >= 20 ? 99 : null)) };
    expect(compressionBreakout(x, 20, w, don, "bull")?.direction).toBe("bull");
    expect(compressionBreakout(x, 20, w, don, "bear")).toBeNull();
    expect(compressionBreakout(x, 20, w, don, null)).toBeNull();
    const w2 = [...w];
    w2[17] = 20.01;
    expect(compressionBreakout(x, 20, w2, don, "bull")).toBeNull();
  });
  it("quality preserves components and clamps", () => {
    const q = quality(mk([[100, 130, 100, 125]])[0]!, 10, "bull");
    expect(q).toMatchObject({ status: "ok", bodyAtr: 1 });
    if (q.status === "ok") expect(q.q).toBeCloseTo(0.5 + 0.5 * (25 / 30), 12);
    expect(quality(mk([[1, 1, 1, 1]])[0]!, 10, "bull").status).toBe("unavailable");
    expect(quality(mk([[100, 130, 100, 125]])[0]!, null, "bull").status).toBe("unavailable");
  });
  it("lookahead: detectors ignore candles after i", () => {
    const rows: Row[] = [[105, 106, 99, 100], [100, 106, 99, 105.5]];
    const withFuture = ctx([...rows, [0, 1000, 0, 1]]);
    expect(engulfing(withFuture, 1)).toEqual(engulfing(ctx(rows), 1));
  });
});
