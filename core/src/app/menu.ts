// Context menu (right click, long press on phones) with submenus.
// Items come from the action list (field `context`), submenus from the same picker items as the
// keyboard and the command menu.
import { tn } from '../i18n.ts';
import { ICON } from '../icons.ts';
import { formatShortcut } from '../keyboard.ts';
import { Slice } from '../observable.ts';
import type { ContextMenuState, IssueId, MenuItem } from '../types.ts';
import { ACTIONS, actionById } from './actions.ts';
import type { App } from './index.ts';

export class ContextMenuController {
  readonly state = new Slice<ContextMenuState | null>(null);
  #targets: IssueId[] = [];
  #subRun = new Map<string, () => void | 'stay'>();

  constructor(private app: App) {}

  /** For actions running meanwhile: what the menu acts on. */
  targets() {
    return this.#targets;
  }

  open(id: IssueId, x: number, y: number) {
    this.app.palette.close();
    const list = this.app.list;
    // Right click inside a selection acts on the selection, otherwise only on this issue.
    if (list.isSelected(id)) this.#targets = list.selection();
    else {
      this.#targets = [id];
      if (this.app.nav.page.get().name === 'view') list.focus(id);
    }
    const items: MenuItem[] = [];
    const sorted = ACTIONS.filter((a) => a.context).sort((a, b) => a.context![0] - b.context![0] || a.context![1] - b.context![1]);
    for (const action of sorted) {
      if (action.when && !action.when(this.app)) continue;
      items.push({
        id: action.id,
        label: action.picker ? action.label.replace(/ …$/, '') : action.label,
        icon: action.icon ? ICON[action.icon] : undefined,
        shortcut: action.keys ? formatShortcut(action.keys[0]) : undefined,
        submenu: !!action.picker,
        danger: action.danger,
        section: String(action.context![0]),
      });
    }
    const count = this.#targets.length;
    this.state.set({ x, y, items, active: -1, sub: null, targetLabel: count > 1 ? tn(count, '{count} issue', '{count} issues') : (this.app.store.get(id)?.key ?? '') });
  }

  close() {
    if (this.state.get()) this.state.set(null);
    this.#targets = [];
  }

  hover(index: number, rowY?: number) {
    const s = this.state.get();
    if (!s) return;
    const item = s.items[index];
    let sub = s.sub;
    if (item?.submenu) {
      if (sub?.parent !== item.id) sub = this.#openSub(item.id, rowY ?? s.y);
    } else sub = null;
    if (s.active !== index || sub !== s.sub) this.state.set({ ...s, active: index, sub });
  }

  #openSub(actionId: string, y: number): ContextMenuState['sub'] {
    const action = actionById(actionId);
    if (!action?.picker) return null;
    const set = this.app.palette.pickerItems(action.picker, { kind: 'issues', ids: this.#targets });
    this.#subRun = set.run;
    return { parent: actionId, items: set.items, active: -1, multi: set.multi, y };
  }

  hoverSub(index: number) {
    const s = this.state.get();
    if (s?.sub && s.sub.active !== index) this.state.set({ ...s, sub: { ...s.sub, active: index } });
  }

  /** Keyboard: → opens the submenu, ← closes it. */
  enterSub() {
    const s = this.state.get();
    const item = s?.items[s.active];
    if (!s || !item?.submenu) return;
    const sub = s.sub?.parent === item.id ? s.sub : this.#openSub(item.id, s.y + s.active * 32);
    if (sub) this.state.set({ ...s, sub: { ...sub, active: 0 } });
  }

  leaveSub() {
    const s = this.state.get();
    if (s?.sub) this.state.set({ ...s, sub: { ...s.sub, active: -1 } });
  }

  move(delta: number) {
    const s = this.state.get();
    if (!s) return;
    if (s.sub && s.sub.active >= 0) {
      const n = s.sub.items.length;
      this.state.set({ ...s, sub: { ...s.sub, active: (s.sub.active + delta + n) % n } });
      return;
    }
    const n = s.items.length;
    const active = s.active < 0 ? (delta > 0 ? 0 : n - 1) : (s.active + delta + n) % n;
    this.state.set({ ...s, active, sub: null });
  }

  choose(index?: number) {
    const s = this.state.get();
    if (!s) return;
    if (s.sub && (index === undefined ? s.sub.active >= 0 : false)) return this.chooseSub(s.sub.active);
    const item = s.items[index ?? s.active];
    if (!item) return;
    if (item.submenu) return this.enterSub();
    this.app.cues.emit(item.danger ? 'destructive' : 'select', Math.min(index ?? s.active, 7));
    const action = actionById(item.id);
    // The action sees the menu's targets (e.g. right click inside a selection).
    this.app.withTargets(this.#targets, () => action?.run(this.app));
    this.close();
  }

  chooseSub(index: number) {
    const s = this.state.get();
    const item = s?.sub?.items[index];
    if (!s?.sub || !item) return;
    const run = this.#subRun.get(item.id);
    this.app.cues.emit(item.checkbox || s.sub.multi ? (item.checked ? 'toggleOff' : 'toggleOn') : 'select', Math.min(index, 7));
    const result = run?.();
    if (s.sub.multi || result === 'stay') {
      // Refresh the checkmarks; the menu stays open.
      const fresh = this.#openSub(s.sub.parent, s.sub.y);
      if (fresh) this.state.set({ ...s, sub: { ...fresh, active: index } });
    } else this.close();
  }
}
