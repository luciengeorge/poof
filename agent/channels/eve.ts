import { localDev, vercelOidc } from 'eve/channels/auth';
import { eveChannel } from 'eve/channels/eve';

// Phase 1 has no browser UI — the agent runs via the cycle schedule and the Slack
// channel. So we fail closed for anonymous browser traffic (no placeholderAuth) and
// allow only loopback dev + Vercel OIDC (the eve TUI and in-deployment callers).
export default eveChannel({
  auth: [localDev(), vercelOidc()],
});
