// Safe SVG for renderers that return markup (a diagram library gives an SVG string). DOMPurify is
// already part of the Markdown chunk, so a renderer module that imports this adds nothing.
//
// The sanitized SVG is shown inside a shadow root (`setSvg`): its <style> then only reaches the
// drawing, not the app, and the app's CSS variables (the theme) still pass in.
import DOMPurify, { type Config } from 'dompurify';

// Anything in CSS that could load something, run something or reach outside the drawing.
const UNSAFE_CSS = /@import|@namespace|@font-face|\\|expression\s*\(|behavior\s*:|-moz-binding|image-set|\bsrc\s*\(|javascript:|url\s*\(\s*(?!['"]?#)/i;

// A separate instance: its hooks must not touch the one that sanitizes Markdown.
const purify = DOMPurify(window);
purify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'style' && UNSAFE_CSS.test(data.attrValue)) data.keepAttr = false;
});

const CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['style'],
  FORBID_TAGS: ['foreignObject', 'script', 'a', 'image', 'use', 'animate', 'set', 'animateMotion', 'animateTransform', 'switch'],
  FORBID_ATTR: ['href', 'xlink:href'],
  RETURN_DOM_FRAGMENT: true,
};

/** SVG string → sanitized nodes: no scripts, event handlers, links, `foreignObject` or external references. */
export function sanitizeSvg(svg: string): DocumentFragment {
  const fragment = purify.sanitize(svg, CONFIG) as unknown as DocumentFragment; // RETURN_DOM_FRAGMENT
  for (const style of fragment.querySelectorAll('style')) {
    // A font import is the one thing renderers add on their own; drop it, keep the rest.
    const css = (style.textContent ?? '').replace(/@import[^;{}]*;?/gi, '');
    if (UNSAFE_CSS.test(css)) style.remove();
    else style.textContent = css;
  }
  return fragment;
}

/** Shows an SVG string in `host` (replacing its content), sanitized and style-isolated. */
export function setSvg(host: HTMLElement, svg: string) {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  const base = document.createElement('style');
  base.textContent = ':host { display: block; } svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }';
  root.replaceChildren(base, sanitizeSvg(svg));
}
