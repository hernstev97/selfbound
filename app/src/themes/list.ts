// List of the bundled VS Code themes, without the files: license and source in each folder and in
// SOURCES.md. Loading: app/src/lib/look/builtin.ts. No Vite dependencies, so
// app/scripts/theme-swatches.ts can read it with Node.
import type { ThemeType } from '../lib/look/vscode.ts';

export interface BuiltinTheme {
  id: string;
  name: string;
  type: ThemeType;
  author: string;
}

export const BUILTIN: BuiltinTheme[] = [
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', type: 'dark', author: 'Catppuccin' },
  { id: 'catppuccin-macchiato', name: 'Catppuccin Macchiato', type: 'dark', author: 'Catppuccin' },
  { id: 'catppuccin-frappe', name: 'Catppuccin Frappé', type: 'dark', author: 'Catppuccin' },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', type: 'light', author: 'Catppuccin' },
  { id: 'darcula', name: 'Darcula', type: 'dark', author: 'Youngrok Kim' },
  { id: 'dracula', name: 'Dracula', type: 'dark', author: 'Dracula Theme' },
  { id: 'one-dark-pro', name: 'One Dark Pro', type: 'dark', author: 'Binaryify' },
  { id: 'tokyo-night', name: 'Tokyo Night', type: 'dark', author: 'enkia' },
  { id: 'tokyo-night-light', name: 'Tokyo Night Light', type: 'light', author: 'enkia' },
  { id: 'nord', name: 'Nord', type: 'dark', author: 'Arctic Ice Studio' },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', type: 'dark', author: 'jdinhlife' },
  { id: 'gruvbox-light', name: 'Gruvbox Light', type: 'light', author: 'jdinhlife' },
  { id: 'solarized-dark', name: 'Solarized Dark', type: 'dark', author: 'Microsoft (VS Code)' },
  { id: 'solarized-light', name: 'Solarized Light', type: 'light', author: 'Microsoft (VS Code)' },
  { id: 'github-dark', name: 'GitHub Dark', type: 'dark', author: 'GitHub' },
  { id: 'github-light', name: 'GitHub Light', type: 'light', author: 'GitHub' },
];
