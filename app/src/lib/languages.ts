// Code block languages: names for the language picker and which highlight.js grammar colors them.
// Small and without highlight.js, so the renderer and editor know the list before the highlighter
// is loaded.
import { msg, t } from '@selfbound/core/i18n';

export interface Language {
  /** What is written after the fence ("```typescript") */
  id: string;
  label: string;
  /** highlight.js grammar (see highlight.ts) */
  grammar: string;
  /** Other spellings that map to this language */
  aliases: string[];
}

export const LANGUAGES: Language[] = [
  { id: 'typescript', label: 'TypeScript', grammar: 'typescript', aliases: ['ts', 'tsx'] },
  { id: 'javascript', label: 'JavaScript', grammar: 'javascript', aliases: ['js', 'jsx', 'mjs', 'cjs'] },
  // Svelte and Vue have no highlight.js grammar of their own; xml fits as an HTML template.
  { id: 'svelte', label: 'Svelte', grammar: 'xml', aliases: [] },
  { id: 'vue', label: 'Vue', grammar: 'xml', aliases: [] },
  { id: 'html', label: 'HTML', grammar: 'xml', aliases: [] },
  { id: 'xml', label: 'XML', grammar: 'xml', aliases: [] },
  { id: 'css', label: 'CSS', grammar: 'css', aliases: [] },
  { id: 'json', label: 'JSON', grammar: 'json', aliases: ['jsonc', 'json5'] },
  { id: 'bash', label: 'Bash', grammar: 'bash', aliases: ['sh', 'shell', 'zsh', 'console'] },
  { id: 'sql', label: 'SQL', grammar: 'sql', aliases: ['postgresql', 'sqlite'] },
  { id: 'python', label: 'Python', grammar: 'python', aliases: ['py'] },
  { id: 'kotlin', label: 'Kotlin', grammar: 'kotlin', aliases: ['kt'] },
  { id: 'yaml', label: 'YAML', grammar: 'yaml', aliases: ['yml'] },
  { id: 'markdown', label: 'Markdown', grammar: 'markdown', aliases: ['md'] },
  { id: 'diff', label: 'Diff', grammar: 'diff', aliases: ['patch'] },
];

/** Name for "no language", in English; show it with plainLabel() or t(PLAIN_LABEL). */
export const PLAIN_LABEL = msg('Plain text');
export const plainLabel = () => t(PLAIN_LABEL);

const BY_WORD = new Map<string, Language>();
for (const lang of LANGUAGES) for (const word of [lang.id, ...lang.aliases]) BY_WORD.set(word, lang);

/** First word of the info string, lower case ("TS title=x" → "ts"). */
export const langWord = (info: string | undefined) => (info ?? '').trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';

/** Known language for a code block's info string, or null. */
export const languageFor = (info: string | undefined): Language | null => BY_WORD.get(langWord(info)) ?? null;

/** Display name: known language, otherwise the info string itself; "Plain text" without one. */
export function languageLabel(info: string | undefined): string {
  const word = langWord(info);
  if (!word) return plainLabel();
  return BY_WORD.get(word)?.label ?? word;
}
