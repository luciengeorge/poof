import { defineSchedule } from "eve/schedules";
import { runFunnelSchedule } from "../lib/funnel-schedule.ts";

// One of four fires that together cover the universe before the 15:00 UTC cycle. Which slice
// this fire takes is decided by Convex at claim time, so the letter carries no meaning. Spaced
// from 12:00 UTC so Hobby's up-to-59-minute jitter still lands every fire before the cycle.
export default defineSchedule({
  cron: "15 12 * * 1-5",
  async run() {
    await runFunnelSchedule("funnel-b");
  },
});
