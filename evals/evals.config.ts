import { defineEvalConfig } from "eve/evals";

// Behavioral evals are fully deterministic (no `t.judge.*`), so no judge model is needed.
// Run serially: each eval drives a real agent turn against the rate-limited demo APIs
// (T212 ~1 req/5s), so concurrent runs would contend and flake. A full trading-cycle turn
// (Opus + subagents + several API calls) is slow, hence the generous per-eval timeout.
export default defineEvalConfig({
  maxConcurrency: 1,
  timeoutMs: 240_000,
});
