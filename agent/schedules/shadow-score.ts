import { defineSchedule } from "eve/schedules";
import { runShadowSchedule } from "../lib/shadow/schedule.ts";

export default defineSchedule({ cron: "9 * * * *", async run() { await runShadowSchedule("score"); } });
