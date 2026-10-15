// Mermaid diagrams: the ```mermaid fence is drawn with beautiful-mermaid (own chunk, loaded when the
// first diagram becomes visible). It draws synchronously, without DOM, and takes its colors from CSS
// variables: the drawing uses the app's variables directly, so a theme change needs no redraw.
// Supported: flowchart, state, sequence, class, ER and XY charts. Other Mermaid types (pie, gantt …)
// are reported as not drawn yet; the source stays readable.
import { t } from '@selfbound/core/i18n';
import { renderMermaidSVG } from 'beautiful-mermaid';
import type { BlockContext } from './registry.ts';
import { setSvg } from './safe.ts';

/**
 * Layout is synchronous and roughly quadratic: about 620 chained nodes (8,000 characters) take
 * 0.5 to 0.7 s, 2,000 nodes several seconds and would freeze the tab. 6,000 keeps it around 0.3 s.
 */
export const MAX_DIAGRAM_CHARS = 6_000;

const UNSUPPORTED = /^(pie|gantt|journey|mindmap|timeline|gitGraph|quadrantChart|sankey(?:-beta)?|requirementDiagram|C4\w*|block(?:-beta)?|packet(?:-beta)?|kanban|architecture(?:-beta)?|radar(?:-beta)?|treemap(?:-beta)?|zenuml)\b/;

/** The library wants the diagram type on the first line: drop front matter, `%%{init}%%` directives and `%%` comments. */
function withoutPreamble(source: string): string {
  return source
    .replace(/^\s*---[\s\S]*?\n---[ \t]*(?:\n|$)/, '')
    .replace(/%%\{[\s\S]*?\}%%/g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('%%'))
    .join('\n')
    .trim();
}

/** What a screen reader gets in place of the picture: the labels in the drawing. */
function describe(root: ParentNode): string {
  const words = [...root.querySelectorAll('svg text')].map((el) => el.textContent?.trim()).filter(Boolean);
  return words.join(', ').slice(0, 300);
}

export function render(source: string, host: HTMLElement, _ctx: BlockContext): string {
  if (source.length > MAX_DIAGRAM_CHARS) throw new Error(t('Diagram text is too long ({n} characters, at most {max})', { n: source.length, max: MAX_DIAGRAM_CHARS }));
  const text = withoutPreamble(source);
  const unsupported = UNSUPPORTED.exec(text)?.[1];
  if (unsupported) throw new Error(t('{type} diagrams are not drawn yet (flowchart, state, sequence, class, ER and XY charts are)', { type: unsupported }));
  const svg = renderMermaidSVG(text, {
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
  return describe(host.shadowRoot ?? host);
}
