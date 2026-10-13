// Settings of one deployed XLR8 instance (yours), used by the deploy and production tools:
// tooling/deploy-web.mjs, tooling/cloud.mjs, tooling/linear-import (push to production).
//
// Read from deploy/instance.json (gitignored; copy deploy/instance.example.json), or, if that file is
// missing, from ~/.config/xlr8/instance.json (handy with many worktrees). Each value can be overridden
// by an environment variable. Nothing here is secret: these values end up in the
// browser or in public DNS anyway. Secrets (deploy keys, tokens) never go into this file.
//
//   field                 env override                 example
//   convexDeployment      XLR8_CONVEX_DEPLOYMENT       happy-otter-123 (production deployment name)
//   appUrl                XLR8_APP_URL                 https://xlr8.example.com
//   clerkPublishableKey   XLR8_CLERK_PUBLISHABLE_KEY   pk_live_… (or "host=pk_live_…,host2=pk_live_…")
//   vercelProject         XLR8_VERCEL_PROJECT          xlr8
//   vercelScope           XLR8_VERCEL_SCOPE            your Vercel team slug
//   mcpHosts              XLR8_MCP_HOSTS               mcp.xlr8.example.com (comma-separated)
//   redirectHosts         XLR8_REDIRECT_HOSTS          old-domain.example (comma-separated, redirected to appUrl)
//   branchPrefix          VITE_XLR8_BRANCH_PREFIX      your GitHub login (prefix of suggested branch names; optional)
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOCAL_FILE = join(import.meta.dirname, '..', 'deploy', 'instance.json');
const USER_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'xlr8', 'instance.json');
export const INSTANCE_FILE = existsSync(LOCAL_FILE) || !existsSync(USER_FILE) ? LOCAL_FILE : USER_FILE;

const list = (value) => (Array.isArray(value) ? value : String(value ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);

/** @returns {{ convexDeployment?: string, appUrl?: string, clerkPublishableKey?: string, vercelProject?: string, vercelScope?: string, branchPrefix?: string, mcpHosts: string[], redirectHosts: string[] }} */
export function loadInstance(env = process.env, file = INSTANCE_FILE) {
  const json = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const pick = (name, key) => env[name] || json[key] || undefined;
  return {
    convexDeployment: pick('XLR8_CONVEX_DEPLOYMENT', 'convexDeployment'),
    appUrl: pick('XLR8_APP_URL', 'appUrl')?.replace(/\/$/, ''),
    clerkPublishableKey: pick('XLR8_CLERK_PUBLISHABLE_KEY', 'clerkPublishableKey'),
    vercelProject: pick('XLR8_VERCEL_PROJECT', 'vercelProject'),
    vercelScope: pick('XLR8_VERCEL_SCOPE', 'vercelScope'),
    branchPrefix: pick('VITE_XLR8_BRANCH_PREFIX', 'branchPrefix'),
    mcpHosts: list(env.XLR8_MCP_HOSTS ?? json.mcpHosts),
    redirectHosts: list(env.XLR8_REDIRECT_HOSTS ?? json.redirectHosts),
  };
}

/** Like loadInstance(), but exits with a clear message if one of the given fields is missing. */
export function requireInstance(fields, env = process.env) {
  const instance = loadInstance(env);
  const missing = fields.filter((f) => !instance[f] || (Array.isArray(instance[f]) && !instance[f].length));
  if (missing.length) {
    console.error(`Missing instance settings: ${missing.join(', ')}. Set them in deploy/instance.json (see deploy/instance.example.json) or as XLR8_* environment variables.`);
    process.exit(2);
  }
  return instance;
}
