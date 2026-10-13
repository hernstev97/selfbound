import { ConvexError } from 'convex/values';
import { customAction, customCtx, customMutation, customQuery } from 'convex-helpers/server/customFunctions';
import { action, mutation, query, type QueryCtx } from '../_generated/server';
import { DEV_ISSUER } from '../auth.config';
import { OWNER_KIND } from '../shared/constants';
import type { Actor } from './actor';
import { assertWritable } from './testSwitches';

/** The instance owner, the only signed-in user. Stored as actor kind OWNER_KIND ('steven', legacy value). */
export const OWNER_ACTOR: Actor = { kind: OWNER_KIND };

/**
 * Checks that the signed-in identity is the owner.
 *
 * Convex has already verified the token's signature, expiry, issuer and audience.
 * This adds the allowlist: XLR8_OWNER_IDS holds the allowed `tokenIdentifier`s
 * ("<issuer>|<subject>"), comma-separated.
 */
export async function requireOwner(ctx: Pick<QueryCtx, 'auth'>): Promise<Actor> {
  const identity = await ctx.auth.getUserIdentity();
  const allowed = (process.env.XLR8_OWNER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!identity || allowed.length === 0 || !allowed.includes(identity.tokenIdentifier)) {
    throw new ConvexError({ code: 'access_denied', message: 'Not signed in or not allowed.' });
  }
  // The local test sign-in only works on a local deployment. If XLR8_DEV_JWKS is set in
  // production by mistake, these tokens still get nobody in.
  if (identity.issuer === DEV_ISSUER && !isLocalDeployment()) {
    throw new ConvexError({ code: 'access_denied', message: 'The local test sign-in only works on a local backend.' });
  }
  return OWNER_ACTOR;
}

/**
 * Is this function running on a local deployment? Convex sets CONVEX_CLOUD_URL in every
 * function (locally e.g. http://127.0.0.1:3210). If the variable is missing: no (the safe case).
 */
export function isLocalDeployment(url = process.env.CONVEX_CLOUD_URL): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}

// Public functions exist only through these wrappers. A test calls every exported
// public function without sign-in and expects a rejection.
export const ownerQuery = customQuery(
  query,
  customCtx(async (ctx) => ({ actor: await requireOwner(ctx) })),
);
export const ownerMutation = customMutation(
  mutation,
  customCtx(async (ctx) => ({ actor: await requireOwner(ctx) })),
);
/**
 * Like ownerMutation, then also checks the "reject writes" test switch
 * (only active with XLR8_TEST_SWITCHES=1). Used for all UI writes.
 */
export const ownerWriteMutation = customMutation(
  mutation,
  customCtx(async (ctx) => {
    const actor = await requireOwner(ctx);
    await assertWritable(ctx);
    return { actor };
  }),
);
export const ownerAction = customAction(
  action,
  customCtx(async (ctx) => ({ actor: await requireOwner(ctx) })),
);
