// Sound pacing: with a held key (J/K, arrows, typing) and fast clicking, events fire 30 times per
// second. If each started a sound, voices would pile up and clip. Three rules, all pure timing
// (testable without audio):
//   1. Each sound has a minimum gap to itself (GAP): a held key = even ticking.
//   2. Soft repeating sounds (tap, key, tick, sliderTick, select) may start only MAX_SOFT voices
//      together per WINDOW_MS; notices (success, error, open …) do not count and are never crowded out.
//   3. Behind everything sits a limiter in the audio path (engine.ts) as a net for overlapping notices.
import type { Cue } from '@xlr8/core';

/** Minimum gap of a sound to itself in ms; missing entries use DEFAULT_GAP. */
export const GAP: Partial<Record<Cue, number>> = {
  tap: 65,
  key: 42,
  tick: 55,
  sliderTick: 28,
  select: 55,
  blocked: 160,
  chirp: 70,
};
export const DEFAULT_GAP = 90;

/** Repeating sounds that can pile up with a held key */
const SOFT = new Set<Cue>(['tap', 'key', 'tick', 'sliderTick', 'select']);
export const MAX_SOFT = 4;
export const WINDOW_MS = 120;

export class Gate {
  #last = new Map<Cue, number>();
  #soft: number[] = [];

  /** May `cue` play now (`now` in ms)? Records the start if so. */
  allow(cue: Cue, now: number): boolean {
    const last = this.#last.get(cue);
    if (last !== undefined && now - last < (GAP[cue] ?? DEFAULT_GAP)) return false;
    if (SOFT.has(cue)) {
      while (this.#soft.length && now - this.#soft[0] >= WINDOW_MS) this.#soft.shift();
      if (this.#soft.length >= MAX_SOFT) return false;
      this.#soft.push(now);
    }
    this.#last.set(cue, now);
    return true;
  }
}
