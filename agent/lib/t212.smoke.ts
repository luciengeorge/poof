import { t212FromEnv } from "./t212.ts";

const hasSecret =
  process.env.TRADING212_API_SECRET || process.env.TRADING212_SECRET_KEY;
if (!process.env.TRADING212_API_KEY || !hasSecret) {
  console.error(
    "skip: set TRADING212_API_KEY and TRADING212_API_SECRET (or TRADING212_SECRET_KEY) in .env.local.",
  );
  process.exit(2);
}

const env = process.env.TRADING212_ENV ?? "demo";
if (env === "live") {
  console.warn("note: smoke-testing against LIVE (read-only — no orders).");
}

const client = t212FromEnv();

try {
  const cash = await client.getCash();
  const positions = await client.getPortfolio();
  console.log(
    "✅ auth OK. cash.free =",
    cash.free,
    "| positions:",
    positions.length,
  );
  console.log("rate limit:", client.lastRateLimit());
} catch (err) {
  console.error("❌ smoke-test failed:", err);
  console.error(
    "If this is a 401, auth may be single-key instead of Basic key:secret — " +
      "change buildAuthHeader in t212.ts to return the bare key and re-run.",
  );
  process.exit(1);
}
