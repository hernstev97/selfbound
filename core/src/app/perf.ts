// Measurement overlay (?perf=1): time from the input event until after the next frame.
import { Slice } from '../observable.ts';

export interface PerfState {
  enabled: boolean;
  last: { label: string; ms: number } | null;
  /** Last 50 measurements for the measurement run */
  history: { label: string; ms: number }[];
}

export function afterNextPaint(cb: () => void) {
  if (typeof requestAnimationFrame === 'undefined') return void setTimeout(cb, 0);
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => cb();
    channel.port2.postMessage(null);
  });
}

export class Perf {
  readonly state: Slice<PerfState>;

  constructor(enabled: boolean) {
    this.state = new Slice<PerfState>({ enabled, last: null, history: [] });
  }

  toggle() {
    const s = this.state.get();
    this.state.set({ ...s, enabled: !s.enabled });
  }

  measure(timeStamp: number, label: string) {
    if (!this.state.get().enabled) return;
    afterNextPaint(() => {
      const ms = performance.now() - timeStamp;
      const s = this.state.get();
      this.state.set({ enabled: true, last: { label, ms }, history: [...s.history.slice(-49), { label, ms }] });
    });
  }
}
