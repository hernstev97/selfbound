// Search text of a wiki page (articleSearch): the text in chunks of about CHUNK_CHARS characters,
// split at headings and paragraphs. URLs and image tokens are dropped because they only produce
// fuzzy matches; link texts and image alt texts stay.
//
// Chunks instead of a single row: a search hit reads the whole document, so this keeps every hit
// small, and passages far down a long page are still found (unlike issue descriptions, whose search
// text only holds the beginning).

export const CHUNK_CHARS = 4000;
/** Once the current chunk reaches this length, a heading starts a new chunk. */
const HEADING_SPLIT_CHARS = 1000;

/** Markdown without URLs: `[text](url)` → text, `![alt](url)` → alt, bare URLs removed. */
export function plainText(markdown: string) {
  return markdown
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"\n]*")?\)/g, '$1')
    .replace(/<?\bhttps?:\/\/[^\s<>)\]]+>?/g, '')
    .replace(/[ \t]+/g, ' ');
}

/** Splits overlong blocks at spaces (hard cut if needed) into pieces of at most `max` characters. */
function splitLong(block: string, max: number) {
  const parts: string[] = [];
  let rest = block;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** The search text chunks (empty text: none). */
export function searchChunks(markdown: string, max = CHUNK_CHARS): string[] {
  const blocks = plainText(markdown)
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .flatMap((b) => splitLong(b, max));
  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    const heading = block.startsWith('#');
    if (current && (current.length + 2 + block.length > max || (heading && current.length >= HEADING_SPLIT_CHARS))) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) chunks.push(current);
  return chunks;
}
