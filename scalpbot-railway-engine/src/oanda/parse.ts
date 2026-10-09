/**
 * OANDA v20 message parsing. Pure functions, no I/O.
 *
 * Schemas follow the OANDA v20 REST docs (developer.oanda.com/rest-live-v20):
 *  - Pricing stream lines: ClientPrice { type: "PRICE", instrument, time, tradeable, bids: PriceBucket[], asks: PriceBucket[],
 *    closeoutBid, closeoutAsk } or PricingHeartbeat { type: "HEARTBEAT", time }. PriceValue fields are decimal STRINGS.
 *  - GET /v3/instruments/{instrument}/candles?price=MBA → { instrument, granularity, candles: Candlestick[] },
 *    Candlestick { time, complete, volume, mid?, bid?, ask? } with CandlestickData { o, h, l, c } as strings.
 *  - `volume` is the number of price updates (ticks) in the bar — NOT centralised traded volume.
 * Re-check these definitions against OANDA's docs before relying on new fields.
 */

export type PriceMsg = {
  kind: "price";
  instrument: string;
  time: string; // ISO, ms precision, UTC
  bid: number | null;
  ask: number | null;
  mid: number | null;
  tradeable: boolean;
};
export type StreamMsg =
  | PriceMsg
  | { kind: "heartbeat"; time: string }
  | { kind: "malformed"; reason: string; raw: string }
  | { kind: "ignored"; type: string };

/** Strict decimal parse: rejects "", "NaN", "1e5", "0x10", whitespace, negatives and zero. */
export function parsePrice(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v);
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** OANDA times can carry nanoseconds ("…T10:00:00.123456789Z"); normalise to ms ISO or null. */
export function parseOandaTime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z$/.exec(v);
  if (!m) return null;
  const frac = (m[2] ?? ".000").slice(0, 4).padEnd(4, "0");
  const d = new Date(`${m[1]}${frac}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function midOf(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null || ask < bid) return null;
  return (bid + ask) / 2;
}

function topOfBook(buckets: unknown): number | null {
  if (!Array.isArray(buckets) || buckets.length === 0) return null;
  const first = buckets[0] as { price?: unknown } | null;
  return parsePrice(first?.price);
}

export function parseStreamLine(raw: string): StreamMsg {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { kind: "malformed", reason: "invalid_json", raw: raw.slice(0, 200) };
  }
  if (!o || typeof o !== "object") return { kind: "malformed", reason: "not_object", raw: raw.slice(0, 200) };
  const m = o as Record<string, unknown>;
  const time = parseOandaTime(m["time"]);
  if (m["type"] === "HEARTBEAT") {
    return time ? { kind: "heartbeat", time } : { kind: "malformed", reason: "bad_time", raw: raw.slice(0, 200) };
  }
  if (m["type"] !== "PRICE") return { kind: "ignored", type: String(m["type"] ?? "unknown") };
  if (!time) return { kind: "malformed", reason: "bad_time", raw: raw.slice(0, 200) };
  if (typeof m["instrument"] !== "string") return { kind: "malformed", reason: "no_instrument", raw: raw.slice(0, 200) };
  const bid = topOfBook(m["bids"]);
  const ask = topOfBook(m["asks"]);
  const validPair = bid != null && ask != null && ask >= bid;
  return {
    kind: "price",
    instrument: m["instrument"],
    time,
    bid: validPair ? bid : null,
    ask: validPair ? ask : null,
    mid: midOf(bid, ask),
    tradeable: m["tradeable"] === true && validPair,
  };
}

/** Splits a chunked HTTP stream into complete lines, keeping any partial trailing line buffered. */
export class LineSplitter {
  private buf = "";
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    return parts.map((l) => l.trim()).filter(Boolean);
  }
}

export type Ohlc = { o: number; h: number; l: number; c: number };
export type RestCandle = {
  time: string;
  complete: boolean;
  tickVolume: number | null;
  mid: Ohlc | null;
  bid: Ohlc | null;
  ask: Ohlc | null;
};

function ohlc(v: unknown): Ohlc | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  const o = parsePrice(d["o"]), h = parsePrice(d["h"]), l = parsePrice(d["l"]), c = parsePrice(d["c"]);
  if (o == null || h == null || l == null || c == null) return null;
  if (h < Math.max(o, c) || l > Math.min(o, c) || h < l) return null;
  return { o, h, l, c };
}

/** Parses a /candles response. Bars with malformed prices are returned in `rejected`, never repaired. */
export function parseCandlesResponse(body: unknown): { candles: RestCandle[]; rejected: { index: number; reason: string }[] } {
  const out: RestCandle[] = [];
  const rejected: { index: number; reason: string }[] = [];
  const list = (body as { candles?: unknown })?.candles;
  if (!Array.isArray(list)) return { candles: [], rejected: [{ index: -1, reason: "no_candles_array" }] };
  list.forEach((raw, index) => {
    const r = raw as Record<string, unknown>;
    const time = parseOandaTime(r?.["time"]);
    if (!time) { rejected.push({ index, reason: "bad_time" }); return; }
    const mid = r["mid"] === undefined ? null : ohlc(r["mid"]);
    const bid = r["bid"] === undefined ? null : ohlc(r["bid"]);
    const ask = r["ask"] === undefined ? null : ohlc(r["ask"]);
    if ((r["mid"] !== undefined && !mid) || (r["bid"] !== undefined && !bid) || (r["ask"] !== undefined && !ask))
      { rejected.push({ index, reason: "invalid_ohlc" }); return; }
    if (!mid && !(bid && ask)) { rejected.push({ index, reason: "no_prices" }); return; }
    const vol = r["volume"];
    out.push({
      time,
      complete: r["complete"] === true,
      tickVolume: typeof vol === "number" && Number.isInteger(vol) && vol >= 0 ? vol : null,
      mid,
      bid,
      ask,
    });
  });
  return { candles: out, rejected };
}

/** Instrument metadata → display precision. Never hard-code; read `displayPrecision` from /v3/accounts/{id}/instruments. */
export function displayPrecisionOf(meta: unknown): number | null {
  const p = (meta as { displayPrecision?: unknown })?.displayPrecision;
  return typeof p === "number" && Number.isInteger(p) && p >= 0 && p <= 10 ? p : null;
}
