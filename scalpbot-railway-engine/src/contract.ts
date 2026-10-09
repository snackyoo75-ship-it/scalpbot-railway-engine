import { z } from "zod";

export const Symbol = z.enum(["XAUUSD", "EURUSD"]);
export const Stage = z.enum(["queued", "fetching_data", "validating_data", "computing_features", "scoring", "risk_check", "done"]);

export const Heartbeat = z.object({
  component: z.literal("quant-engine"),
  status: z.enum(["ok", "degraded", "down"]),
  version: z.string(),
  details: z.record(z.unknown()).default({}),
  last_seen_at: z.string().datetime(),
});

export const FeedStatus = z.object({
  symbol: Symbol,
  provider: z.string().min(1),
  status: z.enum(["connected", "stale", "disconnected"]),
  last_tick_at: z.string().datetime().nullable(),
});

export const SignalOutput = z
  .object({
    request_id: z.string().uuid(),
    user_id: z.string().uuid(),
    symbol: Symbol,
    direction: z.enum(["long", "short"]),
    entry_price: z.number().positive(),
    stop_loss: z.number().positive(),
    take_profit_1: z.number().positive(),
    take_profit_2: z.number().positive().nullable(),
    score: z.number().int().min(0).max(100),
    reward_risk: z.number().positive(),
    strategy_version: z.string().min(1),
    rationale: z.record(z.unknown()),
    data_as_of: z.string().datetime(),
    valid_until: z.string().datetime(),
  })
  .refine((s) => (s.direction === "long" ? s.stop_loss < s.entry_price && s.take_profit_1 > s.entry_price : s.stop_loss > s.entry_price && s.take_profit_1 < s.entry_price), {
    message: "Stop/target on wrong side of entry",
  });

export const BacktestReport = z.object({
  symbol: Symbol,
  strategy_version: z.string(),
  period_start: z.string().datetime(),
  period_end: z.string().datetime(),
  is_synthetic: z.boolean(),
  metrics: z.record(z.unknown()),
  notes: z.string().nullable(),
});

export type SignalOutput = z.infer<typeof SignalOutput>;
