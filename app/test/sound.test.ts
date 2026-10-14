import { CUES } from '@selfbound/core';
import { describe, expect, it } from 'vitest';
import { detuneOf } from '../src/lib/sound/engine.ts';
import { DEFAULT_GAP, GAP, Gate, MAX_SOFT, WINDOW_MS } from '../src/lib/sound/gate.ts';
import { JITTER, SOUNDS } from '../src/lib/sound/patch.ts';

describe('sound values (own selfbound-ui patch)', () => {
  it('have a sound and a jitter for every core cue, and nothing beyond', () => {
    expect(Object.keys(SOUNDS).sort()).toEqual([...CUES].sort());
    expect(Object.keys(JITTER).sort()).toEqual([...CUES].sort());
    expect(CUES).toHaveLength(19);
  });

  it('are gentle: every layer at most 0.35 gain and at most 0.55 s long', () => {
    for (const [name, sound] of Object.entries(SOUNDS)) {
      type Flat = { gain?: number; delay?: number; envelope?: { attack?: number; decay?: number; release?: number } };
      const layers: Flat[] = 'layers' in sound ? [...sound.layers] : [sound];
      for (const layer of layers) {
        expect(layer.gain ?? 0.5, name).toBeLessThanOrEqual(0.35);
        const env = layer.envelope;
        const length = (layer.delay ?? 0) + (env?.attack ?? 0) + (env?.decay ?? 0.5) + (env?.release ?? 0);
        expect(length, name).toBeLessThanOrEqual(0.55);
      }
    }
  });
});

describe('pacing (a held key does not pile up)', () => {
  /** Auto-repeat: one event every 33 ms for `seconds` seconds */
  function held(cue: (typeof CUES)[number], seconds: number, every = 33) {
    const gate = new Gate();
    const starts: number[] = [];
    for (let t = 0; t < seconds * 1000; t += every) if (gate.allow(cue, t)) starts.push(t);
    return starts;
  }

  it('a held J (tap) sounds evenly, never closer than the minimum gap', () => {
    const starts = held('tap', 2);
    expect(starts.length).toBeGreaterThan(10);
    expect(starts.length).toBeLessThanOrEqual(Math.ceil(2000 / GAP.tap!) + 1);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(GAP.tap!);
  });

  it('typing (key) stays audibly dense, but below the input rate', () => {
    const starts = held('key', 1, 20);
    expect(starts.length).toBeLessThan(1000 / 20);
    expect(starts.length).toBeGreaterThan(10);
  });

  it('soft repeating sounds together: at most MAX_SOFT voices per window', () => {
    const gate = new Gate();
    const soft = ['tap', 'key', 'tick', 'sliderTick', 'select'] as const;
    const starts: number[] = [];
    for (let t = 0; t < 3000; t += 7) for (const cue of soft) if (gate.allow(cue, t)) starts.push(t);
    for (const at of starts) expect(starts.filter((t) => t >= at && t < at + WINDOW_MS).length).toBeLessThanOrEqual(MAX_SOFT);
  });

  it('notices are not crowded out by repeating sounds, but duplicates are dropped', () => {
    const gate = new Gate();
    for (let t = 0; t < 100; t += 10) gate.allow('tap', t);
    expect(gate.allow('success', 100)).toBe(true);
    expect(gate.allow('success', 100 + DEFAULT_GAP - 1)).toBe(false);
    expect(gate.allow('success', 100 + DEFAULT_GAP)).toBe(true);
    expect(gate.allow('error', 105)).toBe(true);
  });
});

describe('pitch', () => {
  const none = () => 0.5; // random value in the middle = no jitter
  it('steps raise by 55 cents, limited to ±16 steps', () => {
    expect(detuneOf({ cue: 'select', step: 3 }, none)).toBe(165);
    expect(detuneOf({ cue: 'key', step: -5 }, none)).toBe(-275);
    expect(detuneOf({ cue: 'sliderTick', step: 99 }, none)).toBe(16 * 55);
    expect(detuneOf({ cue: 'tap' }, none)).toBe(0);
  });
  it('jitter stays within the sound\'s limits', () => {
    for (let i = 0; i < 200; i++) expect(Math.abs(detuneOf({ cue: 'tap' }))).toBeLessThanOrEqual(JITTER.tap);
  });
});
