import { memoryFromEnv } from "../agent/lib/memory.ts";
import { shadowReport } from "../agent/lib/shadow/report.ts";

const day = process.argv[2];
const env = process.env.TRADING212_ENV;
if (!day || !/^202[67]-\d{2}-\d{2}$/.test(day) || (env !== "demo" && env !== "live")) {
  throw new Error("Usage: TRADING212_ENV=demo|live node --experimental-strip-types scripts/shadow-report.ts YYYY-MM-DD");
}
const data = await memoryFromEnv(undefined, { timeoutMs: 4_000 }).shadowStore().report(env, day);
console.log(JSON.stringify(shadowReport(day, data.events, data.runs, Date.now(), data.truncated), null, 2));
