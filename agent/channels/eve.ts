import { randomUUID } from 'node:crypto';
import { httpBasic, localDev, vercelOidc } from 'eve/channels/auth';
import { eveChannel } from 'eve/channels/eve';

// Fail closed for anonymous traffic. Accepted callers:
// - localDev(): loopback (your `eve dev`)
// - vercelOidc(): tokens scoped to THIS Vercel project (your team + in-deployment callers)
// - httpBasic(): an operator username/password you control, independent of Vercel.
// Password comes from ROUTE_AUTH_BASIC_PASSWORD at boot; the random fallback ensures the
// password is never empty/guessable if the env var is missing (so no accidental open door).
export default eveChannel({
  auth: [
    localDev(),
    vercelOidc(),
    httpBasic({
      username: process.env.ROUTE_AUTH_BASIC_USERNAME ?? 'operator',
      password: process.env.ROUTE_AUTH_BASIC_PASSWORD ?? randomUUID(),
    }),
  ],
});
