// UI sounds, entry point: loaded only after startup (main.ts), never before.
//
//   app.cues ──▶ Player ──▶ Gate (pacing) ──▶ Engine (@web-kits/audio) ──▶ speakers
//      ▲
//      ├─ core: done, copied, error, menu choice, J/K … (core/src/app/*)
//      ├─ listen.ts: clicks, keys, typing, sliders in the DOM
//      └─ here: opening and closing of menus, dialogs, peek (read from the state)
//
// Settings (Settings › General): `prefs.sound` and `prefs.soundVolume`, per device.
import type { App, Cue, Slice } from '@selfbound/core';
import { Engine } from './engine.ts';
import { lastPointerAt, listen } from './listen.ts';

/** Shortly after a mouse input (press, release, click), its sound (`tap` etc.) also covers the open/close */
const POINTER_QUIET_MS = 160;
/** If a choice just sounded (menu item, success …), the close right after it stays silent */
const CHOICE_QUIET_MS = 150;
const CHOICES = new Set<Cue>(['select', 'command', 'chirp', 'toggleOn', 'toggleOff', 'destructive', 'success']);

/** Read open/close from a state: false → true = open, true → false = close. */
function edge<T>(slice: Slice<T>, isOpen: (value: T) => boolean, fire: (cue: 'open' | 'close') => void) {
  let was = isOpen(slice.get());
  return slice.subscribe(() => {
    const now = isOpen(slice.get());
    if (now !== was) fire(now ? 'open' : 'close');
    was = now;
  });
}

export function startSound(app: App): () => void {
  const engine = new Engine();
  const disposers: (() => void)[] = [];
  const prefs = () => app.prefs.state.get();
  engine.setVolume(prefs().soundVolume);

  // Play what gets reported (core, listeners, state).
  // Test hook (only where `__selfbound` exists): loaded, what actually played, AudioContext state.
  const hooks = globalThis.__selfbound;
  const played: string[] = [];
  if (hooks) hooks.sound = { played, state: () => engine.state };
  let lastChoiceAt = -Infinity;
  disposers.push(
    app.cues.subscribe((event) => {
      if (CHOICES.has(event.cue)) lastChoiceAt = performance.now();
      if (prefs().sound && engine.play(event)) played.push(event.cue);
    }),
  );

  // Volume applies live; sound turned back on: a "swoosh" as a sign.
  let wasOn = prefs().sound;
  let volume = prefs().soundVolume;
  disposers.push(
    app.prefs.state.subscribe(() => {
      const { sound, soundVolume } = prefs();
      if (soundVolume !== volume) engine.setVolume((volume = soundVolume));
      if (sound && !wasOn) app.cues.emit('swoosh');
      wasOn = sound;
    }),
  );

  disposers.push(listen(app, () => engine.unlock()));

  const gesture = (cue: 'open' | 'close') => {
    const now = performance.now();
    if (now - lastPointerAt < POINTER_QUIET_MS) return;
    if (cue === 'close' && now - lastChoiceAt < CHOICE_QUIET_MS) return;
    app.cues.emit(cue);
  };
  disposers.push(
    edge(app.palette.state, (s) => s !== null, gesture),
    edge(app.menu.state, (s) => s !== null, gesture),
    edge(app.create.state, (s) => s.open, gesture),
    edge(app.newTeamOpen, (s) => s, gesture),
    edge(app.displayOpen, (s) => s, gesture),
    edge(app.detail.peekOpen, (s) => s, gesture),
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}
