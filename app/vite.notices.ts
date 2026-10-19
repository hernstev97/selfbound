// Third-party notices of what a build actually ships (SELF-83): npm packages whose code or files end
// up in the bundle, the vendored color themes (src/themes/*/LICENSE) and the bundled Shiki grammars
// (license texts from the tm-grammars NOTICE). Written as /third-party-notices.txt (for people) and
// /third-party-notices.json (machine-readable, and how the second build merges into the first). The
// build fails when a shipped license is not on the AGPL-3.0-compatible allowlist below.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export interface Notice {
  kind: 'package' | 'theme' | 'grammar';
  name: string;
  version?: string;
  /** SPDX expression */
  license: string;
  url?: string;
  text: string;
}

const APP_DIR = fileURLToPath(new URL('.', import.meta.url));
const THEMES_DIR = `${APP_DIR.replaceAll('\\', '/').replace(/\/$/, '')}/src/themes/`;
const JSON_FILE = 'third-party-notices.json';
const TEXT_FILE = 'third-party-notices.txt';

/** Licenses compatible with shipping inside an AGPL-3.0 work (common practice, not legal advice). */
export const ALLOWED_LICENSES = new Set([
  '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0', 'CC-BY-4.0', 'CC0-1.0', 'ISC', 'MIT', 'MIT-0',
  'MPL-2.0', 'OFL-1.1', 'Python-2.0', 'Unlicense', 'W3C', 'Zlib',
  'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
]);

/**
 * Packages whose package.json lacks the license although the package ships one; checked by hand, per
 * version so a new version is checked again.
 */
const LICENSE_OVERRIDES: Record<string, string> = {
  // LICENSE.md: the Unlicense (comes in through Clerk's Solana sign-in, borsh).
  'text-encoding-utf-8@1.0.2': 'Unlicense',
};

/** Is an SPDX expression acceptable? `A OR B` needs one allowed side, `A AND B` both. */
export function licenseAllowed(expression: string | undefined): boolean {
  const expr = expression?.trim().replace(/^\((.*)\)$/, '$1');
  if (!expr) return false;
  if (/\sOR\s/.test(expr) && !/\sAND\s|\(/.test(expr)) return expr.split(/\s+OR\s+/).some((id) => ALLOWED_LICENSES.has(id.trim()));
  if (/[()]/.test(expr) || /\sOR\s/.test(expr)) return false;
  return expr.split(/\s+AND\s+/).every((id) => ALLOWED_LICENSES.has(id.trim()));
}

/** npm package of a module path: its name and directory, or null for code outside node_modules. */
export function packageOf(id: string): { name: string; dir: string } | null {
  const path = id.split('?')[0]!.replaceAll('\\', '/');
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const parts = path.slice(at + '/node_modules/'.length).split('/');
  const name = parts[0]!.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
  if (!name || name.startsWith('.')) return null;
  return { name, dir: `${path.slice(0, at)}/node_modules/${name}` };
}

/** Vite and Rolldown inject small runtime helpers as virtual modules (`\0vite/preload-helper.js`). */
function helperPackage(id: string): string | null {
  const m = /^\0(vite|rolldown)\//.exec(id);
  return m ? m[1]! : null;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;

function packageNotice(dir: string): Notice {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    name: string;
    version?: string;
    license?: string | { type?: string };
    licenses?: { type?: string }[];
    homepage?: string;
    repository?: string | { url?: string };
  };
  const license =
    LICENSE_OVERRIDES[`${pkg.name}@${pkg.version}`] ??
    (typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? pkg.licenses?.map((l) => l.type).filter(Boolean).join(' OR ') ?? ''));
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
  // Build tools (Vite) append the licenses of their own Node dependencies, none of which is shipped.
  const text = files.map((f) => readFileSync(join(dir, f), 'utf8').split(/^#+ Licenses of bundled dependencies/m)[0]!.trim()).join('\n\n');
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const url = pkg.homepage ?? repo?.replace(/^git\+/, '').replace(/\.git$/, '');
  return { kind: 'package', name: pkg.name, version: pkg.version, license, url, text: text || `The package contains no license file. It is published under ${license || 'no stated license'}${license ? ` (https://spdx.org/licenses/${license}.html)` : ''}.` };
}

/** Rows of src/themes/SOURCES.md by theme id. */
function themeSources(): Map<string, { name: string; source: string; version: string; license: string }> {
  const rows = new Map<string, { name: string; source: string; version: string; license: string }>();
  for (const line of readFileSync(join(APP_DIR, 'src/themes/SOURCES.md'), 'utf8').split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 8 || !/^[a-z0-9-]+$/.test(cells[1]!)) continue;
    rows.set(cells[1]!, { name: cells[2]!, source: cells[4]!, version: cells[5]!, license: cells[6]! });
  }
  return rows;
}

/** Sections of the tm-grammars NOTICE, by grammar name: SPDX id, license URL and text. */
export function parseGrammarNotice(notice: string): Map<string, { license: string; url: string; text: string }> {
  const out = new Map<string, { license: string; url: string; text: string }>();
  for (const section of notice.split(/^={20,}$/m)) {
    const files = /^Files:\s+(.+)$/m.exec(section)?.[1];
    if (!files) continue;
    const license = /^SPDX:\s+(.+)$/m.exec(section)?.[1]?.trim() ?? '';
    const url = /^License:\s+(.+)$/m.exec(section)?.[1]?.trim() ?? '';
    const text = section.split(/^-{20,}$/m).slice(1).join('').trim();
    for (const file of files.split(',')) out.set(file.trim().replace(/\.json$/, ''), { license, url, text });
  }
  return out;
}

/**
 * Notices for the module ids of one build. `problems` collects what cannot be attributed: a package
 * without package.json, a virtual module of unknown origin.
 */
export function collectNotices(ids: Iterable<string>, problems: string[] = []): Notice[] {
  const notices = new Map<string, Notice>();
  // By directory: a build can ship two versions of one package, each with its own license.
  const packageDirs = new Set<string>();
  const themes = new Set<string>();
  const grammars = new Set<string>();
  for (const raw of ids) {
    const helper = helperPackage(raw);
    if (helper) {
      // The helper's package as the app's build resolves it (vite, and rolldown next to it).
      const vite = realpathSync(fileURLToPath(new URL('./node_modules/vite', import.meta.url)));
      packageDirs.add(helper === 'vite' ? vite : join(vite, '..', 'rolldown'));
      continue;
    }
    if (raw.startsWith('\0')) {
      problems.push(`virtual module of unknown origin: ${raw.slice(1)}`);
      continue;
    }
    const id = raw.split('?')[0]!.replaceAll('\\', '/');
    const grammar = /\/@shikijs\/langs\/dist\/([\w.-]+)\.mjs$/.exec(id)?.[1];
    if (grammar && grammar !== 'index') grammars.add(grammar);
    const theme = id.startsWith(THEMES_DIR) ? /^([a-z0-9-]+)\/[^/]+$/.exec(id.slice(THEMES_DIR.length))?.[1] : undefined;
    if (theme) themes.add(theme);
    const pkg = packageOf(id);
    if (!pkg) continue;
    if (existsSync(join(pkg.dir, 'package.json'))) packageDirs.add(pkg.dir);
    else problems.push(`no package.json for ${pkg.name} (${id})`);
  }
  for (const dir of packageDirs) {
    const notice = packageNotice(dir);
    notices.set(`package:${notice.name}@${notice.version}`, notice);
  }
  if (themes.size) {
    const sources = themeSources();
    for (const id of themes) {
      const row = sources.get(id);
      const file = join(APP_DIR, 'src/themes', id, 'LICENSE');
      const text = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
      notices.set(`theme:${id}`, { kind: 'theme', name: row?.name ?? id, version: row?.version, license: row?.license ?? '', url: row?.source, text });
    }
  }
  if (grammars.size) {
    const sections = parseGrammarNotice(readFileSync(fileURLToPath(new URL('./node_modules/tm-grammars/NOTICE', import.meta.url)), 'utf8'));
    for (const name of grammars) {
      const section = sections.get(name);
      notices.set(`grammar:${name}`, { kind: 'grammar', name, license: section?.license ?? '', url: section?.url, text: section?.text ?? '' });
    }
  }
  return [...notices.values()];
}

const KIND_ORDER = { package: 0, theme: 1, grammar: 2 } as const;
const KIND_LABEL = { package: 'Package', theme: 'Color theme', grammar: 'Syntax grammar (Shiki)' } as const;

/** Merges notice lists, one entry per kind, name and version, sorted. */
export function mergeNotices(...lists: Notice[][]): Notice[] {
  const byKey = new Map<string, Notice>();
  for (const list of lists) for (const n of list) byKey.set(`${n.kind}:${n.name}@${n.version ?? ''}`, n);
  return [...byKey.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name) || (a.version ?? '').localeCompare(b.version ?? ''));
}

const RULE = '-'.repeat(78);

/** The text file: a summary list, then every entry with its license text. */
export function renderNotices(notices: Notice[], sourceUrl: string): string {
  const head = [
    'Third-party software in Selfbound',
    '',
    'Selfbound is free software under the GNU Affero General Public License v3.0.',
    `Source code: ${sourceUrl}`,
    '',
    'This build contains the third-party software listed below, each under its own license.',
    'The list is generated when the app is built, from the files that end up in the build.',
    '',
  ];
  const summary = notices.map((n) => `- ${KIND_LABEL[n.kind]}: ${n.name}${n.version ? ` ${n.version}` : ''} (${n.license || 'unknown'})`);
  const entries = notices.map((n) =>
    [RULE, `${n.name}${n.version ? ` ${n.version}` : ''}`, `${KIND_LABEL[n.kind]}, license: ${n.license || 'unknown'}`, ...(n.url ? [n.url] : []), '', n.text].join('\n'),
  );
  return `${[...head, ...summary, '', ...entries].join('\n')}\n`;
}

/**
 * Vite plugin. `merge`: add to the notices of an earlier build in the same output directory (the
 * sign-in page is built second, into the app's output).
 */
export function thirdPartyNotices(options: { sourceUrl: string; merge?: boolean }): Plugin {
  let root = '';
  let outDir = '';
  // CSS from packages is inlined into CSS assets; its JS stub renders to nothing, so record it here.
  const cssIds = new Set<string>();
  return {
    name: 'selfbound-third-party-notices',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    transform(_code, id) {
      if (/\.css($|\?)/.test(id) && packageOf(id)) cssIds.add(id);
      return null;
    },
    generateBundle(_options, bundle) {
      const ids = new Set<string>(cssIds);
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') {
          for (const [id, module] of Object.entries(file.modules)) if (module.renderedLength > 0) ids.add(id);
        } else {
          // Relative to the project root
          for (const id of file.originalFileNames) ids.add(resolve(root, id));
        }
      }
      const earlier = options.merge && existsSync(join(outDir, JSON_FILE)) ? (JSON.parse(readFileSync(join(outDir, JSON_FILE), 'utf8')) as Notice[]) : [];
      const problems: string[] = [];
      const notices = mergeNotices(earlier, collectNotices(ids, problems));
      problems.push(...notices.filter((n) => !licenseAllowed(n.license)).map((n) => `${n.kind} ${n.name}${n.version ? `@${n.version}` : ''}: license ${n.license || 'none'}`));
      if (problems.length) this.error(`Shipped third-party code without an acceptable license (app/vite.notices.ts):\n${problems.map((p) => `  ${p}`).join('\n')}`);
      this.emitFile({ type: 'asset', fileName: JSON_FILE, source: `${JSON.stringify(notices)}\n` });
      this.emitFile({ type: 'asset', fileName: TEXT_FILE, source: renderNotices(notices, options.sourceUrl) });
    },
  };
}
