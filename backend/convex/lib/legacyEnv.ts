// legacy-xlr8: environment variables: SELFBOUND_<NAME> wins, XLR8_<NAME> (the old name) is still read as a fallback.
// Fallbacks are temporary: a follow-up removes them once the instance has migrated.
// Pass the name without prefix: envVar('OWNER_IDS').

const warned = new Set<string>();

type Env = Record<string, string | undefined>;

export function envVar(name: string, env: Env = process.env): string | undefined {
  const current = env[`SELFBOUND_${name}`];
  if (current !== undefined) return current;
  // legacy-xlr8: old variable name, read until the follow-up removes the fallback
  const legacy = env[`XLR8_${name}`];
  if (legacy !== undefined && !warned.has(name)) {
    warned.add(name);
    // Never log the value. legacy-xlr8
    console.warn(`XLR8_${name} is deprecated, set SELFBOUND_${name} instead.`);
  }
  return legacy;
}

/** For tests: forget which warnings were already printed. */
export function resetLegacyEnvWarnings() {
  warned.clear();
}
