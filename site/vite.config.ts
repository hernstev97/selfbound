import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { siteSettings, sitePlugin, type SiteConfig } from './site.plugin.ts';

// Static landing page (index.html + one script + one stylesheet). Not part of the app build.
export default defineConfig(() => {
  const config = JSON.parse(readFileSync(new URL('./site.config.json', import.meta.url), 'utf8')) as SiteConfig;
  return {
    plugins: [sitePlugin(siteSettings(config, process.env))],
    build: { target: 'es2023', sourcemap: false, reportCompressedSize: false, assetsInlineLimit: 0 },
  };
});
