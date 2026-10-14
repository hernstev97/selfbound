import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
// @ts-expect-error plain .mjs without types, shared with docs-site/
import { legalRequired, loadLegal } from '../tooling/site-legal.mjs';
import { siteSettings, sitePlugin, type SiteConfig } from './site.plugin.ts';

// Static landing page (index.html + one script + one stylesheet) and the two legal pages. Not part of the app build.
export default defineConfig(() => {
  const config = JSON.parse(readFileSync(new URL('./site.config.json', import.meta.url), 'utf8')) as SiteConfig;
  const settings = siteSettings(config, process.env);
  // Imprint details come from a file outside the repository; a build that goes live fails without them.
  const legal = loadLegal({ required: legalRequired(process.env, settings.listed) });
  const page = (name: string) => new URL(`./${name}.html`, import.meta.url).pathname;
  return {
    plugins: [sitePlugin({ ...settings, legal })],
    build: {
      target: 'es2023',
      sourcemap: false,
      reportCompressedSize: false,
      assetsInlineLimit: 0,
      rollupOptions: { input: { index: page('index'), impressum: page('impressum'), datenschutz: page('datenschutz') } },
    },
  };
});
