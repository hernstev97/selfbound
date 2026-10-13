// Bundled VS Code themes. Originals with their license in app/src/themes/<id>/ (sources:
// app/src/themes/SOURCES.md). Each theme.json is its own chunk, loaded only when the theme is
// chosen or previewed. Swatches for the picker: swatches.ts.
import { BUILTIN, type BuiltinTheme } from '../../themes/list.ts';
import { readTheme, type VsTheme } from './vscode.ts';

export { BUILTIN, type BuiltinTheme } from '../../themes/list.ts';

const FILES = import.meta.glob<string>('../../themes/*/theme.json', { query: '?raw', import: 'default' });

export function builtin(id: string): BuiltinTheme | undefined {
  return BUILTIN.find((t) => t.id === id);
}

/** Loads and parses a bundled theme (null = unknown). */
export async function loadBuiltin(id: string): Promise<VsTheme | null> {
  const meta = builtin(id);
  const load = FILES[`../../themes/${id}/theme.json`];
  if (!meta || !load) return null;
  return readTheme(await load(), { name: meta.name, typeHint: meta.type });
}
