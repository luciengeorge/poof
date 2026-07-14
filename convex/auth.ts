// Shared-secret gate for every public function in convex/memory.ts. The agent talks to
// Convex over ConvexHttpClient, which can only call public functions, so we can't lock
// these down by converting them to internalMutation/internalQuery. Instead every call
// must carry a token that matches APP_SHARED_SECRET (set as a Convex env var).
export function assertSecret(token: string | undefined): void {
  const secret = process.env.APP_SHARED_SECRET;
  if (!secret || token !== secret) {
    throw new Error("Unauthenticated");
  }
}
