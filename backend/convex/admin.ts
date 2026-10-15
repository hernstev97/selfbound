import { v } from 'convex/values';
import { ownerMutation } from './lib/auth';
import { setRejectWrites as setSwitch } from './lib/testSwitches';

/** Test switch "server rejects writes". Only with SELFBOUND_TEST_SWITCHES=1, otherwise access_denied. */
export const setRejectWrites = ownerMutation({
  args: { value: v.boolean() },
  handler: async (ctx, args) => await setSwitch(ctx, args.value),
});
