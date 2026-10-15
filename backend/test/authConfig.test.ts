// Providers in auth.config.ts: while the Clerk domain changes, two issuers are valid.
import { afterEach, describe, expect, test, vi } from 'vitest';

async function providers(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import('../convex/auth.config')).default.providers;
}

afterEach(() => vi.unstubAllEnvs());

describe('auth.config', () => {
  test('one Clerk issuer', async () => {
    expect(await providers({ CLERK_JWT_ISSUER_DOMAIN: 'https://clerk.selfbound.example.com', SELFBOUND_DEV_JWKS: 'none' })).toEqual([
      { domain: 'https://clerk.selfbound.example.com', applicationID: 'convex' },
    ]);
  });
  test('several Clerk issuers separated by commas', async () => {
    expect(
      await providers({ CLERK_JWT_ISSUER_DOMAIN: 'https://clerk.selfbound.example.com, https://clerk.example.org', SELFBOUND_DEV_JWKS: 'none' }),
    ).toEqual([
      { domain: 'https://clerk.selfbound.example.com', applicationID: 'convex' },
      { domain: 'https://clerk.example.org', applicationID: 'convex' },
    ]);
  });
  test('none disables Clerk', async () => {
    expect(await providers({ CLERK_JWT_ISSUER_DOMAIN: 'none', SELFBOUND_DEV_JWKS: 'none' })).toEqual([]);
  });
});
