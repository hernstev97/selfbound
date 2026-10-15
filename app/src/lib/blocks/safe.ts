// Safe markup for renderers that produce SVG. DOMPurify is already part of the Markdown chunk, so a
// renderer module that imports this adds nothing.
import DOMPurify from 'dompurify';

/**
 * SVG string → sanitized SVG string: no scripts, no event handlers, no `foreignObject`, no external
 * references. Inline `<style>` is kept (renderers theme with CSS variables) but `@import` and
 * `url(http…)` are removed.
 */
export function sanitizeSvg(svg: string): string {
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'script', 'a', 'image', 'use'],
    FORBID_ATTR: ['href', 'xlink:href'],
    ADD_TAGS: ['style'],
  });
  return clean.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, 'none');
}
