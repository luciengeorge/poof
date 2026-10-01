/**
 * Strips secrets out of text bound for a log line or Slack.
 *
 * WHY. poof is a public repo, so its Actions logs are world-readable, and one shared secret
 * gates every function on the public Convex deployment. Every Convex call sends
 * `{ token, ...args }`, and Convex's argument validator prints the whole argument object into
 * its error when a field is missing or extra. That error text has already carried the secret
 * out once and forced a rotation. GitHub masks exact substrings only; Slack masks nothing.
 *
 * Two layers. The literal value of every secret env var this process can hold, read on every
 * call (not at import) so a value set later is still caught. Then a generic `token` field
 * pattern, for a process that is missing the env var, or a token that is not one of ours.
 */

const SECRET_ENV_NAMES = [
  "CONVEX_APP_SECRET",
  "APP_SHARED_SECRET",
  "CONVEX_DEPLOY_KEY",
  "TRADING212_API_KEY",
  "TRADING212_API_SECRET",
  "TRADING212_SECRET_KEY",
  "FINNHUB_API_KEY",
  "EXA_API_KEY",
  "TIINGO_API_KEY",
  "TYPESAFE_API_KEY",
  "SLACK_ALERT_WEBHOOK_URL",
  "ROUTE_AUTH_BASIC_PASSWORD",
];

// An empty value would match between every character and destroy the message, and a short one
// is too likely to be an ordinary word.
const MIN_SECRET_LENGTH = 8;

const MARKER = "[REDACTED]";

// Convex's form first, as it is the one that has leaked: unquoted key, colon, space, quoted
// value (`{token: "..."}`). Then JSON, then a query string. Only the value is replaced.
const TOKEN_FIELDS = [
  /(\btoken:\s*")(?:[^"\\]|\\.)*/g,
  /("token"\s*:\s*")(?:[^"\\]|\\.)*/g,
  /(\btoken=)[^&\s]+/g,
];

export function redact(text: string): string {
  // Longest first, so a secret that contains another is not left half-replaced.
  const values = SECRET_ENV_NAMES.map((name) => process.env[name])
    .filter((value): value is string => value !== undefined && value.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) out = out.replaceAll(value, MARKER);
  for (const pattern of TOKEN_FIELDS) out = out.replace(pattern, `$1${MARKER}`);
  return out;
}
