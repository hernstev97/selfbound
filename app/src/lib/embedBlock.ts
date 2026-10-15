// Markdown extension for embeds: a link to a YouTube video or an X post alone on a line becomes a
// placeholder `<div class="embed" data-embed="youtube">` that contains the plain link. Pure and
// DOM-free (like codeblock.ts). The card replaces the link in the browser once the placeholder is
// visible and the data is there (lib/embedCards.ts); until then, and if anything fails, the link
// stays. Recognizing links and providers: backend/convex/shared/embeds.ts.
import type { TokenizerAndRendererExtension } from 'marked';
import { embedLineStart, parseEmbedUrl } from '@selfbound/backend/shared/embeds';
import { escapeHtml } from './codeblock.ts';

/** A link alone on a line: bare, in <…> or as [text](link). */
const EMBED_LINE = /^ {0,3}(?:<(https:\/\/[^\s<>]+)>|(https:\/\/[^\s<>]+)|\[([^\]\n]*)\]\((https:\/\/[^\s()<>]+)\))[ \t]*(?:\n|$)/;

export const embedExtension: TokenizerAndRendererExtension = {
  name: 'embed',
  level: 'block',
  start(src: string) {
    return embedLineStart(src);
  },
  tokenizer(src: string) {
    const m = EMBED_LINE.exec(src);
    if (!m) return;
    const href = m[1] ?? m[2] ?? m[4]!;
    const ref = parseEmbedUrl(href);
    if (ref) return { type: 'embed', raw: m[0], href, label: m[3] ?? '', provider: ref.provider, id: ref.id, start: ref.start ?? 0 };
  },
  renderer(token) {
    const href = escapeHtml(String(token.href));
    const label = escapeHtml(String(token.label || token.href));
    const start = Number(token.start) > 0 ? ` data-embed-start="${Number(token.start)}"` : '';
    return `<div class="embed" data-embed="${token.provider}" data-embed-id="${escapeHtml(String(token.id))}"${start}><a class="embed-link" href="${href}">${label}</a></div>\n`;
  },
};
