// Sound synthesis. This file is the only place that knows @web-kits/audio; it lives in the lazily
// loaded `lib/sound` chunk and reaches the page only after startup. The AudioContext is created on
// the first user gesture (browser rule, otherwise a warning and silence), not on load.
import { definePatch, getMasterBus, setMasterVolume, type AudioPatch } from '@web-kits/audio';
import type { Cue, CueEvent } from '@xlr8/core';
import { Gate } from './gate.ts';
import { JITTER, PATCH_NAME, SOUNDS } from './patch.ts';

/** One step in cents per `step` (menu items, sliders) */
const CENTS_PER_STEP = 55;
const MAX_STEP = 16;

export function jitter(cents: number, random = Math.random) {
  return (random() * 2 - 1) * cents;
}

/** Pitch shift of an event in cents: step × 55 plus the sound's jitter. */
export function detuneOf(event: CueEvent, random = Math.random) {
  const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, event.step ?? 0));
  return step * CENTS_PER_STEP + jitter(JITTER[event.cue], random);
}

export class Engine {
  readonly #patch: AudioPatch = definePatch({ name: PATCH_NAME, sounds: SOUNDS as never });
  readonly #gate = new Gate();
  #awake = false;
  #volume = 0.5;

  setVolume(volume: number) {
    this.#volume = volume;
    if (this.#awake) setMasterVolume(volume);
  }

  /**
   * Create the AudioContext and put a limiter before the output: even when notices overlap (success
   * and copy at the same moment), nothing clips. Only after a user gesture.
   */
  #wake(): boolean {
    if (this.#awake) return true;
    if (typeof navigator !== 'undefined' && navigator.userActivation && !navigator.userActivation.hasBeenActive) return false;
    const master = getMasterBus();
    const ctx = master.context;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    master.disconnect();
    master.connect(limiter);
    limiter.connect(ctx.destination);
    master.gain.value = this.#volume;
    this.#awake = true;
    return true;
  }

  /** First user gesture: create the context now so the first real sound plays without delay. */
  unlock() {
    this.#wake();
  }

  /** AudioContext state for tests ('none' = no gesture yet, no context) */
  get state(): string {
    return this.#awake ? getMasterBus().context.state : 'none';
  }

  /** Plays the sound; false if it was suppressed (pacing, background tab, no gesture yet). */
  play(event: CueEvent): boolean {
    if (typeof document !== 'undefined' && document.hidden) return false;
    if (!this.#gate.allow(event.cue, performance.now())) return false;
    if (!this.#wake()) return false;
    this.#patch.play(event.cue satisfies Cue, { detune: detuneOf(event), velocity: 0.9 + Math.random() * 0.1 });
    return true;
  }
}
