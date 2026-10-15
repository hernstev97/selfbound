import type { AuthConfig } from 'convex/server';
import { envVar } from './lib/legacyEnv';

// Providers whose tokens Convex verifies (signature, expiry, issuer, audience).
// Which identity actually gets in is decided by `lib/auth.ts` through the SELFBOUND_OWNER_IDS
// allowlist. Without environment variables there is no provider, and therefore no access.
// Never fall back to an unverified token.
//
// - Clerk (production): CLERK_JWT_ISSUER_DOMAIN, one URL or several separated by commas.
//   Several only while moving the Clerk domain, so both URLs are accepted.
// - Local test provider (local only, never in production): SELFBOUND_DEV_JWKS as a data: URI with
//   the public key from `tooling/dev-auth.mjs`.

// Both variables must be set (the CLI requires it); the value "none" turns the provider off.
// Locally: CLERK_JWT_ISSUER_DOMAIN=none. Production: SELFBOUND_DEV_JWKS=none.
const enabled = (value: string | undefined) => (value && value !== 'none' ? value : undefined);
const clerkIssuers = (enabled(process.env.CLERK_JWT_ISSUER_DOMAIN) ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const devJwks = enabled(envVar('DEV_JWKS'));

export const DEV_ISSUER = 'https://dev.selfbound.local';

export default {
  providers: [
    ...clerkIssuers.map((domain) => ({ domain, applicationID: 'convex' })),
    ...(devJwks
      ? [
          {
            type: 'customJwt' as const,
            applicationID: 'selfbound-dev',
            issuer: DEV_ISSUER,
            jwks: devJwks,
            algorithm: 'RS256' as const,
          },
        ]
      : []),
  ],
} satisfies AuthConfig;
