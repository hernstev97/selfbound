// Files from Linear (import): find and replace links to `uploads.linear.app`.
//
// Linear stores images and attachments under https://uploads.linear.app/<workspace>/<file>/<file>.
// Some links carry a signature (`?signature=…`) that expires after a few minutes, so a file is
// identified by its address without the query (`?…`) and without the fragment (`#…`).

const LINEAR_UPLOAD_RE = /https:\/\/uploads\.linear\.app\/[^\s()<>[\]"'`?#]+(?:\?[^\s()<>[\]"'`#]*)?(?:#[^\s()<>[\]"'`]*)?/g;

/** Identity of a Linear file: the address without query and fragment. */
export function linearUploadPath(url: string) {
  return url.split(/[?#]/)[0]!;
}

/** All Linear files in a text (identities, no duplicates, in order of appearance). */
export function linearUploadPaths(text: string): string[] {
  if (!text.includes('uploads.linear.app')) return [];
  return [...new Set([...text.matchAll(LINEAR_UPLOAD_RE)].map((m) => linearUploadPath(m[0])))];
}

/**
 * Replaces every link to a Linear file for which `targets` has a new address (signature and
 * query are dropped). Links without a target stay and are listed in `missing`.
 */
export function replaceLinearUploads(text: string, targets: ReadonlyMap<string, string>) {
  let replaced = 0;
  const missing = new Set<string>();
  if (!text.includes('uploads.linear.app')) return { text, replaced, missing: [] as string[] };
  const out = text.replace(LINEAR_UPLOAD_RE, (url) => {
    const target = targets.get(linearUploadPath(url));
    if (target === undefined) {
      missing.add(linearUploadPath(url));
      return url;
    }
    replaced++;
    return target;
  });
  return { text: out, replaced, missing: [...missing] };
}
