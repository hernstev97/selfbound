// Sounds: core reports WHAT happened ("done", "copied", "error"), the UI decides whether and how it
// sounds (app/src/lib/sound). That keeps core free of audio, and without listeners (tests, server)
// an event costs nothing.

/** Sound names, the same as in the `selfbound-ui` patch (app/src/lib/sound/patch.ts) */
export const CUES = ['tap', 'select', 'toggleOn', 'toggleOff', 'open', 'close', 'tick', 'sliderTick', 'destructive', 'key', 'success', 'error', 'warning', 'copy', 'notification', 'swoosh', 'chirp', 'command', 'blocked'] as const;
export type Cue = (typeof CUES)[number];

export interface CueEvent {
  cue: Cue;
  /** Position in a list (menu item, result): higher entries sound slightly higher */
  step?: number;
}

export class Cues {
  #listeners = new Set<(event: CueEvent) => void>();

  emit(cue: Cue, step?: number) {
    if (this.#listeners.size === 0) return;
    const event: CueEvent = step === undefined ? { cue } : { cue, step };
    for (const listener of [...this.#listeners]) listener(event);
  }

  subscribe(listener: (event: CueEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }
}
