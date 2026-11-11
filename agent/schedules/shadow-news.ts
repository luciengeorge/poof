import { defineSchedule } from "eve/schedules";
import { runShadowSchedule } from "../lib/shadow/schedule.ts";

export default defineSchedule({ cron: "*/15 * * * *", async run() { await runShadowSchedule("news"); } });
