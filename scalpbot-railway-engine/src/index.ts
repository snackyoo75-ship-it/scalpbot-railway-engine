/**
 * ScalpBot engine entry point (Railway). Validates configuration, then runs the practice-mode worker:
 * OANDA practice prices → candles → strategies/gates → dashboard worker API. Never places orders.
 */
import { AppClient } from "./runtime/app-client.js";
import { Engine } from "./runtime/engine.js";
import { loadEngineEnv } from "./runtime/env.js";

async function main() {
  let env;
  try {
    env = loadEngineEnv(process.env);
  } catch (e) {
    console.error(`scalpbot-engine: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const app = new AppClient(env.appUrl, env.workerSecret);
  const probe = await app.call("GET", "health");
  if (probe.status !== 200) {
    console.error(`scalpbot-engine: dashboard API not reachable at ${env.appUrl} (status ${probe.status}${probe.error ? `, ${probe.error}` : ""})`);
    process.exit(1);
  }

  const engine = new Engine({ oanda: env.oanda, app, workerId: env.workerId, dryRun: env.dryRun, costs: env.costs, manualBlackouts: env.manualBlackouts });
  const shutdown = async (sig: string) => {
    console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", msg: `received ${sig}` }));
    await engine.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "unhandledRejection", error: String(e) })));

  await engine.start();
}

void main();
