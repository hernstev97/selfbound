// Search: fuzzy over identifier and title in memory (uFuzzy), jump by identifier.
// The server adds full text in descriptions and comments (issues.search), see app/palette.ts.
import type uFuzzy from '@leeoniya/ufuzzy';
import type { Issue } from './types.ts';
import { haystackOf } from './haystack.ts';

// uFuzzy comes as its own chunk right after startup (not in the start bundle). Until then (a few
// milliseconds) a simple substring search runs over the same texts.
let uf: uFuzzy | null = null;
let loading: Promise<void> | null = null;
export function loadFuzzy() {
  loading ??= import('@leeoniya/ufuzzy').then((m) => {
    uf = new m.default({ intraMode: 1, intraIns: 1 });
  });
  return loading;
}

const KEY_RE = /^[A-Z][A-Z0-9]{1,5}$/;

/**
 * Possible splits of an input into team key (2–6 characters) and number:
 * "kiu-106", "KIU 106", "kiu106", "px12" (keys may contain digits, hence all variants).
 */
export function identifierCandidates(input: string): string[] {
  const s = input.trim().toUpperCase();
  const dashed = /^([A-Z][A-Z0-9]{1,5})[-_ ]+(\d{1,6})$/.exec(s);
  if (dashed) return [`${dashed[1]}-${Number(dashed[2])}`];
  const out: string[] = [];
  for (let i = 2; i <= 6 && i < s.length; i++) {
    const key = s.slice(0, i);
    const rest = s.slice(i);
    if (KEY_RE.test(key) && /^\d{1,6}$/.test(rest)) out.push(`${key}-${Number(rest)}`);
  }
  return out;
}

/** Does the input look like an identifier (then `issues.resolve` for old identifiers is worth it)? */
export function looksLikeIdentifier(input: string) {
  return identifierCandidates(input).length > 0;
}

export class IssueSearch {
  #version = -1;
  #issues: Issue[] = [];
  #haystack: string[] = [];
  #byKey = new Map<string, Issue>();
  #renamed: ReadonlyMap<string, string> = new Map();

  /**
   * Rebuild the index only if the issues changed. Deleted ones do not count. `renamed`: team keys
   * from before a rename → current key, so "OLD-12" finds the issue too.
   */
  prepare(version: number, all: Issue[], renamed: ReadonlyMap<string, string> = new Map()) {
    this.#renamed = renamed;
    if (version === this.#version) return;
    this.#version = version;
    this.#issues = all.filter((i) => i.deletedAt === undefined && !i.pending);
    this.#haystack = this.#issues.map(haystackOf);
    this.#byKey = new Map(this.#issues.map((i) => [i.key.toUpperCase(), i]));
  }

  /** The issue for the identifier, if the input is one. */
  exact(query: string): Issue | null {
    for (const candidate of identifierCandidates(query)) {
      const dash = candidate.indexOf('-');
      const current = this.#renamed.get(candidate.slice(0, dash));
      const hit = this.#byKey.get(candidate) ?? (current ? this.#byKey.get(`${current}${candidate.slice(dash)}`) : undefined);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Issues with a similar title (suggestions for "Duplicate of"): counts shared words of four or more
   * letters; on a tie, same team and most recently updated first. Runs once when opening.
   */
  similar(issue: Issue, limit = 8): Issue[] {
    const words = [...new Set(issue.title.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])];
    if (!words.length) return [];
    const scored: { issue: Issue; score: number }[] = [];
    for (let i = 0; i < this.#issues.length; i++) {
      const other = this.#issues[i];
      if (other._id === issue._id) continue;
      let score = 0;
      for (const word of words) if (this.#haystack[i].includes(word)) score++;
      if (score > 0) scored.push({ issue: other, score: score + (other.teamId === issue.teamId ? 0.5 : 0) });
    }
    scored.sort((a, b) => b.score - a.score || b.issue.updatedAt - a.issue.updatedAt);
    return scored.slice(0, limit).map((s) => s.issue);
  }

  search(query: string, limit = 50): Issue[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: Issue[] = [];
    const seen = new Set<Issue>();
    // An identifier like "kiu-106", "kiu106" or "kiu 106" comes first.
    const hit = this.exact(q);
    if (hit) {
      results.push(hit);
      seen.add(hit);
    }
    if (!uf) {
      void loadFuzzy();
      const tokens = q.split(/\s+/);
      for (let i = 0; i < this.#haystack.length && results.length < limit; i++) {
        const issue = this.#issues[i];
        if (!seen.has(issue) && tokens.every((token) => this.#haystack[i].includes(token))) results.push(issue);
      }
      return results;
    }
    const idxs = uf.filter(this.#haystack, q);
    if (!idxs || idxs.length === 0) return results;
    let order: number[];
    if (idxs.length <= 2000) {
      const info = uf.info(idxs, this.#haystack, q);
      order = uf.sort(info, this.#haystack, q).map((i) => info.idx[i]);
    } else {
      order = idxs;
    }
    for (const idx of order) {
      const issue = this.#issues[idx];
      if (seen.has(issue)) continue;
      results.push(issue);
      if (results.length >= limit) break;
    }
    return results;
  }
}

/** Simple ranking for commands: all words must occur, word starts count more. */
export function scoreText(text: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  let score = 0;
  for (const token of q.split(/\s+/)) {
    const at = t.indexOf(token);
    if (at < 0) return 0;
    score += at === 0 ? 4 : /[\s:·(-]/.test(t[at - 1]) ? 3 : 1;
  }
  return score;
}
