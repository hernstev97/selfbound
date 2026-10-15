// Status icons next to issue identifiers while editing (decorations only: the text stays as typed).
// Same rules as the rendered view: a known team key, not inside code or a link. See ../mentions.ts.
import { BARE_IDENTIFIER_RE } from '@selfbound/backend/shared/links';
import { statusIcon } from '@selfbound/core';
import type { Node } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { mentionClass, mentionLabel, type Mention } from '../mentions.ts';
import { schema } from './schema.ts';

export interface EditorMentions {
  teamKeys(): ReadonlySet<string>;
  info(key: string): Mention | null;
  /** Calls back when issues changed (their ids) or the statuses did (no ids); returns the cleanup. */
  subscribe(listener: (ids?: ReadonlySet<string>) => void): () => void;
}

const key = new PluginKey<DecorationSet>('mentions');
const QUICK = /[A-Z][A-Z0-9]{1,5}-[1-9]/;

/** Identifier positions per text block, kept while the block is unchanged (typing rescans one block). */
const found = new WeakMap<Node, { teams: ReadonlySet<string>; hits: { from: number; to: number; key: string }[] }>();

function hitsOf(block: Node, teams: ReadonlySet<string>) {
  const cached = found.get(block);
  if (cached?.teams === teams) return cached.hits;
  const hits: { from: number; to: number; key: string }[] = [];
  if (block.textContent.length > 4 && QUICK.test(block.textContent)) {
    block.forEach((child, offset) => {
      if (!child.isText || child.marks.some((mark) => mark.type === schema.marks.code || mark.type === schema.marks.link)) return;
      for (const m of child.text!.matchAll(BARE_IDENTIFIER_RE)) {
        if (teams.has(m[1]!)) hits.push({ from: offset + m.index!, to: offset + m.index! + m[0].length, key: `${m[1]}-${Number(m[2])}` });
      }
    });
  }
  found.set(block, { teams, hits });
  return hits;
}

/** Issues the last decoration pass showed, so unrelated store changes do not redraw. */
const shown = { ids: new Set<string>(), missing: false };

function decorations(doc: Node, source: EditorMentions): DecorationSet {
  shown.ids = new Set();
  shown.missing = false;
  const teams = source.teamKeys();
  if (!teams.size) return DecorationSet.empty;
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.code_block) return false;
    if (!node.isTextblock) return true;
    for (const hit of hitsOf(node, teams)) {
      const info = source.info(hit.key);
      if (!info) {
        shown.missing = true;
        continue;
      }
      shown.ids.add(info.id);
      const from = pos + 1 + hit.from;
      const to = pos + 1 + hit.to;
      const label = mentionLabel(info);
      const cls = `mention-text ${mentionClass(info.status)}`.trim();
      decos.push(
        Decoration.widget(
          from,
          () => {
            const icon = document.createElement('span');
            icon.className = 'mention-icon icon';
            icon.contentEditable = 'false';
            icon.innerHTML = statusIcon(info.status, info.color);
            return icon;
          },
          { side: -1, key: `${info.status}|${info.color}`, ignoreSelection: true },
        ),
        Decoration.inline(from, to, { class: cls, title: label }),
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export function mentionStatus(source: EditorMentions) {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => decorations(state.doc, source),
      apply: (tr, set, _old, state) => (tr.docChanged || tr.getMeta(key) ? decorations(state.doc, source) : set),
    },
    props: { decorations: (state) => key.getState(state) },
    view(view) {
      const stop = source.subscribe((ids) => {
        if (view.isDestroyed || (ids && !shown.missing && ![...ids].some((id) => shown.ids.has(id)))) return;
        view.dispatch(view.state.tr.setMeta(key, true).setMeta('addToHistory', false));
      });
      return { destroy: stop };
    },
  });
}
