/** In-memory rolling candle buffers per pair/timeframe. REST candles from OANDA are the source of truth. */
import type { Candle, SpreadObs } from "../indicators/core.js";
import type { RestCandle } from "../oanda/parse.js";
import { TF_MIN, type Timeframe } from "../oanda/pipeline.js";
import type { Pair } from "../regime/regime.js";

export type StoredCandle = Candle & {
  tickVolume: number | null;
  bidClose: number | null;
  askClose: number | null;
};

export const BUFFER_LIMITS: Record<Timeframe, number> = { M1: 3000, M5: 1500, M15: 600 };
/** Backfill depth on start-up: enough for ATR percentile (200+), previous forex day, EMA200 on M15 and M1 vol ratio. */
export const BACKFILL_COUNTS: Record<Timeframe, number> = { M1: 3000, M5: 1500, M15: 600 };

/** Converts a parsed OANDA candle. Only COMPLETE candles with valid prices are kept; nothing is repaired. */
export function fromRest(c: RestCandle): StoredCandle | null {
  if (!c.complete) return null;
  const mid = c.mid ?? (c.bid && c.ask ? { o: (c.bid.o + c.ask.o) / 2, h: (c.bid.h + c.ask.h) / 2, l: (c.bid.l + c.ask.l) / 2, c: (c.bid.c + c.ask.c) / 2 } : null);
  if (!mid) return null;
  if (mid.h < Math.max(mid.o, mid.c) || mid.l > Math.min(mid.o, mid.c)) return null;
  const bidClose = c.bid?.c ?? null;
  const askClose = c.ask?.c ?? null;
  const crossed = bidClose !== null && askClose !== null && askClose < bidClose;
  return {
    time: c.time, open: mid.o, high: mid.h, low: mid.l, close: mid.c, complete: true,
    tickVolume: c.tickVolume, bidClose: crossed ? null : bidClose, askClose: crossed ? null : askClose,
  };
}

/** How many candles to request so the newest stored bar is overlapped (self-heals gaps after outages). */
export function fetchCount(lastTs: string | null, tf: Timeframe, nowMs: number): number {
  if (!lastTs) return BACKFILL_COUNTS[tf];
  const missing = Math.ceil((nowMs - Date.parse(lastTs)) / (TF_MIN[tf] * 60_000));
  return Math.max(5, Math.min(5000, missing + 3));
}

/** Timeframes whose bar closed exactly at this UTC minute boundary. */
export function closingTimeframes(minuteMs: number): Timeframe[] {
  const m = Math.floor(minuteMs / 60_000);
  return (["M1", "M5", "M15"] as Timeframe[]).filter((tf) => m % TF_MIN[tf] === 0);
}

export class MarketStore {
  private data = new Map<string, Map<string, StoredCandle>>();

  private key(pair: Pair, tf: Timeframe) {
    return `${pair}:${tf}`;
  }

  /** Inserts/updates candles; returns the ones that are new or whose prices changed. */
  upsert(pair: Pair, tf: Timeframe, candles: StoredCandle[]): StoredCandle[] {
    const k = this.key(pair, tf);
    const m = this.data.get(k) ?? new Map<string, StoredCandle>();
    this.data.set(k, m);
    const changed: StoredCandle[] = [];
    for (const c of candles) {
      const prev = m.get(c.time);
      if (!prev || prev.open !== c.open || prev.high !== c.high || prev.low !== c.low || prev.close !== c.close) changed.push(c);
      m.set(c.time, c);
    }
    if (m.size > BUFFER_LIMITS[tf]) {
      const keys = [...m.keys()].sort();
      for (const old of keys.slice(0, m.size - BUFFER_LIMITS[tf])) m.delete(old);
    }
    return changed.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  }

  candles(pair: Pair, tf: Timeframe): StoredCandle[] {
    return [...(this.data.get(this.key(pair, tf))?.values() ?? [])].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  }

  lastTs(pair: Pair, tf: Timeframe): string | null {
    const c = this.candles(pair, tf);
    return c.length ? c[c.length - 1]!.time : null;
  }

  /** Spread history from real M1 bid/ask closes (one observation per minute). */
  spreads(pair: Pair): SpreadObs[] {
    return this.candles(pair, "M1")
      .filter((c) => c.bidClose !== null && c.askClose !== null)
      .map((c) => ({ time: new Date(Date.parse(c.time) + 60_000).toISOString(), spread: c.askClose! - c.bidClose! }));
  }
}
