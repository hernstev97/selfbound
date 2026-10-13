import { describe, expect, test } from 'vitest';
import { ancestors, dropTarget, visibleRows, type TreeArticle } from '../src/wikiTree.ts';

// Tree of wiki pages: visible rows and the target when dragging.

const A: TreeArticle[] = [
  { _id: 'a', title: 'A', rank: 'a0' },
  { _id: 'b', title: 'B', rank: 'a1' },
  { _id: 'c', title: 'C', rank: 'a2' },
  { _id: 'b1', title: 'B1', rank: 'a0', parentId: 'b' },
  { _id: 'b2', title: 'B2', rank: 'a1', parentId: 'b' },
  { _id: 'b21', title: 'B21', rank: 'a0', parentId: 'b2' },
  { _id: 'lost', title: 'Orphan', rank: 'a3', parentId: 'gone' },
];

describe('visibleRows', () => {
  test('collapsed: only the top level; pages with a missing parent at the top', () => {
    expect(visibleRows(A, new Set()).map((r) => r.title)).toEqual(['A', 'B', 'C', 'Orphan']);
    expect(visibleRows(A, new Set()).find((r) => r.id === 'b')).toMatchObject({ hasChildren: true, expanded: false, depth: 0 });
  });

  test('expanded with depth', () => {
    const rows = visibleRows(A, new Set(['b', 'b2']));
    expect(rows.map((r) => `${r.depth}${r.title}`)).toEqual(['0A', '0B', '1B1', '1B2', '2B21', '0C', '0Orphan']);
  });

  test('ancestors: path from the top', () => {
    expect(ancestors(A, 'b21')).toEqual(['b', 'b2']);
    expect(ancestors(A, 'a')).toEqual([]);
  });
});

describe('dropTarget', () => {
  test('before, after, inside', () => {
    expect(dropTarget(A, 'c', 'a', 'before')).toEqual({ parentId: null, afterId: 'a' });
    expect(dropTarget(A, 'a', 'b', 'after')).toEqual({ parentId: null, beforeId: 'b', afterId: 'c' });
    expect(dropTarget(A, 'c', 'b', 'inside')).toEqual({ parentId: 'b', beforeId: 'b2' });
    expect(dropTarget(A, 'c', 'b1', 'after')).toEqual({ parentId: 'b', beforeId: 'b1', afterId: 'b2' });
    expect(dropTarget(A, 'a', 'c', 'inside')).toEqual({ parentId: 'c' });
  });

  test('not into itself or its own subtree; null without a change', () => {
    expect(dropTarget(A, 'b', 'b21', 'inside')).toBeNull();
    expect(dropTarget(A, 'b', 'b', 'before')).toBeNull();
    expect(dropTarget(A, 'a', 'b', 'before')).toBeNull(); // already before B
    expect(dropTarget(A, 'b2', 'b', 'inside')).toBeNull(); // already the last child page
  });
});
