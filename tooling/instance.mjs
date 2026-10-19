// Settings of one deployed Selfbound instance (yours), used by the deploy and production tools:
// tooling/deploy-web.mjs, tooling/cloud.mjs, tooling/linear-import (push to production).
//
// Read from deploy/instance.json (gitignored; copy deploy/instance.example.json), or, if that file is
// missing, from ~/.config/selfbound/instance.json (handy with many worktrees). Each value can be
// overridden by an environment variable. Nothing here is secret: these values end up in the
// browser or in public DNS anyway. Secrets (deploy keys, tokens) never go into this file.
//
//   field                 env override                   example
//   convexDeployment      SELFBOUND_CONVEX_DEPLOYMENT    happy-otter-123 (production deployment name)
//   appUrl                SELFBOUND_APP_URL              https://selfbound.example.com
//   clerkPublishableKey   SELFBOUND_CLERK_PUBLISHABLE_KEY pk_live_… (or "host=pk_live_…,host2=pk_live_…")
//   vercelProject         SELFBOUND_VERCEL_PROJECT       selfbound
//   vercelScope           SELFBOUND_VERCEL_SCOPE         your Vercel team slug
//   mcpHosts              SELFBOUND_MCP_HOSTS            mcp.selfbound.example.com (comma-separated)
//   redirectHosts         SELFBOUND_REDIRECT_HOSTS       old-domain.example (comma-separated, redirected to appUrl)
//   branchPrefix          VITE_SELFBOUND_BRANCH_PREFIX   your GitHub login (prefix of suggested branch names; optional)
//   siteUrl               SELFBOUND_SITE_URL             https://example.com (public landing page, site/; optional)
//   siteVercelProject     SELFBOUND_SITE_VERCEL_PROJECT  selfbound-landing (Vercel project of the landing page; optional)
//   sourceUrl             SELFBOUND_SOURCE_URL           https://github.com/you/selfbound (source link in the app, AGPL-3.0 § 13; optional,
//                                                        default: the upstream repository; set it when you run a changed version)
//
// legacy-xlr8: the old XLR8_* names (VITE_XLR8_BRANCH_PREFIX) and ~/.config/xlr8/ still work, with a warning.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configFile, envVar, envVarPair } from './lib/env.mjs';

const LOCAL_FILE = join(import.meta.dirname, '..', 'deploy', 'instance.json');

/** deploy/instance.json if it exists, else the user's file, else (nothing exists) the local path. */
export function instanceFile(exists = existsSync, userFile = () => configFile('instance.json')) {
  if (exists(LOCAL_FILE)) return LOCAL_FILE;
  const user = userFile();
  return exists(user) ? user : LOCAL_FILE;
}

const list = (value) => (Array.isArray(value) ? value : String(value ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);

/** @returns {{ convexDeployment?: string, appUrl?: string, clerkPublishableKey?: string, vercelProject?: string, vercelScope?: string, branchPrefix?: string, siteUrl?: string, siteVercelProject?: string, sourceUrl?: string, mcpHosts: string[], redirectHosts: string[] }} */
export function loadInstance(env = process.env, file = instanceFile()) {
  const json = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const pick = (name, key) => envVar(name, env) || json[key] || undefined;
  return {
    convexDeployment: pick('CONVEX_DEPLOYMENT', 'convexDeployment'),
    appUrl: pick('APP_URL', 'appUrl')?.replace(/\/$/, ''),
    clerkPublishableKey: pick('CLERK_PUBLISHABLE_KEY', 'clerkPublishableKey'),
    vercelProject: pick('VERCEL_PROJECT', 'vercelProject'),
    vercelScope: pick('VERCEL_SCOPE', 'vercelScope'),
    // legacy-xlr8: old build variable name, read until the follow-up removes the fallback
    branchPrefix: envVarPair('VITE_SELFBOUND_BRANCH_PREFIX', 'VITE_XLR8_BRANCH_PREFIX', env) || json.branchPrefix || undefined,
    siteUrl: pick('SITE_URL', 'siteUrl')?.replace(/\/$/, ''),
    siteVercelProject: pick('SITE_VERCEL_PROJECT', 'siteVercelProject'),
    sourceUrl: env.SELFBOUND_SOURCE_URL || json.sourceUrl || undefined,
    mcpHosts: list(envVar('MCP_HOSTS', env) ?? json.mcpHosts),
    redirectHosts: list(envVar('REDIRECT_HOSTS', env) ?? json.redirectHosts),
  };
}

/** Like loadInstance(), but exits with a clear message if one of the given fields is missing. */
export function requireInstance(fields, env = process.env) {
  const instance = loadInstance(env);
  const missing = fields.filter((f) => !instance[f] || (Array.isArray(instance[f]) && !instance[f].length));
  if (missing.length) {
    console.error(`Missing instance settings: ${missing.join(', ')}. Set them in deploy/instance.json (see deploy/instance.example.json) or as SELFBOUND_* environment variables.`);
    process.exit(2);
  }
  return instance;
}
