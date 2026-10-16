// Keyboard shortcuts: an event becomes a text like "mod+k", "shift+v", "?" or "g a".
import { t } from './i18n.ts';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Punctuation with Ctrl/⌘ by physical code, because Shift changes it depending on the layout (Ctrl Shift . ). */
const CODE_KEYS: Record<string, string> = { Period: '.', Comma: ',', Slash: '/', Backslash: '\\' };

export function eventCombo(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string {
  const mod = e.ctrlKey || e.metaKey;
  let key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  if (mod && e.code && CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  // On the Mac, Alt changes the characters (Alt+V = √): take the code then.
  if (e.altKey && e.code?.startsWith('Key')) key = e.code.slice(3).toLowerCase();
  if (key === ' ') key = 'space';
  if (key === 'del') key = 'delete';
  const parts: string[] = [];
  if (mod) parts.push('mod');
  if (e.altKey) parts.push('alt');
  // Shift only for letters, space, named keys and shortcuts with Ctrl; "?" is already "shift+/".
  if (e.shiftKey && (e.key.length > 1 || key === 'space' || /^[a-z]$/i.test(e.key) || (mod && CODE_KEYS[e.code]))) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

const KEY_SYMBOLS: Record<string, string> = {
  shift: '⇧',
  arrowdown: '↓',
  arrowup: '↑',
  arrowleft: '←',
  arrowright: '→',
  enter: 'Enter',
  escape: 'Esc',
};

/** Display name of one key; words translate at call time. */
function keyName(part: string): string {
  switch (part) {
    case 'mod':
      return IS_MAC ? '⌘' : t('Ctrl');
    case 'alt':
      return IS_MAC ? '⌥' : 'Alt';
    case 'space':
      return t('Space');
    case 'backspace':
      return IS_MAC ? '⌫' : t('Backspace');
    case 'delete':
      return t('Del');
  }
  return KEY_SYMBOLS[part] ?? part.toUpperCase();
}

/** "mod+shift+z" → "Ctrl ⇧ Z", "g a" → "G then A" */
export function formatShortcut(combo: string): string {
  return combo
    .split(' ')
    .map((step) => step.split('+').map(keyName).join(' '))
    .join(` ${t('then')} `);
}

/** Single keys for key caps: "mod+k" → ["Ctrl", "K"] */
export function shortcutKeys(combo: string): string[] {
  return combo.split(' ').flatMap((step, i) => [...(i > 0 ? [t('then')] : []), ...step.split('+').map(keyName)]);
}

export function isEditable(target: EventTarget | null) {
  if (!target || typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}
