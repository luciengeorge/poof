import type { FxResolution } from "./fx.ts";
import type { CycleRecord } from "./memory.ts";

/** Attach the resolved FX evidence to the durable cycle record. */
export function cycleRecordWithFx(
  args: Omit<CycleRecord, "fxRate" | "fxSource"> & { fx: FxResolution },
): CycleRecord {
  const { fx, ...record } = args;
  return { ...record, fxRate: fx.rate, fxSource: fx.source };
}
