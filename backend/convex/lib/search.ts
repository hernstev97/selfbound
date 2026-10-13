// Shared helpers for full-text search (issues and knowledge base).

/** Search terms, lowercased, without punctuation (like the search indexes: word prefixes). */
export function searchTerms(query: string) {
  return query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Does the text contain every search term as a word prefix? */
export function hasAllTerms(source: string, terms: string[]) {
  if (terms.length === 0) return false;
  const words = source.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.every((term) => words.some((word) => word.startsWith(term)));
}

/** Short excerpt around the first matching search term (for the result list). */
export function snippet(source: string, terms: string[]) {
  const lower = source.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, at - 40);
  const text = source.slice(start, start + 140).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + text + (start + 140 < source.length ? '…' : '');
}
