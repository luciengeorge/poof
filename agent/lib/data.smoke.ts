import { finnhubFromEnv } from "./data.ts";

if (!process.env.FINNHUB_API_KEY) {
  console.error("skip: set FINNHUB_API_KEY in .env.local.");
  process.exit(2);
}

const finnhub = finnhubFromEnv();

try {
  const quote = await finnhub.getQuote("AAPL");
  const news = await finnhub.getMarketNews();
  console.log(
    "✅ Finnhub OK. AAPL price =",
    quote.price,
    "| market news items:",
    news.length,
  );
} catch (err) {
  console.error("❌ Finnhub smoke-test failed:", err);
  process.exit(1);
}
