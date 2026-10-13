// First: the UI language, so the App below starts with the right dictionary.
import './lib/locale-ready.ts';
import { App, Auth } from '@xlr8/core';
import { ConvexClient } from 'convex/browser';
import { publishableKey } from './publishableKey.ts';

// One app instance per page. Measurement and test hooks (globalThis.__xlr8, test switches in the
// command menu) only in development, with ?perf=1 or in the test build (VITE_XLR8_TEST=1).
const url = new URL(location.href);
const perf = url.searchParams.get('perf') === '1';
const debug = import.meta.env.DEV || perf || import.meta.env.VITE_XLR8_TEST === '1';

export const convexUrl: string | undefined = import.meta.env.VITE_CONVEX_URL;

// Test build only: simulate Clerk sign-in (e2e/tests/offline.spec.ts). The key points to a Clerk
// address that does not exist, so startup without network can be tested. In the real build
// VITE_XLR8_TEST is not set and the branch is dropped.
const testClerk = import.meta.env.VITE_XLR8_TEST === '1' ? globalThis.localStorage?.getItem('xlr8:testClerk') || undefined : undefined;

export const auth = new Auth({
  devToken: testClerk ? undefined : import.meta.env.VITE_DEV_TOKEN || undefined,
  clerkPublishableKey: testClerk ?? publishableKey,
  loadClerk: () => import('@clerk/clerk-js/no-rhc') as Promise<{ Clerk: new (key: string) => unknown }>,
});

export const client = new ConvexClient(convexUrl ?? 'http://127.0.0.1:1', { skipConvexDeploymentUrlCheck: true });

// Prefix of suggested branch names (e.g. your GitHub login), set at build time; none by default.
const branchPrefix: string | undefined = import.meta.env.VITE_XLR8_BRANCH_PREFIX || undefined;

export const app = new App({ client, auth, debug, perf, branchPrefix, cacheName: `xlr8:${convexUrl ?? 'none'}` });
