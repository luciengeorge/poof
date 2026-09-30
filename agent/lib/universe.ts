import { UNIVERSE } from "../data/universe.ts";

/**
 * The tradable universe the wide funnel scans.
 *
 * A committed file, not a live index lookup. Constituent lists move a few names a quarter, and a
 * scan that silently changed its own universe would make day-to-day funnel counts incomparable.
 * Someone edits `agent/data/universe.ts` deliberately, with the date, when the list should move.
 *
 * It is imported rather than read from disk because the deploy bundler traces imports and collapses
 * the app into one file: a runtime read of a sibling JSON resolved to a path production never had.
 */
export interface Universe {
  asOf: string;
  note?: string;
  tickers: string[];
}

export function loadUniverse(): Universe {
  const raw = UNIVERSE as Partial<Universe>;
  if (!Array.isArray(raw.tickers) || raw.tickers.length === 0 || typeof raw.asOf !== "string") {
    throw new Error("agent/data/universe.ts is malformed");
  }
  const seen = new Set<string>();
  const tickers = raw.tickers.filter((t) => {
    if (typeof t !== "string" || !/^[A-Z][A-Z0-9.-]{0,6}$/u.test(t) || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  return { asOf: raw.asOf, note: raw.note, tickers };
}

/**
 * Deterministic slice of the universe for one chunk.
 *
 * Striped by index rather than cut into contiguous ranges, so every chunk is a representative mix
 * of the alphabet and no single failure loses, say, every ticker from S to Z for the day.
 */
export function universeChunk(tickers: readonly string[], chunk: number, chunks: number): string[] {
  if (!Number.isInteger(chunks) || chunks < 1) throw new Error("chunks must be a positive integer");
  if (!Number.isInteger(chunk) || chunk < 0 || chunk >= chunks) throw new Error("chunk out of range");
  return tickers.filter((_t, i) => i % chunks === chunk);
}
