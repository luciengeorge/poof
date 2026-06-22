import { T212Client, type T212Env } from "./t212.ts";

const apiKey = process.env.TRADING212_API_KEY;
const apiSecret = process.env.TRADING212_API_SECRET;
const env = (process.env.TRADING212_ENV ?? "demo") as T212Env;

if (!apiKey || !apiSecret) {
  console.error("skip: set TRADING212_API_KEY and TRADING212_API_SECRET in .env.local.");
  process.exit(2);
}
// Read-only smoke: live is safe here (no orders are placed).
if (env === "live") console.warn("note: smoke-testing against LIVE (read-only — no orders).");

const client = new T212Client({ apiKey, apiSecret, env });

try {
  const cash = await client.getCash();
  const positions = await client.getPortfolio();
  console.log("✅ auth OK. cash.free =", cash.free, "| positions:", positions.length);
  console.log("rate limit:", client.lastRateLimit());
} catch (err) {
  console.error("❌ smoke-test failed:", err);
  console.error(
    "If this is a 401, auth may be single-key instead of Basic key:secret — " +
      "change buildAuthHeader in t212.ts to return the bare key and re-run.",
  );
  process.exit(1);
}
