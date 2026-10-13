#!/usr/bin/env node
// Checks the UI translations (core/src/i18n.ts):
// - every literal key in t(), tn(), tc(), msg() and translated({...}) has a German entry,
// - German entries use the same {placeholders} as the English key,
// - keys used with tn() have a [singular, plural] entry,
// - no key appears in two dictionary files with different translations.
// German entries whose key is not found as a literal are listed as a warning only: labels can
// be translated through a variable (t(label)).
//
// Usage: node tooling/i18n-check.mjs [--verbose]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const verbose = process.argv.includes('--verbose');
const SOURCES = ['app/src', 'core/src', 'backend/convex/shared'];
const DICTIONARIES = ['core/src/locales/de.ts', ...readdirSync(join(root, 'app/src/locales/de')).filter((f) => f !== 'index.ts').map((f) => `app/src/locales/de/${f}`)];
const CONTEXT = '\u0004';

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'locales' && name !== 'node_modules' && name !== '_generated') out.push(...files(path));
    } else if (/\.(ts|svelte|js)$/.test(name) && !name.endsWith('.d.ts') && !path.endsWith('core/src/i18n.ts')) out.push(path);
  }
  return out;
}

// A string literal: '…', "…" or `…` without ${}.
const STR = String.raw`(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|\x60((?:\\.|[^\x60\\$])*)\x60)`;
const unescape = (s) => s.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
const pick = (m, i) => unescape(m[i] ?? m[i + 1] ?? m[i + 2] ?? '');

const used = new Map(); // key → { plural, where }
const add = (key, where, plural = false) => {
  const seen = used.get(key);
  if (seen) seen.plural ||= plural;
  else used.set(key, { plural, where });
};

for (const dir of SOURCES) {
  for (const path of files(join(root, dir))) {
    const code = readFileSync(path, 'utf8');
    const rel = relative(root, path);
    const line = (index) => `${rel}:${code.slice(0, index).split('\n').length}`;
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w.$])(?:t|msg)\(\s*${STR}\s*[,)]`, 'g'))) add(pick(m, 1), line(m.index));
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w.$])tn\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*${STR}\s*,\s*${STR}`, 'g'))) add(pick(m, 1), line(m.index), true);
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w.$])tc\(\s*${STR}\s*,\s*${STR}`, 'g'))) add(`${pick(m, 1)}${CONTEXT}${pick(m, 4)}`, line(m.index));
    for (const block of code.matchAll(/(?<![\w.$])translated\(\s*\{([\s\S]*?)\}\s*\)/g)) {
      for (const m of block[1].matchAll(new RegExp(String.raw`:\s*${STR}`, 'g'))) add(pick(m, 1), line(block.index));
    }
  }
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const show = (key) => key.replace(CONTEXT, ' ‖ ');

const errors = [];
const warnings = [];
const german = new Map(); // key → { entry, file }
for (const file of DICTIONARIES) {
  const dict = (await import(pathToFileURL(join(root, file)).href)).default;
  for (const [key, entry] of Object.entries(dict)) {
    const before = german.get(key);
    if (before && JSON.stringify(before.entry) !== JSON.stringify(entry)) {
      errors.push(`"${show(key)}" has different translations in ${before.file} and ${file}`);
    }
    german.set(key, { entry, file });
  }
}

for (const [key, { plural, where }] of used) {
  const found = german.get(key);
  if (!found) {
    errors.push(`missing German for "${show(key)}" (${where})`);
    continue;
  }
  const forms = typeof found.entry === 'string' ? [found.entry] : found.entry;
  const english = key.includes(CONTEXT) ? key.split(CONTEXT)[1] : key;
  for (const form of forms) {
    // tn() fills {count} itself; the German singular may spell it out ("ein Issue").
    const want = placeholders(english).split(',').filter((p) => !(plural && p === 'count')).join(',');
    const have = placeholders(form).split(',').filter((p) => !(plural && p === 'count')).join(',');
    if (want !== have) errors.push(`placeholders differ for "${show(key)}" → "${form}" (${found.file})`);
  }
  if (plural && typeof found.entry === 'string') warnings.push(`"${show(key)}" is used with tn() but has a single German form (${found.file})`);
}
const unused = [...german.keys()].filter((key) => !used.has(key));

for (const e of errors) console.error(`error: ${e}`);
if (verbose) for (const w of warnings) console.warn(`warning: ${w}`);
if (verbose && unused.length) console.warn(`German entries without a literal key (translated through a variable, or stale):\n  ${unused.map(show).join('\n  ')}`);
console.log(`i18n: ${used.size} keys in the sources, ${german.size} German entries, ${errors.length} errors, ${warnings.length} warnings, ${unused.length} without literal key${verbose ? '' : ' (--verbose lists them)'}`);
process.exit(errors.length ? 1 : 0);
