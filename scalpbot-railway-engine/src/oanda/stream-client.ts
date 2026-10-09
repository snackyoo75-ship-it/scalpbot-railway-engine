import { LineSplitter, parseStreamLine, type StreamMsg } from "./parse.js";
import { backoffDelay } from "./pipeline.js";
import { streamPath, type OandaConfig } from "./config.js";

/**
 * Runs the OANDA pricing stream forever with exponential backoff + jitter.
 * A watchdog aborts the connection if no usable PRICE arrives for `degradeAfterMs` (heartbeats do not count).
 * Not exercised against OANDA in automated tests — see stream-client tests for the fake-fetch harness.
 */
export async function runPricingStream(
  cfg: OandaConfig,
  onMsg: (m: StreamMsg) => void,
  onState: (s: { state: "connecting" | "open" | "degraded" | "disconnected"; error?: string }) => void,
  opts: { fetchImpl?: typeof fetch; degradeAfterMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void>; maxAttempts?: number } = {},
): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const degradeAfter = opts.degradeAfterMs ?? 20_000;
  let attempt = 0; // backoff exponent, reset after a usable tick
  let connections = 0;

  while (!opts.signal?.aborted && connections++ < (opts.maxAttempts ?? Infinity)) {
    const ctrl = new AbortController();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        onState({ state: "degraded", error: "no usable tick" });
        ctrl.abort();
      }, degradeAfter);
    };
    try {
      onState({ state: "connecting" });
      const res = await f(cfg.stream + streamPath(cfg.OANDA_ACCOUNT_ID), { headers: { Authorization: `Bearer ${cfg.OANDA_TOKEN}` }, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      onState({ state: "open" });
      arm();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const split = new LineSplitter();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        for (const line of split.push(dec.decode(value, { stream: true }))) {
          const m = parseStreamLine(line);
          if (m.kind === "price" && m.tradeable) {
            attempt = 0;
            arm();
          }
          onMsg(m);
        }
      }
    } catch (e) {
      onState({ state: "disconnected", error: e instanceof Error ? e.message : "unknown" });
    } finally {
      clearTimeout(watchdog);
    }
    await sleep(backoffDelay(attempt++));
  }
}
