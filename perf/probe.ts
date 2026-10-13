// Measurement probe that runs before any page script (page.addInitScript).
// The function is passed into the page as source text; it must not use anything from outside.
//
// Measured from the input event (keydown/pointerdown, event.timeStamp) until after the next
// frame in which the expected result is in the DOM: rAF + MessageChannel.
// This is framework-neutral: only what arrives in the DOM counts.
//
// Start marks: "shell" = sidebar visible, "list" = first issue row visible.

export function installProbe() {
  const now = () => performance.now();
  const afterPaint = (cb: (t: number) => void) =>
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => cb(now());
      channel.port2.postMessage(null);
    });

  const state: any = { pending: null, events: [], loaf: [], marks: {} };
  const watch = [
    ['shell', '[data-testid="sidebar"]'],
    ['list', '[data-testid="issue-row"]'],
  ];

  function check() {
    const p = state.pending;
    if (!p) return;
    for (const name of Object.keys(p.preds)) {
      if (p.matched[name] !== undefined) continue;
      let ok = false;
      try {
        ok = !!p.preds[name](p.ctx);
      } catch {
        ok = false;
      }
      if (ok) {
        p.matched[name] = now();
        afterPaint((t) => {
          p.painted[name] = t;
          if (Object.keys(p.painted).length === Object.keys(p.preds).length) p.resolve();
        });
      }
    }
  }

  const observer = new MutationObserver(() => {
    for (const [name, selector] of watch) {
      if (!(name in state.marks) && document.querySelector(selector)) {
        state.marks[name] = null;
        afterPaint((t) => (state.marks[name] = t));
      }
    }
    check();
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  const onInput = (e: Event) => {
    const p = state.pending;
    if (p && p.start === null && !p.manual) p.start = e.timeStamp;
    // Check even without a DOM change (e.g. when the list does not change).
    setTimeout(check, 0);
    requestAnimationFrame(check);
  };
  addEventListener('keydown', onInput, true);
  addEventListener('pointerdown', onInput, true);
  addEventListener('input', () => setTimeout(check, 0), true);

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) {
        if (e.interactionId) state.events.push({ start: e.startTime, duration: e.duration, name: e.name });
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: true } as any);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) state.loaf.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration });
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch {
    // older browsers: no cross-check
  }

  (window as any).__bench = {
    state,
    arm(predSources: Record<string, string>, ctxSource: string | null, manual: boolean) {
      const preds: Record<string, (ctx: unknown) => boolean> = {};
      for (const [name, src] of Object.entries(predSources)) preds[name] = new Function('ctx', `return (${src})(ctx);`) as any;
      const ctx = ctxSource ? new Function(`return (${ctxSource})();`)() : null;
      let resolve!: () => void;
      const done = new Promise<void>((r) => (resolve = r));
      state.pending = { preds, ctx, start: null, manual, matched: {}, painted: {}, resolve, done };
      return ctx;
    },
    setStart(start: number) {
      if (state.pending) state.pending.start = start;
      check();
    },
    async wait(timeout: number) {
      const p = state.pending;
      check();
      const timedOut = await Promise.race([p.done.then(() => false), new Promise((r) => setTimeout(() => r(true), timeout))]);
      state.pending = null;
      const ev = state.events.find((e: any) => p.start !== null && Math.abs(e.start - p.start) < 1);
      return { start: p.start, matched: p.matched, painted: p.painted, timedOut, eventTiming: ev ? ev.duration : null };
    },
  };
}
