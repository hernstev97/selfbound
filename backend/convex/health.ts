import { query } from './_generated/server';
import { isLocalDeployment, ownerQuery } from './lib/auth';
import { oauthConfig } from './lib/oauth/core';
import { vapidFromEnv } from './ops/notify';

/**
 * Status without data: is the backend running, which sign-in is configured. Also for GET /health.
 * `devAuth`: the local test sign-in is configured AND effective (only on a local deployment).
 * It must be `false` before a production deploy (docs/operations.md).
 * `local`: CONVEX_CLOUD_URL points to 127.0.0.1/localhost.
 * `oauth`: connectors via OAuth enabled (XLR8_APP_URL set).
 * `push`: notifications configured (VAPID keys set).
 */
export function healthStatus() {
  const devJwks = Boolean(process.env.XLR8_DEV_JWKS) && process.env.XLR8_DEV_JWKS !== 'none';
  return {
    ok: true,
    local: isLocalDeployment(),
    devAuth: devJwks && isLocalDeployment(),
    devAuthConfigured: devJwks,
    clerk: Boolean(process.env.CLERK_JWT_ISSUER_DOMAIN) && process.env.CLERK_JWT_ISSUER_DOMAIN !== 'none',
    testSwitches: process.env.XLR8_TEST_SWITCHES === '1',
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
