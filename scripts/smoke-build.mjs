import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Post-build smoke test. It reads only what `pnpm build` wrote, never the source tree: the funnel
// threw ENOENT on every production fire for 13 days while every source-level check passed, because
// the universe file existed locally and nothing asked whether it survived bundling.
//
// It greps the bundle rather than importing it. The bundle's entry points start the HTTP server and
// register the cron schedules, which call live services, and `loadUniverse` is not exported from the
// chunk it lands in, so there is no side-effect-free way to call into it.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT = join(ROOT, ".output");
const TICKER = '"NVDA"';
// `new URL("./x", import.meta.url)` resolves against the bundle file at runtime. The bundler does not
// copy the file it names, so in production it points at a path that does not exist.
const RELATIVE_FILE_READ = /new URL\(\s*(["'`])\.{1,2}\/[^"'`]+\1\s*,\s*import\.meta\.url\s*\)/g;

function fail(lines) {
  console.error(["[smoke-build] FAIL", ...lines.map((line) => `  - ${line}`)].join("\n"));
  process.exit(1);
}

const manifest = join(OUTPUT, "nitro.json");
if (!existsSync(manifest)) fail([`${relative(ROOT, manifest)} not found. Run \`pnpm build\` first.`]);
const { serverEntry } = JSON.parse(readFileSync(manifest, "utf8"));
if (!existsSync(join(OUTPUT, serverEntry))) fail([`server entry .output/${serverEntry} (from nitro.json) is missing.`]);

const serverDir = join(OUTPUT, dirname(serverEntry));
const files = readdirSync(serverDir, { recursive: true })
  .filter((f) => /\.[cm]?js$/.test(f))
  .map((f) => join(serverDir, f));

const problems = [];
const withTicker = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  if (src.includes(TICKER)) withTicker.push(relative(ROOT, file));
  for (const match of src.matchAll(RELATIVE_FILE_READ)) {
    problems.push(
      `${relative(ROOT, file)} reads a file relative to the bundle at runtime: ${match[0]}. ` +
        "The bundler does not copy that file, so production gets ENOENT. Import the data as a module instead.",
    );
  }
}
if (withTicker.length === 0) {
  problems.unshift(
    `no file under ${relative(ROOT, serverDir)}/ contains the ticker ${TICKER}, so the universe from ` +
      "agent/data/universe.ts is not in the server bundle and the wide funnel has nothing to scan in " +
      "production. Check that agent/lib/universe.ts imports the data as a module and the list still has NVDA.",
  );
}
if (problems.length > 0) fail(problems);

console.log(
  `[smoke-build] ok: ${TICKER} found in ${withTicker.join(", ")}; ` +
    `no runtime reads relative to the bundle across ${files.length} server files`,
);
