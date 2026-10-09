/** Candle aggregation, gap detection, reconciliation, feed state and backoff. Pure; times are UTC. */

export type Timeframe = "M1" | "M5" | "M15";
export const TF_MIN: Record<Timeframe, number> = { M1: 1, M5: 5, M15: 15 };

export function bucketStart(timeIso: string, tf: Timeframe): string {
  const t = Date.parse(timeIso);
  const size = TF_MIN[tf] * 60_000;
  return new Date(Math.floor(t / size) * size).toISOString();
}

export type BuiltCandle = {
  timeframe: Timeframe;
  ts: string;
  open: number; high: number; low: number; close: number;
  tickCount: number;
  bidClose: number; askClose: number;
  spreadSum: number; spreadMax: number;
};

/**
 * Aggregates mid prices into UTC buckets. A candle is emitted only when a tick arrives in a later bucket
 * or `closeUpTo(now)` passes its end — so consumers only ever see CLOSED candles.
 * Heartbeats must never be passed in here.
 */
export class CandleAggregator {
  private open = new Map<Timeframe, BuiltCandle>();
  constructor(private readonly tfs: Timeframe[] = ["M1", "M5", "M15"]) {}

  onPrice(p: { time: string; bid: number; ask: number }): BuiltCandle[] {
    const mid = (p.bid + p.ask) / 2;
    const spread = p.ask - p.bid;
    const closed: BuiltCandle[] = [];
    for (const tf of this.tfs) {
      const ts = bucketStart(p.time, tf);
      const cur = this.open.get(tf);
      if (cur && Date.parse(ts) < Date.parse(cur.ts)) continue; // out-of-order tick for an already-closed bucket: drop
      if (cur && cur.ts !== ts) {
        closed.push(cur);
        this.open.delete(tf);
      }
      const c = this.open.get(tf);
      if (!c) {
        this.open.set(tf, { timeframe: tf, ts, open: mid, high: mid, low: mid, close: mid, tickCount: 1, bidClose: p.bid, askClose: p.ask, spreadSum: spread, spreadMax: spread });
      } else {
        c.high = Math.max(c.high, mid);
        c.low = Math.min(c.low, mid);
        c.close = mid;
        c.tickCount++;
        c.bidClose = p.bid;
        c.askClose = p.ask;
        c.spreadSum += spread;
        c.spreadMax = Math.max(c.spreadMax, spread);
      }
    }
    return closed;
  }

  /** Closes any open bucket whose end time is <= now (used when ticks pause at bar close). */
  closeUpTo(nowIso: string): BuiltCandle[] {
    const out: BuiltCandle[] = [];
    for (const [tf, c] of this.open) {
      if (Date.parse(c.ts) + TF_MIN[tf] * 60_000 <= Date.parse(nowIso)) {
        out.push(c);
        this.open.delete(tf);
      }
    }
    return out;
  }
}

/**
 * Documented FX schedule (UTC): closed from Friday 21:00 to Sunday 21:00. OANDA's actual close shifts by an hour with
 * US daylight saving and holidays, so this is only an *expectation*; actual availability is confirmed by `tradeable` prices.
 */
export function expectedOpen(now: Date, closeHourUtc = 21): boolean {
  const d = now.getUTCDay();
  const h = now.getUTCHours();
  if (d === 6) return false;
  if (d === 5 && h >= closeHourUtc) return false;
  if (d === 0 && h < closeHourUtc) return false;
  return true;
}

/** Bars expected between [from, to) that are absent, skipping the documented weekend closure. */
export function findMissingBars(present: string[], tf: Timeframe, fromIso: string, toIso: string): string[] {
  const have = new Set(present.map((t) => new Date(t).toISOString()));
  const step = TF_MIN[tf] * 60_000;
  const missing: string[] = [];
  for (let t = Date.parse(bucketStart(fromIso, tf)); t < Date.parse(toIso); t += step) {
    const iso = new Date(t).toISOString();
    if (expectedOpen(new Date(t)) && !have.has(iso)) missing.push(iso);
  }
  return missing;
}

export type Discrepancy = { field: "open" | "high" | "low" | "close"; local: number; source: number; diff: number };

/**
 * Source-of-truth policy: a COMPLETE REST candle from OANDA wins. Local aggregates are compared and any field
 * differing by more than `toleranceFraction` of price is recorded; the REST value is what gets stored.
 */
export function reconcile(local: { open: number; high: number; low: number; close: number }, source: { o: number; h: number; l: number; c: number }, toleranceFraction = 0.0001): Discrepancy[] {
  const pairs: [Discrepancy["field"], number, number][] = [["open", local.open, source.o], ["high", local.high, source.h], ["low", local.low, source.l], ["close", local.close, source.c]];
  return pairs
    .filter(([, l, s]) => Math.abs(l - s) > s * toleranceFraction)
    .map(([field, l, s]) => ({ field, local: l, source: s, diff: l - s }));
}

export type FeedState = "connected" | "stale" | "degraded" | "disconnected" | "market_closed";

/**
 * - disconnected: no open stream.
 * - market_closed: schedule says closed AND we're not receiving tradeable prices.
 * - degraded: stream open but no usable tick for >= degradeAfterMs while market expected open → caller must reconnect.
 * - stale: last usable tick older than staleAfterMs but younger than degrade threshold.
 * Heartbeats do not refresh lastTickAt.
 */
export function feedState(a: { streamOpen: boolean; lastUsableTickAt: string | null; now: Date; lastTradeable: boolean }, staleAfterMs = 10_000, degradeAfterMs = 20_000): FeedState {
  if (!a.streamOpen) return "disconnected";
  const open = expectedOpen(a.now);
  const age = a.lastUsableTickAt ? a.now.getTime() - Date.parse(a.lastUsableTickAt) : Infinity;
  if (!open && (!a.lastTradeable || age >= degradeAfterMs)) return "market_closed";
  if (age >= degradeAfterMs) return "degraded";
  if (age >= staleAfterMs) return "stale";
  return "connected";
}

/** Exponential backoff with full jitter. */
export function backoffDelay(attempt: number, baseMs = 1_000, maxMs = 60_000, rand: () => number = Math.random): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(rand() * cap);
}
