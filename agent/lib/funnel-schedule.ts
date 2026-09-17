import { finnhubFromEnv } from "./data.ts";
import { FUNNEL_CHUNKS, runFunnelChunk, scoreFunnelOutcomes } from "./funnel.ts";
import { jevFromEnv } from "./jev.ts";
import { memoryFromEnv } from "./memory.ts";
import { loadUniverse, universeChunk } from "./universe.ts";

/**
 * One funnel fire: claim the next unclaimed slice of the universe for today, screen it, store it,
 * and score a few old directional shadows while the rate limiter has slack.
 *
 * Four schedules call this. They are spaced fifteen minutes apart from 12:00 UTC so that even with
 * Hobby's hour of jitter every fire lands before the 15:00 UTC cycle. Which chunk a fire takes is
 * decided by Convex, not by which file fired, so order does not matter.
 */
export async function runFunnelSchedule(
  schedule: string,
  deps: { logger?: Pick<Console, "log" | "warn">; now?: () => number } = {},
): Promise<void> {
  const logger = deps.logger ?? console;
  const now = deps.now ?? Date.now;
  const firedAt = now();
  const day = new Date(firedAt).toISOString().slice(0, 10);

  const memory = memoryFromEnv();
  try {
    await memory.recordCronRun({ schedule, firedAt, dispatched: true });
  } catch (err) {
    logger.warn(`[${schedule}] cron heartbeat failed (non-fatal):`, err);
  }

  const jev = jevFromEnv();
  if (!jev) {
    logger.log(`[${schedule}] TYPESAFE_API_KEY not set; funnel skipped`);
    return;
  }

  const claim = await memory.claimFunnelChunk(day, FUNNEL_CHUNKS, firedAt);
  if (!claim) {
    logger.log(`[${schedule}] every chunk for ${day} is already claimed; nothing to do`);
    return;
  }

  const universe = loadUniverse();
  const tickers = universeChunk(universe.tickers, claim.chunk, FUNNEL_CHUNKS);
  const news = finnhubFromEnv();
  logger.log(`[${schedule}] claimed chunk ${claim.chunk}/${FUNNEL_CHUNKS} for ${day}: ${tickers.length} tickers`);

  try {
    const result = await runFunnelChunk(tickers, { news, jev, memory, now, logger });
    await memory.finishFunnelChunk({
      id: claim.id,
      status: "done",
      finishedAt: now(),
      tickers: result.tickers,
      items: result.inserted,
      note: `fetched ${result.fetched}, screened ${result.screened}, skipped ${result.skipped}, failures ${result.failures}`,
    });
    logger.log(`[${schedule}] chunk ${claim.chunk} done: ${JSON.stringify(result)}`);
  } catch (err) {
    logger.warn(`[${schedule}] chunk ${claim.chunk} failed:`, err);
    try {
      await memory.finishFunnelChunk({
        id: claim.id,
        status: "failed",
        finishedAt: now(),
        tickers: tickers.length,
        items: 0,
        note: String(err).slice(0, 200),
      });
    } catch (inner) {
      logger.warn(`[${schedule}] could not record the failure:`, inner);
    }
    return;
  }

  // Outcome scoring for the directional shadow. Best-effort and last, so it can never eat into
  // the screening budget; if the function is short on time this is the part that gets cut.
  try {
    const scored = await scoreFunnelOutcomes({ news, memory, now, logger });
    logger.log(`[${schedule}] outcomes: ${JSON.stringify(scored)}`);
  } catch (err) {
    logger.warn(`[${schedule}] outcome scoring failed (non-fatal):`, err);
  }
}
