import { defineSchedule } from "eve/schedules";
import { runShadowSchedule } from "../lib/shadow/schedule.ts";

export default defineSchedule({ cron: "2-59/5 * * * *", async run() { await runShadowSchedule("positions"); } });
