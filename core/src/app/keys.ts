// Keyboard: one listener for the whole window. Order: open dialogs and menus first, then text
// fields (letters only type letters there), then the action list.
import { eventCombo, isEditable } from '../keyboard.ts';
import { KEYMAP, startsSequence, type Action } from './actions.ts';
import type { App } from './index.ts';

const SEQUENCE_MS = 1200;
const HOLD_MS = 350;

export class KeyController {
  #sequence: { key: string; at: number } | null = null;
  #spaceDown: number | null = null;

  constructor(private app: App) {}

  attach(target: Pick<Window, 'addEventListener' | 'removeEventListener'>) {
    const down = (e: KeyboardEvent) => this.onKeyDown(e);
    const up = (e: KeyboardEvent) => this.onKeyUp(e);
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    return () => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
    };
  }

  onKeyUp(e: KeyboardEvent) {
    if (e.key !== ' ' || this.#spaceDown === null) return;
    // Holding space: the peek stays open only while held.
    if (performance.now() - this.#spaceDown > HOLD_MS && this.app.detail.peekOpen.get()) this.app.detail.togglePeek();
    this.#spaceDown = null;
  }

  onKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return;
    const combo = eventCombo(e);
    this.app.perf.measure(e.timeStamp, combo);
    const app = this.app;

    // The palette (command menu, pickers, search) sits above everything.
    const palette = app.palette.state.get();
    if (palette) {
      if (combo === 'escape') return consume(e, () => app.palette.back());
      if (combo === 'arrowdown' || combo === 'mod+j' || combo === 'mod+n' || combo === 'tab') return consume(e, () => app.palette.move(1));
      if (combo === 'arrowup' || combo === 'mod+p' || combo === 'shift+tab') return consume(e, () => app.palette.move(-1));
      if (combo === 'enter') return consume(e, () => app.palette.choose());
      if (combo === 'backspace' && palette.query === '' && palette.parent) return consume(e, () => app.palette.back());
      // Digits pick directly (status 1–9 in workflow order, priority 0–4) while nothing is typed.
      if (/^[0-9]$/.test(combo) && palette.query === '' && (palette.kind === 'status' || palette.kind === 'priority')) {
        const index = palette.kind === 'status' ? Number(combo) - 1 : palette.items.findIndex((i) => i.id === `p:${combo}`);
        if (index >= 0 && index < palette.items.length) return consume(e, () => app.palette.choose(index));
      }
      return;
    }

    const menu = app.menu.state.get();
    if (menu) {
      if (combo === 'escape') return consume(e, () => app.menu.close());
      if (combo === 'arrowdown') return consume(e, () => app.menu.move(1));
      if (combo === 'arrowup') return consume(e, () => app.menu.move(-1));
      if (combo === 'arrowright') return consume(e, () => app.menu.enterSub());
      if (combo === 'arrowleft') return consume(e, () => app.menu.leaveSub());
      if (combo === 'enter') return consume(e, () => app.menu.choose());
      app.menu.close();
    }

    if (app.displayOpen.get() && combo === 'escape') return consume(e, () => app.displayOpen.set(false));

    // Create dialog
    if (app.create.isOpen()) {
      if (combo === 'escape') return consume(e, () => app.create.close());
      if (combo === 'mod+enter') return consume(e, () => app.create.submit());
      if (combo === 'mod+shift+enter') return consume(e, () => app.create.submit(true));
      return;
    }

    // "Add team" dialog: Esc closes it, otherwise the page shortcuts stay silent.
    if (app.newTeamOpen.get()) {
      if (combo === 'escape') return consume(e, () => app.newTeamOpen.set(false));
      return;
    }

    if (isEditable(e.target)) {
      const el = e.target as HTMLElement;
      if (el.dataset.role === 'quick') {
        if (combo === 'escape') return consume(e, () => this.#leaveQuick(true));
        if (combo === 'enter' || combo === 'arrowdown') return consume(e, () => this.#leaveQuick(false));
      } else if (combo === 'escape') {
        // Esc leaves text fields (title, description, comment) and keeps the content.
        return consume(e, () => el.blur());
      }
      return;
    }

    // Enter/space on a focused button, link or summary (agent details): its own effect (keyboard operation).
    if ((combo === 'enter' || combo === 'space' || combo === 'shift+space') && e.target instanceof HTMLElement && (e.target.tagName === 'BUTTON' || e.target.tagName === 'A' || e.target.tagName === 'SUMMARY') && !e.target.closest('[data-testid="list"]')) return;

    if (combo === 'escape') {
      return consume(e, () => {
        if (app.mobileDrawer.get()) return app.mobileDrawer.set(false);
        if (app.detail.splitShown()) return app.detail.closeSplit();
        if (app.detail.peekOpen.get()) return app.detail.togglePeek();
        if (app.prSplit.get()) return app.prSplit.set(null);
        if (app.nav.page.get().name === 'issue' || app.nav.page.get().name === 'pr') return app.closeIssue();
        if (app.list.selectionCount.get() > 0) return app.list.clearSelection();
        if (app.list.view.get().quickOpen) return app.list.closeQuick();
      });
    }

    if (combo === 'space') {
      if (e.repeat) return e.preventDefault();
      const page = app.nav.page.get().name;
      if (page === 'view' && app.list.focusId()) {
        const opening = !app.detail.peekOpen.get();
        consume(e, () => app.detail.togglePeek());
        this.#spaceDown = opening ? performance.now() : null;
      }
      return;
    }

    // Holding ⇧ space would open and close the split view over and over.
    if (combo === 'shift+space' && e.repeat) return e.preventDefault();

    // Two-key sequences like "g i"
    const now = performance.now();
    if (this.#sequence && now - this.#sequence.at < SEQUENCE_MS) {
      const full = `${this.#sequence.key} ${combo}`;
      this.#sequence = null;
      const actions = KEYMAP.get(full);
      if (actions) return this.#runFirst(e, actions);
    }
    if (!combo.includes('+') && startsSequence(combo)) {
      this.#sequence = { key: combo, at: now };
      e.preventDefault();
      return;
    }
    const actions = KEYMAP.get(combo);
    if (actions) this.#runFirst(e, actions);
  }

  #runFirst(e: KeyboardEvent, actions: Action[]) {
    const action = actions.find((a) => !a.when || a.when(this.app));
    if (action) consume(e, () => action.run(this.app));
  }

  #leaveQuick(clear: boolean) {
    (document.activeElement as HTMLElement | null)?.blur();
    if (clear) this.app.list.closeQuick();
    const list = this.app.list;
    const focus = list.focusId();
    if (list.order().length) list.focus(focus && list.isVisible(focus) ? focus : list.order()[0], true);
  }
}

function consume(e: KeyboardEvent, run: () => void) {
  e.preventDefault();
  e.stopPropagation();
  run();
}
