// Edit a rendered text (description, wiki page) from the keyboard too: Tab stops on the rendered
// view, Enter or Space starts editing, and after Esc or "Done" focus is back on the view. The E key
// (actions `issue.editDescription`, `wiki.editBody`) comes through core and ends in the same state.

/** Enter or Space on the view itself; links, checkboxes and buttons inside keep their keys. */
export function startKey(start: () => void) {
  return (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) start();
  };
}

/**
 * For the editor area: if editing started from the command menu, its fade-out still locks the
 * background (`inert`, lib/modal.ts) when the editor mounts, so the editor gets no focus. Catch up
 * afterwards if focus is nowhere (the editor restores the position itself).
 */
export function editorFocus(wrap: HTMLElement) {
  const timer = setTimeout(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    wrap.querySelector<HTMLElement>('[contenteditable="true"], textarea')?.focus({ preventScroll: true });
  });
  return () => clearTimeout(timer);
}

/** Focus back on the view when it reappears after `arm()` and nothing else has focus. */
export function focusReturn() {
  let armed = false;
  return {
    arm() {
      armed = true;
    },
    attach(el: HTMLElement) {
      if (!armed) return;
      armed = false;
      // Only after the editor is gone: until then it (or "Done") holds focus.
      queueMicrotask(() => {
        const active = document.activeElement;
        if (el.isConnected && (!active || active === document.body)) el.focus({ preventScroll: true });
      });
    },
  };
}
