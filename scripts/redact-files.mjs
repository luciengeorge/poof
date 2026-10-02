import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { redact } from "../agent/lib/redact.ts";

// Rewrites each file named on the command line, in place, through redact(), before the evals
// workflow uploads it. The repo is public and GitHub masks secrets in the job log but never
// inside an uploaded file. Run it in the job that holds the secrets, so redact()'s exact-value
// layer sees their values.
//
// A missing file is skipped: an eval run that dies early writes no summary, and that must not stop
// the other files being redacted. Any other failure throws, the step fails, and the upload that
// depends on it does not run, so an unredacted file is never uploaded. Logs name files only.
for (const path of process.argv.slice(2)) {
  if (!existsSync(path)) {
    console.log(`[redact-files] ${path}: not found, skipped`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  const clean = redact(text);
  if (clean !== text) writeFileSync(path, clean);
  console.log(`[redact-files] ${path}: ${clean === text ? "nothing to redact" : "redacted"}`);
}
