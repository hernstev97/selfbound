// Sound values of the UI sounds.
//
// XLR8's own values, designed for this project and picked by ear on a phone. They are under the
// same license as the rest of the repository. Names (core/src/app/cues.ts) and mapping (listen.ts)
// are independent of them; a test (test/sound.test.ts) keeps names and values in sync.
//
// Sound language:
//   Pitches       notes from A major (E5 659, F#5 740, A5 880, C#6 1109, D6 1175, E6 1319 Hz …)
//   Glass         wavetable with soft overtones: bright, but softer than a triangle
//   Warm          wavetable with stronger overtones for low sounds, so they come through phone speakers
//   Wood          short pure tone with a pitch drop, plus a hint of filtered noise
//   Gestures      open/close glide, the low-pass opens or closes along
//
// Structure: @web-kits/audio (MIT), `SoundDefinition`: source, filter, envelope, gain; `layers` mixes several.
import type { SoundDefinition } from '@web-kits/audio';
import type { Cue } from '@xlr8/core';

export const PATCH_NAME = 'xlr8-ui';

const GLAS = [1, 0.1, 0.14, 0.02, 0.04];
const WARM = [1, 0.3, 0.12, 0.05];

/** Pitch jitter per sound in cents, so repeats do not sound mechanical: short sounds more, melodies barely. */
export const JITTER: Record<Cue, number> = {
  tap: 20,
  select: 16,
  toggleOn: 12,
  toggleOff: 12,
  open: 8,
  close: 8,
  tick: 16,
  sliderTick: 8,
  key: 24,
  destructive: 10,
  blocked: 20,
  chirp: 18,
  command: 6,
  copy: 8,
  notification: 4,
  swoosh: 12,
  success: 4,
  error: 4,
  warning: 4,
};

export const SOUNDS = {
  tap: {
    source: { type: 'sine', frequency: { start: 1380, end: 1180 } },
    envelope: { attack: 0.002, decay: 0.018 },
    gain: 0.17,
  },
  select: {
    source: { type: 'wavetable', harmonics: GLAS, frequency: { start: 988, end: 860 } },
    envelope: { attack: 0.001, decay: 0.05 },
    gain: 0.2,
  },
  // two steps up: E5, A5
  toggleOn: {
    layers: [
      { source: { type: 'wavetable', harmonics: GLAS, frequency: 659 }, envelope: { attack: 0.002, decay: 0.04 }, gain: 0.29 },
      { source: { type: 'wavetable', harmonics: GLAS, frequency: 880 }, envelope: { attack: 0.002, decay: 0.07 }, gain: 0.27, delay: 0.035 },
    ],
  },
  // two steps down: F#5, C#5
  toggleOff: {
    layers: [
      { source: { type: 'wavetable', harmonics: GLAS, frequency: 740 }, envelope: { attack: 0.002, decay: 0.04 }, gain: 0.24 },
      { source: { type: 'wavetable', harmonics: GLAS, frequency: 554 }, envelope: { attack: 0.002, decay: 0.07 }, gain: 0.26, delay: 0.035 },
    ],
  },
  open: {
    source: { type: 'wavetable', harmonics: WARM, frequency: { start: 300, end: 580 } },
    filter: { type: 'lowpass', frequency: 1500, envelope: { attack: 0.06, peak: 3400, decay: 0.1 } },
    envelope: { attack: 0.008, decay: 0.12 },
    gain: 0.19,
  },
  close: {
    source: { type: 'wavetable', harmonics: WARM, frequency: { start: 540, end: 290 } },
    filter: { type: 'lowpass', frequency: 1300, envelope: { attack: 0, peak: 3000, decay: 0.09 } },
    envelope: { attack: 0.005, decay: 0.1 },
    gain: 0.21,
  },
  tick: {
    source: { type: 'sine', frequency: 1480 },
    envelope: { attack: 0.0015, decay: 0.014 },
    gain: 0.11,
  },
  sliderTick: {
    layers: [
      { source: { type: 'sine', frequency: { start: 1250, end: 880 } }, envelope: { decay: 0.014 }, gain: 0.07 },
      { source: { type: 'noise', color: 'white' }, filter: { type: 'bandpass', frequency: 2600, resonance: 2 }, envelope: { decay: 0.014 }, gain: 0.15 },
    ],
  },
  destructive: {
    layers: [
      { source: { type: 'wavetable', harmonics: WARM, frequency: { start: 277, end: 156 } }, filter: { type: 'lowpass', frequency: 1200 }, envelope: { attack: 0.003, decay: 0.12 }, gain: 0.3 },
      { source: { type: 'noise', color: 'pink' }, filter: { type: 'lowpass', frequency: 900 }, envelope: { decay: 0.045 }, gain: 0.07 },
    ],
  },
  key: {
    layers: [
      { source: { type: 'sine', frequency: { start: 1150, end: 950 } }, envelope: { attack: 0.001, decay: 0.026 }, gain: 0.13 },
      { source: { type: 'noise', color: 'pink' }, filter: { type: 'highpass', frequency: 2400 }, envelope: { decay: 0.008 }, gain: 0.05 },
    ],
  },
  // three notes up: A5, C#6, E6
  success: {
    layers: [
      { source: { type: 'wavetable', harmonics: GLAS, frequency: 880 }, envelope: { attack: 0.003, decay: 0.1 }, gain: 0.17 },
      { source: { type: 'wavetable', harmonics: GLAS, frequency: 1109 }, envelope: { attack: 0.003, decay: 0.12 }, gain: 0.15, delay: 0.055 },
      { source: { type: 'wavetable', harmonics: GLAS, frequency: 1319 }, envelope: { attack: 0.003, decay: 0.22 }, gain: 0.14, delay: 0.11 },
    ],
  },
  // the same low note twice, slightly rough from light FM
  error: {
    layers: [
      { source: { type: 'sine', frequency: 233, fm: { ratio: 2, depth: 60 } }, filter: { type: 'lowpass', frequency: 1200 }, envelope: { attack: 0.003, decay: 0.09 }, gain: 0.23 },
      { source: { type: 'sine', frequency: 233, fm: { ratio: 2, depth: 60 } }, filter: { type: 'lowpass', frequency: 1000 }, envelope: { attack: 0.003, decay: 0.18 }, gain: 0.21, delay: 0.11 },
    ],
  },
  // two notes, the second a semitone lower: E5, D#5
  warning: {
    layers: [
      { source: { type: 'wavetable', harmonics: GLAS, frequency: 659 }, filter: { type: 'lowpass', frequency: 2600 }, envelope: { attack: 0.003, decay: 0.12 }, gain: 0.155 },
      { source: { type: 'wavetable', harmonics: GLAS, frequency: 622 }, filter: { type: 'lowpass', frequency: 2600 }, envelope: { attack: 0.003, decay: 0.18 }, gain: 0.14, delay: 0.09 },
    ],
  },
  // two bright dabs up: C#6, F#6
  copy: {
    layers: [
      { source: { type: 'sine', frequency: 1109 }, envelope: { decay: 0.016 }, gain: 0.16 },
      { source: { type: 'sine', frequency: 1480 }, envelope: { decay: 0.018 }, gain: 0.13, delay: 0.036 },
    ],
  },
  // two soft notes up that ring on: E5, A5
  notification: {
    layers: [
      { source: { type: 'wavetable', harmonics: GLAS, frequency: 659 }, envelope: { attack: 0.01, decay: 0.28, sustain: 0.03, release: 0.1 }, gain: 0.1 },
      { source: { type: 'wavetable', harmonics: GLAS, frequency: 880 }, envelope: { attack: 0.01, decay: 0.26, sustain: 0.02, release: 0.1 }, gain: 0.085, delay: 0.13 },
    ],
  },
  swoosh: {
    layers: [
      { source: { type: 'sine', frequency: { start: 340, end: 1800 } }, envelope: { attack: 0.01, decay: 0.12, sustain: 0, release: 0.04 }, gain: 0.11 },
      { source: { type: 'noise', color: 'pink' }, filter: { type: 'bandpass', frequency: 500, resonance: 2, envelope: { attack: 0.12, peak: 3500, decay: 0.05 } }, envelope: { attack: 0.06, decay: 0.12 }, gain: 0.09 },
    ],
  },
  chirp: {
    source: { type: 'sine', frequency: { start: 1109, end: 1480 } },
    envelope: { decay: 0.028 },
    gain: 0.08,
  },
  // two quick notes down: D6, A5
  command: {
    layers: [
      { source: { type: 'wavetable', harmonics: GLAS, frequency: 1175 }, envelope: { attack: 0.001, decay: 0.03 }, gain: 0.135 },
      { source: { type: 'wavetable', harmonics: GLAS, frequency: 880 }, envelope: { attack: 0.001, decay: 0.07 }, gain: 0.15, delay: 0.03 },
    ],
  },
  blocked: {
    source: { type: 'wavetable', harmonics: [1, 0.4, 0.15, 0.05], frequency: { start: 196, end: 165 } },
    filter: { type: 'lowpass', frequency: 800 },
    envelope: { attack: 0.004, decay: 0.065 },
    gain: 0.18,
  },
} as const satisfies Record<Cue, SoundDefinition>;
