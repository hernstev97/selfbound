// Sound listener. It listens on the window (capture, so before everyone else) for clicks, keys and
// input, and reports the matching sound to `app.cues`; the player (index.ts) plays it. Core reports
// what happens in the logic on its own (done, copied, error, menu choice, J/K).
//
// Mapping by the classes and roles of the XLR8 UI. `data-sound="<sound>"` (or `none`) assigns any
// element explicitly.
//
//   Toggles (checkbox, switch, check mark in rows)          toggleOn / toggleOff by the previous state
//   Dangerous buttons (`.danger`, discard via data-sound)    destructive
//   Close (label "Close", dialog backdrop)                   close
//   Segments (`.seg`), rows, cards, group headers            select
//   Close a toast, "Remove …" (×)                            chirp
//   Copy in a code block                                     copy
//   other buttons, links, sidebar                            tap
//   disabled buttons                                         blocked
//   typing in editors and text fields                        key (deleting lower)
//   sliders                                                  sliderTick (higher to the right)
// Menus and the command menu (`.menu-item`) are reported by core itself (palette.choose, menu.choose).
import { CUES, type App, type Cue } from '@xlr8/core';
import { t } from '@xlr8/core/i18n';

/** No sound from here: core reports menu choices itself. */
const OWN_CUE = '.menu-item';
const INTERACTIVE = '[data-sound], button, a[href], [role="button"], [role="switch"], [role="checkbox"], input[type="checkbox"], input[type="radio"], label, .row, .card, .inbox-row, .group-row, .column-head';
/** Fields that take typing (editor, title, comment, quick search …) */
const TEXT_ENTRY = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]), textarea, [contenteditable=""], [contenteditable="true"]';
/** Typing in these fields stays silent: command menu and search only filter, they write nothing */
const QUIET_FIELDS = '.palette, [data-sound="none"]';

export interface Pick {
  cue: Cue;
  step?: number;
}

function isOn(el: Element) {
  if (el instanceof HTMLInputElement) return el.checked;
  return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.classList.contains('on') || el.classList.contains('i-check');
}

const NAMES = new Set<string>(CUES);

/** Selectors for close and remove buttons by their aria-label, in English and the active language (built on first use). */
let labelSelectors: { close: string; remove: string } | null = null;
function selectors() {
  const words = (en: string) => [...new Set([en, t(en)])];
  return (labelSelectors ??= {
    close: [...words('Close').map((w) => `[aria-label="${w.replace(/"/g, '')}"]`), '[data-testid$="-close"]'].join(', '),
    remove: ['.toast-close', ...words('Remove').map((w) => `[aria-label*="${w.replace(/"/g, '')}" i]`)].join(', '),
  });
}

function classify(el: HTMLElement): Pick | null {
  const named = el.dataset.sound;
  if (named === 'none') return null;
  if (named && NAMES.has(named)) return { cue: named as Cue };

  if (el.matches('input[type="checkbox"], input[type="radio"], [role="switch"], [role="checkbox"], [aria-pressed], [data-cell="check"]')) return { cue: isOn(el) ? 'toggleOff' : 'toggleOn' };
  if (el.matches('.danger, .danger-fill')) return { cue: 'destructive' };
  if (el.matches('.codecopy')) return { cue: 'copy' };
  if (el.matches(selectors().remove)) return { cue: 'chirp' };
  if (el.matches(selectors().close)) return { cue: 'close' };
  if (el.matches('.seg button, .row, .card, .inbox-row, .group-row, .column-head')) return { cue: 'select' };
  if (el.matches('button, a[href], [role="button"]')) return { cue: 'tap' };
  return null;
}

/** Sound for a target (click or Enter/Space); null = none. */
export function soundFor(target: Element): Pick | null {
  // Click on a dialog or menu backdrop: it closes, so the close sound.
  if (target instanceof HTMLElement && target.classList.contains('overlay')) return { cue: 'close' };
  if (target.closest(OWN_CUE)) return null;
  const labeled = (target.closest('label') as HTMLLabelElement | null)?.control ?? target;
  if (labeled.closest(TEXT_ENTRY)) return null;
  let el = labeled.closest<HTMLElement>(INTERACTIVE);
  while (el) {
    if (el.matches(':disabled, [aria-disabled="true"], [data-disabled]')) return { cue: 'blocked' };
    const pick = classify(el);
    if (pick) return pick;
    el = el.parentElement?.closest<HTMLElement>(INTERACTIVE) ?? null;
  }
  return null;
}

/** Time of the last left-button mouse input (ms; press, release, click): open/close then plays no second sound. */
export let lastPointerAt = -Infinity;

/** Listens to window events; returns the unsubscribe function. */
export function listen(app: App, unlock: () => void): () => void {
  const emit = (pick: Pick | null) => pick && app.cues.emit(pick.cue, pick.step);

  const onPointerDown = (event: PointerEvent) => {
    unlock();
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    lastPointerAt = performance.now();
    emit(soundFor(event.target));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    unlock();
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.repeat || !(event.target instanceof Element)) return;
    // Text fields only type; in lists and menus core decides (Enter opens, picks …).
    if (event.target.matches(TEXT_ENTRY) || event.target.closest('[data-testid="list"]')) return;
    emit(soundFor(event.target));
  };

  const onInput = (event: Event) => {
    if (!event.isTrusted) return;
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    if (el instanceof HTMLInputElement && el.type === 'range') {
      const min = Number(el.min || 0);
      const max = Number(el.max || 100);
      const at = max === min ? 0 : (Number(el.value) - min) / (max - min);
      return void app.cues.emit('sliderTick', Math.round(at * 16));
    }
    const typing = el.matches(TEXT_ENTRY) || el.isContentEditable;
    if (!typing || el.closest(QUIET_FIELDS) || (event as InputEvent).isComposing) return;
    const deleting = (event as InputEvent).inputType?.startsWith('delete') ?? false;
    app.cues.emit('key', deleting ? -5 : 0);
  };

  const onPointerEnd = (event: PointerEvent | MouseEvent) => {
    if (event.button === 0) lastPointerAt = performance.now();
  };

  addEventListener('pointerdown', onPointerDown, true);
  addEventListener('pointerup', onPointerEnd, true);
  addEventListener('click', onPointerEnd, true);
  addEventListener('keydown', onKeyDown, true);
  addEventListener('input', onInput, true);
  return () => {
    removeEventListener('pointerdown', onPointerDown, true);
    removeEventListener('pointerup', onPointerEnd, true);
    removeEventListener('click', onPointerEnd, true);
    removeEventListener('keydown', onKeyDown, true);
    removeEventListener('input', onInput, true);
  };
}
