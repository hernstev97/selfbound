import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { thirdPartyNotices } from './vite.notices.ts';
import { preloadFont, sourceLinks, sourceUrl } from './vite.plugins.ts';

// Sign-in page (welcome.html) as a separate build into the same output as the app
// (`pnpm build` builds the app first, then this). Built separately so app and sign-in page share no
// chunks: otherwise e.g. Vite's preload helper would land in the app's start chunk and the sign-in
// page would load it too. The font has the same name in both builds and exists only once.
// The third-party notices of this build are merged into the app's.
export default defineConfig(({ mode }) => {
  const source = sourceUrl(loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), ['SELFBOUND_SOURCE_URL']));
  return {
    plugins: [preloadFont(), sourceLinks(source), thirdPartyNotices({ sourceUrl: source, merge: true })],
    build: {
      target: 'es2023',
      sourcemap: false,
      reportCompressedSize: false,
      emptyOutDir: false,
      // The Clerk UI with React is large, but it is the only thing this page loads.
      chunkSizeWarningLimit: 2000,
      rolldownOptions: {
        input: fileURLToPath(new URL('welcome.html', import.meta.url)),
        output: {
          // Clerk in two parts instead of over a hundred small files: clerk-js and the UI (@clerk/ui
          // with React), which loads all its pieces after mounting anyway.
          codeSplitting: {
            // Only the modules themselves, not their dependencies: otherwise the group would pull in
            // Vite's preload helper and the sign-in page would load the whole Clerk UI.
            includeDependenciesRecursively: false,
            groups: [
              { name: 'clerk-js', test: /node_modules\/\.pnpm\/@clerk\+clerk-js@/, priority: 20 },
              // Without Vite itself (modulepreload polyfill), which belongs to the sign-in page entry.
              { name: 'clerk-ui', test: /node_modules\/\.pnpm\/(?!vite@)/, priority: 10 },
            ],
          },
        },
      },
    },
  };
});
