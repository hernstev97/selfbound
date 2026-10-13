// Import one Linear document as a wiki page.
//
//   node tooling/linear-import/index.ts document <copy.md> --team <KEY> [--project <name>] [--yes] [--backend-dir <dir>] [--prod]
//
// `fetch` does not fetch Linear documents. A document is imported from a Markdown copy:
//
//   # Title
//   <note line about the copy>
//   - Linear ID: <uuid>
//   - Project in Linear: <name>
//   - Created: <ISO> · Updated: <ISO> · by <name>
//   - URL: https://linear.app/…
//   ---
//   <text>
//
// (The German labels `Linear-ID`, `Projekt in Linear`, `Angelegt`, `Geändert` of older copies are
// accepted too.) This yields the title (H1), the Linear ID (re-running does not duplicate), the
// created/updated times and the Linear URL as a source; the text is everything after the first
// `---` line. The console shows only counts and ids, never title or text. Without `--yes` (and
// always with `--prod`) the confirmation is typed.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { REPO_ROOT } from './index.ts';
import { convex, parseRunOutput, targetOf } from './push.ts';

export interface ParsedDocument {
  linearId: string;
  title: string;
  projectName?: string;
  createdAt: number;
  updatedAt: number;
  url?: string;
  markdown: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isoTime(value: string | undefined, what: string) {
  const ms = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`${what} is missing or not a timestamp.`);
  return ms;
}

/** Header labels: English first, then the German labels of older copies. */
const LABELS = {
  linearId: ['Linear ID', 'Linear-ID'],
  project: ['Project in Linear', 'Projekt in Linear'],
  created: ['Created', 'Angelegt'],
  updated: ['Updated', 'Geändert'],
};

/** Parses the copy. Throws on an unknown layout instead of guessing. */
export function parseDocument(text: string): ParsedDocument {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const h1 = lines.findIndex((l) => /^# \S/.test(l));
  if (h1 < 0) throw new Error('No "# …" heading found.');
  const rule = lines.findIndex((l, i) => i > h1 && l.trim() === '---');
  if (rule < 0) throw new Error('No "---" separator line found after the header.');
  const head = lines.slice(h1 + 1, rule);
  const field = (names: string[]) => {
    for (const name of names) {
      const line = head.find((l) => l.startsWith(`- ${name}:`));
      if (line !== undefined) return line.slice(name.length + 3).trim();
    }
    return undefined;
  };
  const linearId = field(LABELS.linearId) ?? '';
  if (!UUID_RE.test(linearId)) throw new Error('Linear ID is missing or has the wrong format.');
  const dates = field(LABELS.created) ?? '';
  const [created, changed] = dates.split('·').map((part) => part.trim());
  const createdAt = isoTime(created, 'Created');
  const updatedLabel = new RegExp(`^(${LABELS.updated.join('|')}):\\s*`);
  const updatedAt = isoTime(changed?.replace(updatedLabel, ''), 'Updated');
  const url = field(['URL']);
  if (url !== undefined && !/^https:\/\/linear\.app\/\S+$/.test(url)) throw new Error('The URL is not a Linear URL.');
  const markdown = `${lines
    .slice(rule + 1)
    .join('\n')
    .trim()}\n`;
  if (markdown.trim() === '') throw new Error('The text is empty.');
  return { linearId, title: lines[h1]!.slice(2).trim(), projectName: field(LABELS.project), createdAt, updatedAt, url, markdown };
}

export interface DocumentOptions {
  file: string;
  team: string;
  /** Project in XLR8 (default: "Project in Linear" from the copy). */
  project?: string;
  yes?: boolean;
  backendDir?: string;
  prod?: boolean;
  /** Access date of the Linear source (default: today). */
  accessedAt?: string;
  print?: (line: string) => void;
  ask?: (question: string) => Promise<string>;
}

const CONFIRM_WORD = 'import';

export async function runDocument(o: DocumentOptions) {
  const print = o.print ?? ((line: string) => console.log(line));
  const backendDir = resolve(o.backendDir ?? join(REPO_ROOT, 'backend'));
  const prod = o.prod === true;
  if (prod && o.yes) throw new Error('Aborted: --yes does not apply to production.');
  if (prod && o.backendDir) throw new Error('Aborted: --prod and --backend-dir are mutually exclusive.');
  const doc = parseDocument(readFileSync(o.file, 'utf8'));
  const projectName = o.project ?? doc.projectName;
  print(prod ? 'Target: PRODUCTION' : `Target: ${targetOf(backendDir).url} (local)`);
  print(
    `Document: Linear ID ${doc.linearId}, title ${doc.title.length} chars, text ${doc.markdown.length} chars, ` +
      `created ${new Date(doc.createdAt).toISOString()}, updated ${new Date(doc.updatedAt).toISOString()}, ` +
      `team ${o.team.toUpperCase()}, ${projectName ? 'with project' : 'no project'}, ${doc.url ? '1 source' : 'no source'}`,
  );
  if (prod || !o.yes) {
    const ask =
      o.ask ??
      (async (question: string) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      });
    if ((await ask(`Type "${CONFIRM_WORD}" to import${prod ? ' into PRODUCTION' : ''}: `)).trim() !== CONFIRM_WORD) {
      throw new Error('Cancelled, nothing imported.');
    }
  }
  const args = {
    linearId: doc.linearId,
    teamKey: o.team,
    ...(projectName ? { projectName } : {}),
    title: doc.title,
    markdown: doc.markdown,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    sources: doc.url ? [{ url: doc.url, title: 'Linear document (original)', ...(o.accessedAt ? { accessedAt: o.accessedAt } : {}) }] : [],
    enableWiki: true,
  };
  const out = await convex(backendDir, ['run', 'importer:importArticle', JSON.stringify(args)], prod);
  const result = parseRunOutput(out) as { result: string; articleId: string; enabledWiki: boolean };
  print(`Result: ${result.result}, page ${result.articleId}${result.enabledWiki ? ', wiki enabled' : ''}`);
  return result;
}
