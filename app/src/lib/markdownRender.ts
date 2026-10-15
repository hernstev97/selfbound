// Markdown renderer setup: loaded together with `marked` and `DOMPurify` (markdown.ts), so none of
// it is in the start bundle. Code blocks: codeblock.ts.
// Images load lazily and open full size on click; upload placeholders (`#upload-…`) show as a note.
// A Google Drive link alone on a line becomes a player (`driveEmbeds`).
import { t } from '@selfbound/core/i18n';
import type { Marked as MarkedClass } from 'marked';
import type DOMPurifyType from 'dompurify';
import { BARE_IDENTIFIER_RE } from '@selfbound/backend/shared/links';
import { codeBlockHtml, escapeHtml, fenceClaim, TOKEN_STYLE } from './codeblock.ts';
import { uploadNote } from './uploadNote.ts';

/** Path in the app if a link points to a wiki page or an issue (otherwise null). */
export function appPath(href: string, origin = globalThis.location?.origin ?? ''): { path: string; kind: 'wiki' | 'issue' } | null {
  let url: URL;
  try {
    url = new URL(href, origin || 'http://x.invalid');
  } catch {
    return null;
  }
  // Only relative URLs and this app's own origin (local, preview, production); other sites stay external.
  if (origin && url.origin !== origin && !/^\//.test(href)) return null;
  const wiki = /^\/(?:wiki|wissen)\/([a-z0-9]{16,40})\/?$/.exec(url.pathname);
  if (wiki) return { path: `/wiki/${wiki[1]}`, kind: 'wiki' };
  const issue = /^\/issue\/([A-Za-z][A-Za-z0-9]{1,5}-\d{1,6})\/?$/.exec(url.pathname);
  if (issue) return { path: `/issue/${issue[1]!.toUpperCase()}`, kind: 'issue' };
  return null;
}

/** Turn bare identifiers of known teams in text nodes into links (not inside links or code). */
function linkIdentifiers(root: DocumentFragment, teamKeys: ReadonlySet<string>) {
  if (teamKeys.size === 0) return;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = (n as Text).parentElement;
    if (parent?.closest('a, code, pre')) continue;
    if (/[A-Z][A-Z0-9]{1,5}-[1-9]/.test(n.nodeValue ?? '')) nodes.push(n as Text);
  }
  for (const node of nodes) {
    const text = node.nodeValue ?? '';
    const parts: (string | HTMLAnchorElement)[] = [];
    let last = 0;
    for (const m of text.matchAll(BARE_IDENTIFIER_RE)) {
      if (!teamKeys.has(m[1]!)) continue;
      const id = `${m[1]}-${Number(m[2])}`;
      const a = doc.createElement('a');
      a.href = `/issue/${id}`;
      a.textContent = m[0];
      a.className = 'xlink xlink-issue';
      a.dataset.nav = 'issue';
      parts.push(text.slice(last, m.index), a);
      last = m.index! + m[0].length;
    }
    if (!parts.length) continue;
    parts.push(text.slice(last));
    node.replaceWith(...parts);
  }
}

/** Drive file id: letters, digits, `-`, `_`. */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
/** A Drive link alone on a line: bare, in <…> or as [text](link). */
const DRIVE_LINE =
  /^ {0,3}(?:<?https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,200})(?:[/?#][^\s<>]*)?>?|\[([^\]\n]*)\]\(https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,200})(?:[/?#][^\s()]*)?\))[ \t]*(?:\n|$)/;
const DRIVE_START = /(?:^|\n) {0,3}(?:<|\[[^\]\n]*\]\()?https:\/\/drive\.google\.com\/file\/d\//;

/**
 * Sanitizing renderer: Markdown → safe HTML. `highlight` returns the colored HTML of a code block,
 * or null while the highlighter is not loaded yet (the block stays neutral).
 */
export function createRender(
  Marked: typeof MarkedClass,
  DOMPurify: typeof DOMPurifyType,
  highlight: (text: string, lang: string | undefined) => string | null,
): (markdown: string, teamKeys?: ReadonlySet<string>) => string {
  const marked = new Marked({ gfm: true, breaks: true });
  marked.use({
    extensions: [
      {
        name: 'drive',
        level: 'block',
        start(src: string) {
          const m = DRIVE_START.exec(src);
          return m ? m.index + (m[0].startsWith('\n') ? 1 : 0) : undefined;
        },
        tokenizer(src: string) {
          const m = DRIVE_LINE.exec(src);
          if (m) return { type: 'drive', raw: m[0], id: m[1] ?? m[3], label: m[2] ?? '' };
        },
        renderer(token) {
          const id = String(token.id);
          const label = escapeHtml(String(token.label || t('Video in Google Drive')));
          // Only a placeholder with a link; driveEmbeds() inserts the player once it is visible.
          return `<div class="drive-embed" data-drive="${id}"><a class="drive-open" href="https://drive.google.com/file/d/${id}/view">${label} · ${escapeHtml(t('Open in Drive'))}</a></div>`;
        },
      },
    ],
    renderer: {
      code: ({ text, lang }) => {
        const claim = fenceClaim(lang);
        return claim?.(text, lang!) ?? codeBlockHtml(text, lang, claim ? null : highlight(text, lang));
      },
      // Images open full size on click (new tab).
      image({ href, title, text }) {
        const alt = escapeHtml(text);
        const img = `<img src="${escapeHtml(href)}" alt="${alt}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
        return href.startsWith('#upload-') ? img : `<a class="md-img" href="${escapeHtml(href)}">${img}</a>`;
      },
    },
  });
  // Colors of highlighted code: tokens carry them as custom properties (style is forbidden otherwise).
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'style' && node.tagName === 'SPAN' && node.classList.contains('tk') && TOKEN_STYLE.test(data.attrValue)) data.forceKeepAttr = true;
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      // Links into the app (wiki page, issue): clicks stay in the app (Markdown.svelte), shown as a chip.
      const inApp = node.classList.contains('md-img') ? null : appPath(node.getAttribute('href') ?? '');
      if (inApp) {
        node.setAttribute('href', inApp.path);
        node.setAttribute('data-nav', inApp.kind);
        node.classList.add('xlink', `xlink-${inApp.kind}`);
        node.removeAttribute('target');
        return;
      }
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.tagName === 'IMG') {
      // Placeholder while uploading (upload.ts): a note instead of a broken image.
      if (node.getAttribute('src')?.startsWith('#upload-')) {
        const note = node.ownerDocument.createElement('span');
        const { text, failed } = uploadNote(node.getAttribute('alt') ?? '');
        note.className = failed ? 'upload-note failed' : 'upload-note';
        note.textContent = text;
        node.replaceWith(note);
        return;
      }
      node.setAttribute('loading', 'lazy');
      node.setAttribute('decoding', 'async');
      node.setAttribute('referrerpolicy', 'no-referrer');
    }
    // Task lists ("- [ ] task"): checkboxes, disabled at first (Markdown.svelte enables them where
    // they may be checked). Any other input is removed.
    if (node.tagName === 'INPUT') {
      if (node.getAttribute('type') !== 'checkbox') {
        node.parentNode?.removeChild(node);
        return;
      }
      for (const attr of [...node.attributes]) if (!['type', 'checked', 'disabled'].includes(attr.name)) node.removeAttribute(attr.name);
      node.setAttribute('disabled', '');
      node.closest('li')?.classList.add('task');
    }
  });
  const options = {
    FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'object', 'embed', 'select', 'textarea'],
    FORBID_ATTR: ['style'],
  };
  return (markdown: string, teamKeys?: ReadonlySet<string>) => {
    const html = marked.parse(markdown, { async: false }) as string;
    // Bare identifiers only if the text can contain one (otherwise keep the fast path).
    if (!teamKeys?.size || !/[A-Z][A-Z0-9]{1,5}-[1-9]/.test(markdown)) return DOMPurify.sanitize(html, options);
    const fragment = DOMPurify.sanitize(html, { ...options, RETURN_DOM_FRAGMENT: true });
    linkIdentifiers(fragment, teamKeys);
    const box = fragment.ownerDocument.createElement('div');
    box.append(fragment);
    return box.innerHTML;
  };
}

/**
 * Inserts the Drive players into rendered Markdown once a placeholder becomes visible (nothing is
 * loaded from Google before that). Returns a cleanup function.
 */
export function driveEmbeds(root: HTMLElement): (() => void) | undefined {
  const nodes = root.querySelectorAll<HTMLElement>('.drive-embed[data-drive]:not([data-ready])');
  if (!nodes.length) return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        mountDrive(entry.target as HTMLElement);
      }
    },
    { rootMargin: '200px' },
  );
  for (const node of nodes) observer.observe(node);
  return () => observer.disconnect();
}

function mountDrive(el: HTMLElement) {
  const id = el.dataset.drive ?? '';
  if (!DRIVE_ID.test(id) || el.dataset.ready) return;
  el.dataset.ready = '1';
  const frame = document.createElement('iframe');
  frame.src = `https://drive.google.com/file/d/${id}/preview`;
  frame.title = t('Video from Google Drive');
  frame.allow = 'autoplay; fullscreen; picture-in-picture';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  el.prepend(frame);
}
