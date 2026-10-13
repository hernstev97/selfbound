// Tree of a team's wiki pages: the visible rows from the flat list (`wiki.list`), and the target
// position for `wiki.move` while dragging.

export interface TreeArticle {
  _id: string;
  parentId?: string;
  title: string;
  rank: string;
}

export interface TreeRow {
  id: string;
  title: string;
  parentId: string | null;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/** Children per parent page (top level under ''), by rank. Pages whose parent is missing go to the top level. */
export function childrenMap<A extends TreeArticle>(articles: readonly A[]): Map<string, A[]> {
  const ids = new Set(articles.map((a) => a._id));
  const map = new Map<string, A[]>();
  for (const a of articles) {
    const parent = a.parentId && ids.has(a.parentId) ? a.parentId : '';
    let list = map.get(parent);
    if (!list) map.set(parent, (list = []));
    list.push(a);
  }
  for (const list of map.values()) list.sort((x, y) => (x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : x._id < y._id ? -1 : 1));
  return map;
}

/** Visible rows: expanded pages show their children. */
export function visibleRows(articles: readonly TreeArticle[], expanded: ReadonlySet<string>): TreeRow[] {
  const map = childrenMap(articles);
  const rows: TreeRow[] = [];
  const walk = (parent: string, depth: number) => {
    for (const a of map.get(parent) ?? []) {
      const kids = map.get(a._id);
      const open = expanded.has(a._id);
      rows.push({ id: a._id, title: a.title, parentId: parent || null, depth, hasChildren: !!kids?.length, expanded: open });
      if (open && kids && depth < 50) walk(a._id, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

/** Ancestor chain of a page (topmost first, without the page itself). */
export function ancestors(articles: readonly TreeArticle[], id: string): string[] {
  const byId = new Map(articles.map((a) => [a._id, a]));
  const out: string[] = [];
  let current = byId.get(id)?.parentId;
  while (current && byId.has(current) && !out.includes(current)) {
    out.unshift(current);
    current = byId.get(current)?.parentId;
  }
  return out;
}

/** Is `id` below `root` (or `root` itself)? */
export function isWithin(articles: readonly TreeArticle[], id: string, root: string): boolean {
  return id === root || ancestors(articles, id).includes(root);
}

export type DropPlace = 'before' | 'after' | 'inside';

export interface MoveTarget {
  parentId: string | null;
  /** Sibling directly BEFORE the page after the move */
  beforeId?: string;
  /** Sibling directly AFTER the page */
  afterId?: string;
}

/**
 * Target for `wiki.move` when `id` is dropped before, after or inside `target`. Null if that is not
 * possible (onto itself or into its own subtree) or nothing changes.
 */
export function dropTarget(articles: readonly TreeArticle[], id: string, target: string, place: DropPlace): MoveTarget | null {
  if (isWithin(articles, target, id)) return null;
  const map = childrenMap(articles);
  const byId = new Map(articles.map((a) => [a._id, a]));
  const t = byId.get(target);
  const self = byId.get(id);
  if (!t || !self) return null;
  if (place === 'inside') {
    const kids = (map.get(target) ?? []).filter((a) => a._id !== id);
    if (self.parentId === target && map.get(target)?.at(-1)?._id === id) return null;
    return { parentId: target, ...(kids.length ? { beforeId: kids.at(-1)!._id } : {}) };
  }
  const parent = t.parentId && byId.has(t.parentId) ? t.parentId : '';
  const siblings = (map.get(parent) ?? []).filter((a) => a._id !== id);
  const at = siblings.findIndex((a) => a._id === target);
  const index = place === 'before' ? at : at + 1;
  const before = siblings[index - 1];
  const after = siblings[index];
  const current = map.get(parent) ?? [];
  const old = current.findIndex((a) => a._id === id);
  if (old >= 0 && current[old - 1]?._id === before?._id && current[old + 1]?._id === after?._id) return null;
  return { parentId: parent || null, ...(before ? { beforeId: before._id } : {}), ...(after ? { afterId: after._id } : {}) };
}
