// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LineSplitter, displayPrecisionOf, midOf, parseCandlesResponse, parseOandaTime, parsePrice, parseStreamLine } from "./parse.js";
import { CandleAggregator, backoffDelay, bucketStart, expectedOpen, feedState, findMissingBars, reconcile } from "./pipeline.js";
import { loadOandaConfig } from "./config.js";
import { runPricingStream } from "./stream-client.js";

// ---- Test fixtures only (synthetic, never used outside tests) ----
const PRICE = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "PRICE", instrument: "EUR_USD", time: "2026-10-07T10:00:01.123456789Z", tradeable: true, bids: [{ price: "1.10010", liquidity: 1e6 }], asks: [{ price: "1.10020", liquidity: 1e6 }], ...o });

describe("string to number parsing", () => {
  it("parses decimal strings", () => expect(parsePrice("1.10010")).toBe(1.1001));
  it.each(["", "NaN", "1e5", "-1.1", "0", "0x10", " 1.1", "Infinity", "1,1"])("rejects %j", (v) => expect(parsePrice(v)).toBeNull());
  it("rejects non-strings", () => expect(parsePrice({})).toBeNull());
  it("computes mid only with valid bid and ask", () => {
    expect(midOf(1.1, 1.2)).toBeCloseTo(1.15);
    expect(midOf(null, 1.2)).toBeNull();
    expect(midOf(1.3, 1.2)).toBeNull();
  });
  it("normalises nanosecond times to UTC ms", () => expect(parseOandaTime("2026-10-07T10:00:01.123456789Z")).toBe("2026-10-07T10:00:01.123Z"));
  it("rejects non-UTC times", () => expect(parseOandaTime("2026-10-07T10:00:01+01:00")).toBeNull());
  it("reads display precision from metadata", () => {
    expect(displayPrecisionOf({ displayPrecision: 5 })).toBe(5);
    expect(displayPrecisionOf({})).toBeNull();
  });
});

describe("stream messages", () => {
  it("parses a PRICE", () => {
    const m = parseStreamLine(PRICE());
    expect(m).toMatchObject({ kind: "price", bid: 1.1001, ask: 1.1002, tradeable: true });
  });
  it("treats heartbeat as heartbeat, never a price", () => expect(parseStreamLine('{"type":"HEARTBEAT","time":"2026-10-07T10:00:05.000000000Z"}').kind).toBe("heartbeat"));
  it("flags malformed JSON", () => expect(parseStreamLine("{not json")).toMatchObject({ kind: "malformed", reason: "invalid_json" }));
  it("flags bad timestamps", () => expect(parseStreamLine(PRICE({ time: "yesterday" }))).toMatchObject({ kind: "malformed", reason: "bad_time" }));
  it("marks crossed books as non-tradeable without prices", () =>
    expect(parseStreamLine(PRICE({ bids: [{ price: "1.2" }], asks: [{ price: "1.1" }] }))).toMatchObject({ bid: null, ask: null, mid: null, tradeable: false }));
  it("marks tradeable:false prices as non-tradeable", () => expect(parseStreamLine(PRICE({ tradeable: false }))).toMatchObject({ tradeable: false }));
  it("handles empty books", () => expect(parseStreamLine(PRICE({ bids: [] }))).toMatchObject({ bid: null, tradeable: false }));
  it("ignores unknown types", () => expect(parseStreamLine('{"type":"FOO"}').kind).toBe("ignored"));
  it("splits chunked lines and buffers partials", () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n')).toEqual(['{"b":2}']);
  });
});

describe("REST candles", () => {
  const body = {
    instrument: "EUR_USD", granularity: "M5",
    candles: [
      { time: "2026-10-07T09:55:00.000000000Z", complete: true, volume: 812, mid: { o: "1.1", h: "1.102", l: "1.099", c: "1.101" }, bid: { o: "1.0999", h: "1.1019", l: "1.0989", c: "1.1009" }, ask: { o: "1.1001", h: "1.1021", l: "1.0991", c: "1.1011" } },
      { time: "2026-10-07T10:00:00.000000000Z", complete: false, volume: 3, mid: { o: "1.101", h: "1.101", l: "1.101", c: "1.101" } },
      { time: "2026-10-07T10:05:00Z", complete: true, volume: 1, mid: { o: "1.1", h: "1.09", l: "1.099", c: "1.101" } },
      { time: "bad", complete: true, mid: { o: "1", h: "1", l: "1", c: "1" } },
    ],
  };
  it("parses valid candles and tick volume", () => {
    const r = parseCandlesResponse(body);
    expect(r.candles).toHaveLength(2);
    expect(r.candles[0]).toMatchObject({ complete: true, tickVolume: 812, mid: { h: 1.102 } });
    expect(r.candles[1]!.complete).toBe(false);
  });
  it("rejects invalid OHLC and bad times without repairing", () =>
    expect(parseCandlesResponse(body).rejected.map((x) => x.reason)).toEqual(["invalid_ohlc", "bad_time"]));
  it("rejects bodies without candles", () => expect(parseCandlesResponse({}).rejected[0]!.reason).toBe("no_candles_array"));
});

describe("UTC buckets & aggregation", () => {
  it("buckets at UTC boundaries", () => {
    expect(bucketStart("2026-10-07T09:59:59.999Z", "M15")).toBe("2026-10-07T09:45:00.000Z");
    expect(bucketStart("2026-10-07T10:00:00.000Z", "M15")).toBe("2026-10-07T10:00:00.000Z");
    expect(bucketStart("2026-10-07T23:59:30Z", "M5")).toBe("2026-10-07T23:55:00.000Z");
  });
  it("emits only closed candles with correct OHLC", () => {
    const a = new CandleAggregator(["M1"]);
    expect(a.onPrice({ time: "2026-10-07T10:00:01Z", bid: 1.0, ask: 1.2 })).toEqual([]);
    a.onPrice({ time: "2026-10-07T10:00:30Z", bid: 1.2, ask: 1.4 });
    a.onPrice({ time: "2026-10-07T10:00:50Z", bid: 0.9, ask: 1.1 });
    const closed = a.onPrice({ time: "2026-10-07T10:01:00Z", bid: 1.0, ask: 1.0 });
    expect(closed).toHaveLength(1);
    const c = closed[0]!;
    expect(c.ts).toBe("2026-10-07T10:00:00.000Z");
    expect(c.tickCount).toBe(3);
    expect(c.open).toBeCloseTo(1.1);
    expect(c.high).toBeCloseTo(1.3);
    expect(c.low).toBeCloseTo(1.0);
    expect(c.close).toBeCloseTo(1.0);
    expect(closed[0]!.spreadMax).toBeCloseTo(0.2);
  });
  it("closes open buckets when time passes without ticks", () => {
    const a = new CandleAggregator(["M5"]);
    a.onPrice({ time: "2026-10-07T10:01:00Z", bid: 1, ask: 1.1 });
    expect(a.closeUpTo("2026-10-07T10:04:59Z")).toEqual([]);
    expect(a.closeUpTo("2026-10-07T10:05:00Z")).toHaveLength(1);
  });
  it("drops out-of-order ticks for closed buckets", () => {
    const a = new CandleAggregator(["M1"]);
    a.onPrice({ time: "2026-10-07T10:01:10Z", bid: 1, ask: 1.1 });
    expect(a.onPrice({ time: "2026-10-07T10:00:59Z", bid: 5, ask: 5.1 })).toEqual([]);
  });
});

describe("gaps, schedule, reconciliation", () => {
  it("finds missing bars", () =>
    expect(findMissingBars(["2026-10-07T10:00:00Z", "2026-10-07T10:10:00Z"], "M5", "2026-10-07T10:00:00Z", "2026-10-07T10:15:00Z")).toEqual(["2026-10-07T10:05:00.000Z"]));
  it("duplicate candles do not create or hide gaps", () =>
    expect(findMissingBars(["2026-10-07T10:00:00Z", "2026-10-07T10:00:00.000Z"], "M5", "2026-10-07T10:00:00Z", "2026-10-07T10:05:00Z")).toEqual([]));
  it("does not count weekend closure as gaps", () => expect(findMissingBars([], "M15", "2026-10-10T00:00:00Z", "2026-10-10T02:00:00Z")).toEqual([]));
  it("expects market closed Saturday and open Wednesday", () => {
    expect(expectedOpen(new Date("2026-10-10T12:00:00Z"))).toBe(false);
    expect(expectedOpen(new Date("2026-10-07T12:00:00Z"))).toBe(true);
    expect(expectedOpen(new Date("2026-10-09T21:30:00Z"))).toBe(false);
    expect(expectedOpen(new Date("2026-10-11T21:30:00Z"))).toBe(true);
  });
  it("records OHLC discrepancies beyond tolerance", () => {
    expect(reconcile({ open: 1.1, high: 1.2, low: 1.0, close: 1.15 }, { o: 1.1, h: 1.2, l: 1.0, c: 1.15 })).toEqual([]);
    expect(reconcile({ open: 1.1, high: 1.21, low: 1.0, close: 1.15 }, { o: 1.1, h: 1.2, l: 1.0, c: 1.15 }).map((d) => d.field)).toEqual(["high"]);
  });
});

describe("feed state & reconnect", () => {
  const now = new Date("2026-10-07T10:00:30Z");
  it("disconnected when stream closed", () => expect(feedState({ streamOpen: false, lastUsableTickAt: null, now, lastTradeable: true })).toBe("disconnected"));
  it("connected with fresh tick", () => expect(feedState({ streamOpen: true, lastUsableTickAt: "2026-10-07T10:00:29Z", now, lastTradeable: true })).toBe("connected"));
  it("stale after 10s", () => expect(feedState({ streamOpen: true, lastUsableTickAt: "2026-10-07T10:00:15Z", now, lastTradeable: true })).toBe("stale"));
  it("degraded after 20s without usable ticks", () => expect(feedState({ streamOpen: true, lastUsableTickAt: "2026-10-07T10:00:05Z", now, lastTradeable: true })).toBe("degraded"));
  it("degraded when only heartbeats have arrived", () => expect(feedState({ streamOpen: true, lastUsableTickAt: null, now, lastTradeable: false })).toBe("degraded"));
  it("market_closed on weekend with no tradeable data", () =>
    expect(feedState({ streamOpen: true, lastUsableTickAt: null, now: new Date("2026-10-10T12:00:00Z"), lastTradeable: false })).toBe("market_closed"));
  it("backoff grows exponentially and is capped", () => {
    expect(backoffDelay(0, 1000, 60000, () => 0.999)).toBe(999);
    expect(backoffDelay(3, 1000, 60000, () => 0.999)).toBe(7992);
    expect(backoffDelay(20, 1000, 60000, () => 0.999)).toBe(59940);
    expect(backoffDelay(5, 1000, 60000, () => 0)).toBe(0);
  });
  it("reconnects after stream errors and ignores heartbeats for liveness", async () => {
    const cfg = loadOandaConfig({ OANDA_TOKEN: "x".repeat(30), OANDA_ACCOUNT_ID: "101-004-1234567-001", OANDA_ENV: "practice" });
    let calls = 0;
    const msgs: string[] = [];
    const states: string[] = [];
    const fakeFetch = (async () => {
      calls++;
      if (calls === 1) return new Response("nope", { status: 503 });
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"type":"HEARTBEAT","time":"2026-10-07T10:00:00Z"}\n' + PRICE() + "\n"));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    await runPricingStream(cfg, (m) => msgs.push(m.kind), (s) => states.push(s.state), { fetchImpl: fakeFetch, sleep: async () => {}, maxAttempts: 2 });
    expect(calls).toBe(2);
    expect(msgs).toEqual(["heartbeat", "price"]);
    expect(states).toEqual(["connecting", "disconnected", "connecting", "open", "disconnected"]);
  });
});

describe("config", () => {
  it("refuses non-practice environments", () =>
    expect(() => loadOandaConfig({ OANDA_TOKEN: "x".repeat(30), OANDA_ACCOUNT_ID: "101-004-1234567-001", OANDA_ENV: "live" })).toThrow());
  it("uses the practice hosts", () =>
    expect(loadOandaConfig({ OANDA_TOKEN: "x".repeat(30), OANDA_ACCOUNT_ID: "101-004-1234567-001", OANDA_ENV: "practice" }).rest).toBe("https://api-fxpractice.oanda.com"));
});
