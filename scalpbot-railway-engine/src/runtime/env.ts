import { z } from "zod";
import { loadOandaConfig, type OandaConfig } from "../oanda/config.js";
import type { BrokerCosts } from "./analysis.js";

const optNum = (min: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min) {
        ctx.addIssue({ code: "custom", message: `must be a number >= ${min}` });
        return z.NEVER;
      }
      return n;
    });

const blackout = z.object({ start: z.string().datetime(), end: z.string().datetime(), reason: z.string().min(1) }).strict();

const schema = z.object({
  APP_URL: z.string().url(),
  WORKER_SECRET: z.string().min(32, "WORKER_SECRET must be at least 32 characters"),
  WORKER_ID: z.string().regex(/^[a-z0-9_-]{2,64}$/).default("quant-engine"),
  BROKER_COMMISSION_PER_SIDE: optNum(0),
  BROKER_POSITION_UNITS: optNum(Number.MIN_VALUE),
  BROKER_ACCOUNT_TO_QUOTE: optNum(Number.MIN_VALUE),
  BROKER_SLIPPAGE_PER_SIDE: optNum(0),
  NEWS_BLACKOUTS_JSON: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v || !v.trim()) return [];
      try {
        const r = z.array(blackout).safeParse(JSON.parse(v));
        if (r.success) return r.data;
        ctx.addIssue({ code: "custom", message: "NEWS_BLACKOUTS_JSON must be [{start,end,reason}] with ISO UTC times" });
      } catch {
        ctx.addIssue({ code: "custom", message: "NEWS_BLACKOUTS_JSON is not valid JSON" });
      }
      return z.NEVER;
    }),
});

export type EngineEnv = {
  appUrl: string;
  workerSecret: string;
  workerId: string;
  oanda: OandaConfig;
  /** Local brake: when true the engine analyses and reports but never submits signals. */
  dryRun: boolean;
  costs: BrokerCosts;
  manualBlackouts: { start: string; end: string; reason: string }[];
};

/** Validates every setting up front; throws with a readable list instead of starting half-configured. */
export function loadEngineEnv(env: Record<string, string | undefined>): EngineEnv {
  const errors: string[] = [];
  const r = schema.safeParse(env);
  if (!r.success) errors.push(...r.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  let oanda: OandaConfig | null = null;
  try {
    oanda = loadOandaConfig(env);
  } catch (e) {
    if (e instanceof z.ZodError) errors.push(...e.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
    else errors.push(String(e));
  }
  if (errors.length || !r.success || !oanda) throw new Error(`invalid configuration:\n  - ${errors.join("\n  - ")}`);
  const d = r.data;
  return {
    appUrl: d.APP_URL,
    workerSecret: d.WORKER_SECRET,
    workerId: d.WORKER_ID,
    oanda,
    dryRun: oanda.DRY_RUN === "true",
    costs: { commissionPerSide: d.BROKER_COMMISSION_PER_SIDE, units: d.BROKER_POSITION_UNITS, accountToQuote: d.BROKER_ACCOUNT_TO_QUOTE, slippagePerSide: d.BROKER_SLIPPAGE_PER_SIDE },
    manualBlackouts: d.NEWS_BLACKOUTS_JSON,
  };
}
