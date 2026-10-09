import { describe, it, expect } from "vitest";
import * as R from "./risk.js";

const spec: R.BrokerSpec = { verified: true, contractSize: 100, minVolume: 0.01, volumeStep: 0.01, tickSize: 0.01, tickValue: 1, accountCurrency: "USD" };

describe("levels", () => {
  it("BUY/SELL symmetry", () => {
    const b = R.buildLevels({ side: "BUY", entry: 100, structuralStop: 99, atr14: 1, spread: 0.1 });
    const s = R.buildLevels({ side: "SELL", entry: 100, structuralStop: 101, atr14: 1, spread: 0.1 });
    expect(b.ok && b.value.tp1).toBe(101); expect(b.ok && b.value.tp2).toBe(102);
    expect(s.ok && s.value.tp1).toBe(99); expect(s.ok && s.value.tp2).toBe(98);
  });
  it("rejects invalid levels", () => {
    expect(R.buildLevels({ side: "BUY", entry: 100, structuralStop: 101, atr14: 1, spread: 0 })).toEqual({ ok: false, reasons: ["sl_not_below_entry"] });
    expect(R.buildLevels({ side: "SELL", entry: 100, structuralStop: 99, atr14: 1, spread: 0 }).ok).toBe(false);
    const tight = R.buildLevels({ side: "BUY", entry: 100, structuralStop: 99.5, atr14: 1, spread: 0 });
    expect(!tight.ok && tight.reasons).toContain("stop_too_tight_vs_atr");
    const wide = R.buildLevels({ side: "BUY", entry: 100, structuralStop: 97.9, atr14: 1, spread: 0 });
    expect(!wide.ok && wide.reasons).toContain("stop_too_wide_vs_atr");
    const blocked = R.buildLevels({ side: "BUY", entry: 100, structuralStop: 99, atr14: 1, spread: 0, blockingLevels: [100.5] });
    expect(!blocked.ok && blocked.reasons).toContain("key_level_blocks_tp1");
  });
  it("spread reduces net reward/risk", () => {
    const b = R.buildLevels({ side: "BUY", entry: 100, structuralStop: 99, atr14: 1, spread: 0.2 });
    if (!b.ok) throw new Error();
    expect(R.netRewardRisk(b.value, 0)).toBe(2);
    expect(R.netRewardRisk(b.value, 0.2)).toBeCloseTo(1.8 / 1.2);
    expect(R.midToExecutableEntry("BUY", 100, 0.2)).toBeCloseTo(100.1);
    expect(R.midToExecutableEntry("SELL", 100, 0.2)).toBeCloseTo(99.9);
  });
});

describe("management", () => {
  const st: R.MgmtState = { side: "BUY", entry: 100, r: 1, stop: 99, tp1Hit: false, openedAt: "2026-01-01T00:00:00Z" };
  it("partial + BE then trail only tightens with 0.3 ATR min step", () => {
    const a = R.manageOnM5Close(st, { close: 101, high: 101.1, low: 100, closeTime: "2026-01-01T00:05:00Z", closed: true }, 1);
    expect(a.actions[0]).toEqual({ type: "PARTIAL_AND_BREAKEVEN", fraction: 0.5, newStop: 100 });
    expect(a.state.stop).toBe(100);
    const b = R.manageOnM5Close(a.state, { close: 101.2, high: 101.3, low: 101, closeTime: "2026-01-01T00:10:00Z", closed: true }, 1);
    expect(b.actions).toEqual([]);
    const c = R.manageOnM5Close(a.state, { close: 101.4, high: 101.5, low: 101, closeTime: "2026-01-01T00:10:00Z", closed: true }, 1);
    expect(c.state.stop).toBeCloseTo(100.4);
    const d = R.manageOnM5Close(c.state, { close: 100.5, high: 100.6, low: 100.4, closeTime: "2026-01-01T00:15:00Z", closed: true }, 1);
    expect(d.state.stop).toBeCloseTo(100.4);
  });
  it("ignores forming bars and raises time stop alert", () => {
    expect(R.manageOnM5Close(st, { close: 105, high: 105, low: 100, closeTime: "2026-01-01T00:05:00Z", closed: false }, 1).actions).toEqual([]);
    const t = R.manageOnM5Close(st, { close: 100.2, high: 100.3, low: 100, closeTime: "2026-01-01T00:50:00Z", closed: true }, 1);
    expect(t.actions.some((x) => x.type === "TIME_STOP_ALERT")).toBe(true);
  });
});

describe("latency and timing", () => {
  it("predicted move formula and no double counting", () => {
    expect(R.totalLatency("2026-01-01T00:00:00Z", "2026-01-01T00:00:10Z", 5)).toBe(15);
    expect(R.predictedMoveQuantile(0.001, 60, 2000)).toBeCloseTo(1.28 * 0.001 * 2000);
    expect(R.predictedMoveQuantile(null, 60, 2000)).toBeNull();
    expect(R.measuredLatency({ requestStart: "2026-01-01T00:00:00Z", analysisDone: "2026-01-01T00:00:02Z" }).analysis).toBe(2);
  });
  const base = { side: "BUY" as const, proposedEntry: 100, invalidationLevel: 99, now: "2026-01-01T00:00:00Z", nextOpportunity: "2026-01-01T00:01:00Z", windowSec: 60, expectedDelaySec: 10, minLeadSec: 10, capAtr: 0.2, atr14: 1 };
  it("plans entry or fails on lead time / missing cap", () => {
    expect(R.planEntry(base).status).toBe("VALID");
    expect(R.planEntry({ ...base, expectedDelaySec: 55 }).status).toBe("NO_VALID_SETUP");
    expect(R.planEntry({ ...base, capAtr: null }).status).toBe("NO_VALID_SETUP");
  });
  const plan = (R.planEntry(base) as { status: "VALID"; plan: R.EntryPlan }).plan;
  const ok = { now: "2026-01-01T00:01:10Z", quote: { bid: 99.95, ask: 100.05, time: "2026-01-01T00:01:09Z" }, maxQuoteAgeSec: 5, latestClosed: { closeTime: "2026-01-01T00:01:00Z", low: 99.5, high: 100.2, closed: true }, publicationKey: "k" };
  const why = (x: R.Revalidation) => (x.status === "NO_VALID_SETUP" ? x.reasons : []);
  it("revalidation cases", () => {
    expect(R.revalidate(plan, ok).status).toBe("VALID");
    expect(why(R.revalidate(plan, { ...ok, quote: { ...ok.quote, time: "2026-01-01T00:00:00Z" } }))).toContain("stale_quote");
    expect(why(R.revalidate(plan, { ...ok, quote: { bid: 100.5, ask: 100.6, time: ok.quote.time } }))).toContain("price_runaway");
    expect(why(R.revalidate(plan, { ...ok, now: "2026-01-01T00:02:30Z", quote: { ...ok.quote, time: "2026-01-01T00:02:29Z" } }))).toContain("entry_expired");
    expect(why(R.revalidate(plan, { ...ok, latestClosed: { ...ok.latestClosed, low: 98.9 } }))).toContain("setup_invalidated");
    expect(why(R.revalidate(plan, { ...ok, alreadyPublishedKeys: new Set(["k"]) }))).toContain("duplicate_publication");
    expect(why(R.revalidate(plan, { ...ok, latestClosed: { ...ok.latestClosed, closed: false } }))).toContain("no_closed_candle");
  });
});

describe("sizing", () => {
  const base = { balance: 10000, balanceVerified: true, riskFraction: 0.005, stopDistance: 2, spec, demoOnly: true };
  it("rounds down to volume step", () => {
    const r = R.sizePosition({ ...base, stopDistance: 3 });
    // risk 50; per lot 300 -> 0.1666 -> 0.16
    expect(r.ok && r.value.volume).toBe(0.16);
  });
  it("rejects zero/invalid tick values, unverified spec, below min", () => {
    expect(R.sizePosition({ ...base, spec: { ...spec, tickValue: 0 } }).ok).toBe(false);
    expect(R.sizePosition({ ...base, spec: { ...spec, verified: false } }).ok).toBe(false);
    expect(R.sizePosition({ ...base, stopDistance: 100 })).toEqual({ ok: false, reasons: ["below_min_volume"] });
    expect(R.sizePosition({ ...base, demoOnly: false }).ok).toBe(false);
    expect(R.tickValueFromQuote(100000, 0.00001, null)).toBeNull();
    expect(R.tickValueFromQuote(100000, 0.00001, 1)).toBeCloseTo(1);
  });
});

describe("limits", () => {
  const acct: R.AccountState = { killSwitch: false, openTrades: 0, consecutiveNetLosses: 0, signalsToday: 0, signalsThisSession: 0, dailyNetPnl: 0, dayStartBalance: 10000, lastSameSignalAt: null };
  const now = "2026-01-01T10:00:00Z";
  it("enforces guards and fails closed", () => {
    expect(R.checkLimits(acct, R.DEFAULT_LIMITS, now).ok).toBe(true);
    expect(R.checkLimits(null, R.DEFAULT_LIMITS, now).ok).toBe(false);
    expect(R.checkLimits(acct, null, now).ok).toBe(false);
    const r = R.checkLimits({ ...acct, killSwitch: true, openTrades: 2, consecutiveNetLosses: 3, signalsToday: 8, signalsThisSession: 3, dailyNetPnl: -300, lastSameSignalAt: "2026-01-01T09:50:00Z" }, R.DEFAULT_LIMITS, now);
    expect(!r.ok && r.reasons).toEqual(["kill_switch_active", "max_open_trades", "loss_streak_pause", "daily_signal_cap", "session_signal_cap", "daily_loss_stop", "same_direction_cooldown"]);
  });
});

describe("ledger", () => {
  it("reconciles partial exits with real costs", () => {
    const r = R.reconcileLedger({ side: "BUY", swaps: 0, valuePerPriceUnitPerLot: 100, riskBasisCash: 100, fills: [
      { kind: "ENTRY", price: 2000, volume: 0.1, time: "t", commission: 0.7 },
      { kind: "EXIT", price: 2010, volume: 0.05, time: "t", commission: 0.35 },
      { kind: "EXIT", price: 2000, volume: 0.05, time: "t", commission: 0.35 },
    ] });
    if (!r.ok) throw new Error();
    expect(r.value.grossPnl).toBeCloseTo(50);
    expect(r.value.netPnl).toBeCloseTo(48.6); // break-even leg is not zero after costs
    expect(r.value.openVolume).toBe(0);
    expect(r.value.rMultiple).toBeCloseTo(0.486);
  });
  it("rejects over-exit and SELL math", () => {
    expect(R.reconcileLedger({ side: "SELL", swaps: 0, valuePerPriceUnitPerLot: 1, riskBasisCash: null, fills: [{ kind: "ENTRY", price: 1, volume: 1, time: "t", commission: 0 }, { kind: "EXIT", price: 1, volume: 2, time: "t", commission: 0 }] }).ok).toBe(false);
    const s = R.reconcileLedger({ side: "SELL", swaps: 0, valuePerPriceUnitPerLot: 1, riskBasisCash: null, fills: [{ kind: "ENTRY", price: 10, volume: 1, time: "t", commission: 0 }, { kind: "EXIT", price: 9, volume: 1, time: "t", commission: 0 }] });
    expect(s.ok && s.value.netPnl).toBe(1);
  });
});
