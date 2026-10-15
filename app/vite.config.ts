import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { aliasViteVar, buildVar, preloadFont, publicUrl, pwaFiles, signedOutGuard, welcomeRoutes } from './vite.plugins.ts';

// SPA: the dev and preview servers serve index.html for deep links (/issue/ACME-106,
// /team/ACME/backlog …) (appType 'spa'). The start page (welcome.html) is built separately by
// vite.welcome.config.ts so app and start page share no chunks; dev and preview still serve it.
export default defineConfig(({ mode }) => {
  // SELFBOUND_PUBLIC_URL is read at build time only (vite.plugins.ts publicUrl); it never reaches the client.
  // legacy-xlr8: the old XLR8_PUBLIC_URL is read too (loaded here, used through buildVar).
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), ['VITE_', 'SELFBOUND_PUBLIC_URL', 'XLR8_PUBLIC_URL']);
  for (const name of ['TEST', 'BRANCH_PREFIX']) aliasViteVar(name, env);
  // Id of this build: the service worker and the app detect a new version by it.
  const build = buildVar('BUILD_ID', process.env) || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    appType: 'spa',
    define: { __SELFBOUND_BUILD__: JSON.stringify(build) },
    plugins: [svelte(), preloadFont(), welcomeRoutes(), signedOutGuard(!!env.VITE_CLERK_PUBLISHABLE_KEY && !env.VITE_DEV_TOKEN), pwaFiles(build), publicUrl(buildVar('PUBLIC_URL', env))],
    build: {
      target: 'es2023',
      sourcemap: false,
      reportCompressedSize: false,
      rolldownOptions: {
        output: {
          // Everything startup needs in ONE chunk (compresses better, one request).
          codeSplitting: {
            groups: [{ name: 'start', test: /node_modules\/\.pnpm\/(convex|svelte)@|\/core\/src\/(?!app\/(sprints|admin|repeat|wiki)\.ts|sprintlogic\.ts|wikiTree\.ts|locales\/)|\/backend\/convex\/(_generated\/|shared\/(?!(?:pullRequests|embeds)\.ts))/, priority: 10 }],
          },
        },
      },
    },
  };
});
