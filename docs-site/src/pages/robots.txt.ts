import type { APIRoute } from 'astro';
import { INDEXABLE, SITE_URL } from '../../launch.mjs';

// Crawlers may fetch pages either way, so they can see the `noindex` meta tag before launch.
export const GET: APIRoute = () =>
  new Response(INDEXABLE ? `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap-index.xml\n` : 'User-agent: *\nAllow: /\n', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
