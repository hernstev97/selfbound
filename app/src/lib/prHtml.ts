// Sanitize HTML from GitHub (a PR's description, comments, reviews).
//
// GitHub already sanitizes `body_html`; still, everything goes through a SEPARATE DOMPurify
// instance (not the Markdown renderer's, whose hooks do not fit here): no scripts, forms or
// iframes, links open in a new tab, images load lazily. Videos (uploaded to GitHub or from the
// repo through the media proxy) stay playable.
import type DOMPurifyType from 'dompurify';

type Purifier = ReturnType<typeof DOMPurifyType>;

let purifier: Purifier | null = null;
let loading: Promise<Purifier> | null = null;

/** Loads DOMPurify (its own chunk, shared with the Markdown renderer). */
export function loadPrHtml(): Promise<Purifier> {
  loading ??= import('dompurify').then(({ default: DOMPurify }) => {
    const p = DOMPurify(window);
    p.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') ?? '';
        // Anchors within the text (footnotes) stay; everything else opens externally.
        if (!href.startsWith('#')) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      } else if (node.tagName === 'IMG') {
        node.setAttribute('loading', 'lazy');
        node.setAttribute('referrerpolicy', 'no-referrer');
        node.removeAttribute('width');
        node.removeAttribute('height');
      } else if (node.tagName === 'INPUT') {
        // Only task list checkboxes, disabled (checking happens on GitHub).
        node.setAttribute('type', 'checkbox');
        node.setAttribute('disabled', '');
      } else if (node.tagName === 'VIDEO') {
        node.setAttribute('controls', '');
        node.setAttribute('preload', 'metadata');
        node.setAttribute('playsinline', '');
        node.removeAttribute('autoplay');
      }
    });
    purifier = p;
    return p;
  });
  return loading;
}

/** Sanitized HTML, or null while DOMPurify is still loading. */
export function cleanPrHtml(html: string): string | null {
  if (!purifier) return null;
  return purifier.sanitize(html, {
    ADD_TAGS: ['video', 'source'],
    ADD_ATTR: ['controls', 'preload', 'playsinline', 'muted', 'poster', 'target'],
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  });
}
