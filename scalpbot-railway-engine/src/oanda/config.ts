import { z } from "zod";

export const OANDA_HOSTS = {
  practice: { rest: "https://api-fxpractice.oanda.com", stream: "https://stream-fxpractice.oanda.com" },
} as const;

export const INSTRUMENTS = ["XAU_USD", "EUR_USD"] as const;

const schema = z.object({
  OANDA_TOKEN: z.string().min(20),
  OANDA_ACCOUNT_ID: z.string().regex(/^\d{3}-\d{3}-\d+-\d{3}$/, "Expected OANDA account id like 101-004-1234567-001"),
  OANDA_ENV: z.literal("practice"),
  CANDLE_FETCH_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(3_000),
  DRY_RUN: z.enum(["true", "false"]).default("true"),
});
export type OandaConfig = z.infer<typeof schema> & { rest: string; stream: string };

/** Reads secrets from env only. Refuses anything other than the practice environment. */
export function loadOandaConfig(env: Record<string, string | undefined>): OandaConfig {
  const c = schema.parse(env);
  return { ...c, ...OANDA_HOSTS.practice };
}

export const streamPath = (accountId: string) => `/v3/accounts/${encodeURIComponent(accountId)}/pricing/stream?instruments=${INSTRUMENTS.join(",")}`;
export const candlesPath = (instrument: string, granularity: "M1" | "M5" | "M15", count: number) =>
  `/v3/instruments/${instrument}/candles?granularity=${granularity}&price=MBA&count=${Math.min(5000, Math.max(1, count))}`;
