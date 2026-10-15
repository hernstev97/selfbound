// @vitest-environment jsdom
// The Mermaid renderer: draws the supported types into a shadow root, says so for the rest, and
// whatever a diagram text smuggles into the SVG does not survive.
import { describe, expect, it } from 'vitest';
import { blockFor, BLOCKS } from '../src/lib/blocks/registry.ts';
import { MAX_DIAGRAM_CHARS, render } from '../src/lib/blocks/mermaid.ts';
import { blockFenceHtml } from '../src/lib/blocks/fence.ts';
import { needsHighlight } from '../src/lib/markdown.ts';

const ctx = { signal: new AbortController().signal };
const draw = (source: string) => {
  const host = document.createElement('div');
  document.body.append(host);
  render(source, host, ctx);
  return host;
};

describe('claim', () => {
  it('mermaid and mmd fences belong to the renderer, other fences do not', () => {
    expect(blockFor('mermaid')?.id).toBe('mermaid');
    expect(blockFor('MMD')?.id).toBe('mermaid');
    expect(blockFor('ts')).toBeNull();
    expect(BLOCKS.map((b) => b.id)).toEqual(['mermaid', 'chart']);
    expect(blockFenceHtml(blockFor('mermaid')!, 'graph TD\n  A-->B', 'mermaid')).toContain('data-block="mermaid"');
  });
  it('a diagram alone does not load the code highlighter', () => {
    expect(needsHighlight('```mermaid\ngraph TD\n```')).toBe(false);
    expect(needsHighlight('```ts\nconst a = 1\n```')).toBe(true);
    expect(needsHighlight('```mermaid\ngraph TD\n```\n\n```ts\nx\n```')).toBe(true);
  });
});

describe('draws', () => {
  const SAMPLES: Record<string, string> = {
    flowchart: 'flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Done]\n  B -->|No| D[Try again]',
    graph: 'graph LR\n  A --> B --> C',
    state: 'stateDiagram-v2\n  [*] --> Todo\n  Todo --> Done\n  Done --> [*]',
    sequence: 'sequenceDiagram\n  participant U as User\n  participant A as Agent\n  U->>A: Write\n  A-->>U: Diagram',
    class: 'classDiagram\n  class Issue {\n    +String title\n    +close()\n  }\n  Issue <|-- Bug',
    er: 'erDiagram\n  ISSUE ||--o{ COMMENT : has',
    xy: 'xychart-beta\n  title "Done per week"\n  x-axis [w1, w2, w3]\n  y-axis "Issues" 0 --> 10\n  bar [3, 5, 8]',
  };
  it.each(Object.entries(SAMPLES))('%s', (_name, source) => {
    const host = draw(source);
    expect(host.shadowRoot?.querySelector('svg')).not.toBeNull();
    expect(host.shadowRoot?.textContent?.length).toBeGreaterThan(5);
    // Colors come from the app's CSS variables, not fixed values
    const style = host.shadowRoot!.innerHTML;
    expect(style).toContain('var(--text)');
    expect(style).not.toContain('googleapis');
  });
  it('the text of the diagram is in the drawing', () => {
    expect(draw(SAMPLES.flowchart!).shadowRoot?.textContent).toContain('Decision');
  });
});

describe('preamble and description', () => {
  it('front matter, init directives and comments before the type are fine', () => {
    for (const source of ['---\ntitle: x\n---\nflowchart TD\n  A --> B', '%% a comment\nsequenceDiagram\n  A->>B: hi', '%%{init: {"theme": "dark"}}%%\nclassDiagram\n  class A', '%%{init: {\n "theme": "dark"\n}}%%\nerDiagram\n  A ||--o{ B : has', 'xychart\n  bar [1, 2]']) {
      expect(draw(source).shadowRoot?.querySelector('svg'), source).not.toBeNull();
    }
  });
  it('the accessible description lists the labels of the drawing', () => {
    const host = document.createElement('div');
    document.body.append(host);
    expect(render('flowchart TD\n  A[Create issue] --> B{Triage}', host, ctx)).toBe('Create issue, Triage');
  });
});

describe('says so instead of failing silently', () => {
  it('not drawn yet: the type is named', () => {
    expect(() => draw('pie title Pets\n  "Dogs": 3')).toThrow(/pie diagrams are not drawn yet/);
    expect(() => draw('%% comment\ngantt\n  title x')).toThrow(/gantt diagrams are not drawn yet/);
    expect(() => draw('---\ntitle: x\n---\nmindmap\n  root')).toThrow(/mindmap diagrams are not drawn yet/);
  });
  it('invalid text: a readable message', () => {
    expect(() => draw('this is not a diagram')).toThrow(/mermaid|header|diagram/i);
    expect(() => draw('')).toThrow();
  });
  it('too long: the limit keeps layout time in check', () => {
    expect(() => draw(`graph TD\n${'  A --> B\n'.repeat(MAX_DIAGRAM_CHARS / 10)}`)).toThrow(/too long/);
  });
});

describe('safe', () => {
  it('labels with markup, scripts and handlers produce nothing executable', () => {
    const host = draw('flowchart TD\n  A["<img src=x onerror=window.__xss=1>"] --> B["<script>window.__xss=2</script>"]\n  C["<foreignObject><div onclick=alert(1)>x</div></foreignObject>"]');
    const root = host.shadowRoot!;
    expect(root.querySelectorAll('img, script, foreignObject, iframe, a').length).toBe(0);
    for (const el of root.querySelectorAll('*')) expect([...el.attributes].filter((a) => /^on/i.test(a.name))).toEqual([]);
    // The text is shown as text
    expect(root.textContent).toContain('<img src=x onerror=window.__xss=1>');
    expect((globalThis as { __xss?: number }).__xss).toBeUndefined();
  });
  it('the stylesheet is clean after the font import is cut out', () => {
    const css = [...draw('flowchart TD\n  A --> B').shadowRoot!.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(css).not.toMatch(/@import|googleapis|display=swap/);
    expect(css).toContain("text { font-family: 'Inter'");
  });
  it('a click directive and a link do not become a link', () => {
    const host = draw('flowchart TD\n  A --> B\n  click A "javascript:alert(1)"\n  click B href "https://evil.example"');
    expect(host.shadowRoot!.innerHTML).not.toMatch(/javascript:|evil\.example|<a[ >]/i);
    expect(host.shadowRoot!.querySelectorAll('a').length).toBe(0);
  });
});
