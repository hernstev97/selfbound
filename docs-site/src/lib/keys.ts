// Key combos in the app's notation ("mod+shift+z", "g i", "?") as key caps.
// `mod` is Ctrl, or ⌘ on a Mac: Kbd renders both and a small script picks one.

export interface Cap {
  label: string;
  /** Different label on a Mac */
  mac?: string;
  /** Screen reader name when the label is a symbol */
  name?: string;
  /** Screen reader name of the Mac label */
  macName?: string;
}

const NAMED: Record<string, Cap> = {
  mod: { label: 'Ctrl', mac: '⌘', name: 'Control', macName: 'Command' },
  alt: { label: 'Alt', mac: '⌥', name: 'Alt', macName: 'Option' },
  shift: { label: '⇧', name: 'Shift' },
  enter: { label: 'Enter' },
  escape: { label: 'Esc' },
  space: { label: 'Space' },
  tab: { label: 'Tab' },
  backspace: { label: 'Backspace', mac: '⌫', macName: 'Delete' },
  delete: { label: 'Del' },
  home: { label: 'Home' },
  end: { label: 'End' },
  arrowup: { label: '↑', name: 'Up arrow' },
  arrowdown: { label: '↓', name: 'Down arrow' },
  arrowleft: { label: '←', name: 'Left arrow' },
  arrowright: { label: '→', name: 'Right arrow' },
};

/** "g i" → [[G], [I]]: each inner list is one step pressed together; steps follow each other. */
export function combo(keys: string): Cap[][] {
  return keys
    .trim()
    .split(' ')
    .map((step) => (step === '+' ? ['+'] : step.split('+')).map((part) => NAMED[part] ?? { label: part.length === 1 ? part.toUpperCase() : part }));
}
