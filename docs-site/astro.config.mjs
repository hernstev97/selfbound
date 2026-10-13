import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import { INDEXABLE, REPO_URL, SITE_URL } from './launch.mjs';

export default defineConfig({
  site: SITE_URL,
  trailingSlash: 'ignore',
  integrations: [
    starlight({
      title: 'XLR8 Docs',
      description: 'XLR8 is a fast, keyboard-first issue tracker for solo developers and their AI agents. Self-hosted, open source.',
      logo: { light: './src/assets/logo-light.svg', dark: './src/assets/logo-dark.svg', replacesTitle: true, alt: 'XLR8' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: REPO_URL }],
      editLink: { baseUrl: `${REPO_URL}/edit/main/docs-site/` },
      lastUpdated: false,
      customCss: ['./src/styles/fonts.css', './src/styles/theme.css'],
      head: [
        ...(INDEXABLE ? [] : [{ tag: 'meta', attrs: { name: 'robots', content: 'noindex, nofollow' } }]),
        { tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '32x32' } },
        // Key caps show ⌘ and ⌥ on a Mac (components/Kbd.astro).
        { tag: 'script', content: "if (/Mac|iPhone|iPad/.test(navigator.platform)) document.documentElement.dataset.mac = '';" },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
        { tag: 'meta', attrs: { property: 'og:image', content: `${SITE_URL}/og-image.png` } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { slug: 'start/introduction' },
            { slug: 'start/try-locally' },
            {
              label: 'Self-hosting',
              items: [
                { slug: 'start/self-hosting' },
                { slug: 'start/self-hosting/clerk' },
                { slug: 'start/self-hosting/convex' },
                { slug: 'start/self-hosting/web-app' },
                { slug: 'start/self-hosting/updating' },
              ],
            },
            { slug: 'start/first-steps' },
          ],
        },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
        { label: 'Working with agents', items: [{ autogenerate: { directory: 'agents' } }] },
        { label: 'Integrations', items: [{ autogenerate: { directory: 'integrations' } }] },
        { label: 'Using XLR8', items: [{ autogenerate: { directory: 'using' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
        { label: 'Project', items: [{ autogenerate: { directory: 'project' } }] },
      ],
    }),
  ],
});
