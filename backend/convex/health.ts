import { query } from './_generated/server';
import { isLocalDeployment, ownerQuery } from './lib/auth';
import { oauthConfig } from './lib/oauth/core';
import { vapidFromEnv } from './ops/notify';
import { envVar } from './lib/legacyEnv';

/**
 * Status without data: is the backend running, which sign-in is configured. Also for GET /health.
 * `devAuth`: the local test sign-in is configured AND effective (only on a local deployment).
 * It must be `false` before a production deploy (docs/operations.md).
 * `local`: CONVEX_CLOUD_URL points to 127.0.0.1/localhost.
 * `oauth`: connectors via OAuth enabled (SELFBOUND_APP_URL set).
 * `push`: notifications configured (VAPID keys set).
 */
export function healthStatus() {
  const devJwks = Boolean(envVar('DEV_JWKS')) && envVar('DEV_JWKS') !== 'none';
  return {
    ok: true,
    local: isLocalDeployment(),
    devAuth: devJwks && isLocalDeployment(),
    devAuthConfigured: devJwks,
    clerk: Boolean(process.env.CLERK_JWT_ISSUER_DOMAIN) && process.env.CLERK_JWT_ISSUER_DOMAIN !== 'none',
    testSwitches: envVar('TEST_SWITCHES') === '1',
    oauth: oauthConfig() !== null,
    push: vapidFromEnv() !== null,
  };
}

/** Publicly readable, no data: shows whether the backend is running and how it is configured. */
export const status = query({
  args: {},
  handler: async () => healthStatus(),
});

/** Checks the sign-in: returns the actor, otherwise an error. */
export const whoami = ownerQuery({
  args: {},
  handler: async (ctx) => ctx.actor,
});
