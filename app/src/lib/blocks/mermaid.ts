// Mermaid diagrams: the ```mermaid fence is drawn with beautiful-mermaid (own chunk, loaded when the
// first diagram becomes visible). It draws synchronously, without DOM, and takes its colors from CSS
// variables: the drawing uses the app's variables directly, so a theme change needs no redraw.
// Supported: flowchart, state, sequence, class, ER and XY charts. Other Mermaid types (pie, gantt …)
// are reported as not drawn yet; the source stays readable.
import { t } from '@selfbound/core/i18n';
import { renderMermaidSVG } from 'beautiful-mermaid';
import type { BlockContext } from './registry.ts';
import { setSvg } from './safe.ts';

/** A diagram this long is a mistake (or an attack on the layout engine). */
export const MAX_DIAGRAM_CHARS = 20_000;

const UNSUPPORTED = /^(pie|gantt|journey|mindmap|timeline|gitGraph|quadrantChart|sankey(?:-beta)?|requirementDiagram|C4\w*|block(?:-beta)?|packet(?:-beta)?|kanban|architecture(?:-beta)?|radar(?:-beta)?|treemap(?:-beta)?|zenuml|xychart(?!-beta))\b/;

/** First line that is neither empty, a `%%` comment nor front matter. */
function typeOf(source: string): string {
  const lines = source.replace(/^\s*---[\s\S]*?\n---\s*\n/, '').split('\n');
  const first = lines.map((l) => l.trim()).find((l) => l && !l.startsWith('%%'));
  return first ?? '';
}

export function render(source: string, host: HTMLElement, _ctx: BlockContext) {
  if (source.length > MAX_DIAGRAM_CHARS) throw new Error(t('Diagram text is too long ({n} characters, at most {max})', { n: source.length, max: MAX_DIAGRAM_CHARS }));
  const unsupported = UNSUPPORTED.exec(typeOf(source))?.[1];
  if (unsupported) throw new Error(t('{type} diagrams are not drawn yet (flowchart, state, sequence, class, ER and XY charts are)', { type: unsupported }));
  const svg = renderMermaidSVG(source, {
    bg: 'var(--bg-raised)',
    fg: 'var(--text)',
    line: 'var(--text-muted)',
    accent: 'var(--accent-text)',
    muted: 'var(--text-muted)',
    surface: 'var(--bg-control)',
    border: 'var(--border-strong)',
    transparent: true,
    padding: 16,
  });
  setSvg(host, svg);
  // The library names its font in its own stylesheet; the app's font comes last.
  const font = document.createElement('style');
  font.textContent = 'text, .label { font-family: var(--font); }';
  host.shadowRoot?.append(font);
}
