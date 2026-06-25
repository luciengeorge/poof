import { exaFromEnv } from "./exa.ts";

if (!process.env.EXA_API_KEY) {
  console.error("skip: set EXA_API_KEY in .env.local.");
  process.exit(2);
}

const exa = exaFromEnv();

try {
  const results = await exa.search("US stock market today", {
    numResults: 3,
    category: "news",
    text: { maxCharacters: 200 },
    summary: true,
  });
  console.log("✅ Exa OK. results:", results.length);
  for (const r of results) console.log(" -", (r.title || "").slice(0, 80));
} catch (err) {
  console.error("❌ Exa smoke-test failed:", err);
  process.exit(1);
}
