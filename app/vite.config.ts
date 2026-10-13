import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { preloadFont, publicUrl, pwaFiles, signedOutGuard, welcomeRoutes } from './vite.plugins.ts';

// SPA: the dev and preview servers serve index.html for deep links (/issue/ACME-106,
// /team/ACME/backlog …) (appType 'spa'). The start page (welcome.html) is built separately by
// vite.welcome.config.ts so app and start page share no chunks; dev and preview still serve it.
export default defineConfig(({ mode }) => {
  // XLR8_PUBLIC_URL is read at build time only (vite.plugins.ts publicUrl); it never reaches the client.
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), ['VITE_', 'XLR8_PUBLIC_URL']);
  // Id of this build: the service worker and the app detect a new version by it.
  const build = process.env.XLR8_BUILD_ID || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    appType: 'spa',
    define: { __XLR8_BUILD__: JSON.stringify(build) },
    plugins: [svelte(), preloadFont(), welcomeRoutes(), signedOutGuard(!!env.VITE_CLERK_PUBLISHABLE_KEY && !env.VITE_DEV_TOKEN), pwaFiles(build), publicUrl(env.XLR8_PUBLIC_URL)],
    build: {
      target: 'es2023',
      sourcemap: false,
      reportCompressedSize: false,
      rolldownOptions: {
        output: {
          // Everything startup needs in ONE chunk (compresses better, one request).
          codeSplitting: {
            groups: [{ name: 'start', test: /node_modules\/\.pnpm\/(convex|svelte)@|\/core\/src\/(?!app\/(sprints|admin|repeat|wiki)\.ts|sprintlogic\.ts|wikiTree\.ts|locales\/)|\/backend\/convex\/(_generated\/|shared\/(?!pullRequests\.ts))/, priority: 10 }],
          },
        },
      },
    },
  };
});
