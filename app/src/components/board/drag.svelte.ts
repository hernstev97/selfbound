import type { IssueId } from '@selfbound/core';

/** Cards being dragged (to mark allowed and blocked columns while dragging). */
class DragState {
  ids = $state<IssueId[] | null>(null);
  start(ids: IssueId[]) {
    this.ids = ids;
  }
  end() {
    this.ids = null;
  }
}

export const drag = new DragState();
