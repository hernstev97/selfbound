// @vitest-environment jsdom
// Safe SVG for visual-block renderers: what a diagram library returns may contain anything a diagram
// text can smuggle into it. Scripts, event handlers, links, foreignObject and external references go;
// the drawing and its styles stay.
import { describe, expect, it } from 'vitest';
import { sanitizeSvg, setSvg } from '../src/lib/blocks/safe.ts';

const html = (svg: string) => {
  const box = document.createElement('div');
  box.append(sanitizeSvg(svg));
  return box.innerHTML;
};

describe('sanitizeSvg', () => {
  it('keeps a plain drawing with its inline style variables and its stylesheet', () => {
    const out = html('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" style="--bg:#fff;background:var(--bg)"><style>svg { --_text: var(--fg); } .node rect { fill: var(--bg); }</style><rect class="node" width="5" height="5" fill="var(--bg)"/><text x="1" y="1">Hello &amp; goodbye</text></svg>');
    expect(out).toContain('<rect');
    expect(out).toContain('Hello &amp; goodbye');
    expect(out).toContain('--bg:#fff');
    expect(out).toContain('.node rect { fill: var(--bg); }');
  });
  it('removes scripts, event handlers, links, foreignObject and animation', () => {
    const out = html(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__xss=1</script><rect width="5" onclick="window.__xss=2" onmouseover="alert(1)"/>' +
        '<a href="javascript:alert(1)"><text>x</text></a><foreignObject><div onclick="alert(1)">hi</div></foreignObject>' +
        '<image href="https://evil.example/x.png"/><use href="https://evil.example/x.svg#a"/><set attributeName="href" to="javascript:alert(1)"/></svg>',
    );
    expect(out).not.toMatch(/script|onclick|onmouseover|javascript|foreignObject|<image|<use|<set|<a[ >]|evil\.example/i);
    expect(out).toContain('<rect');
  });
  it('drops font imports and anything in CSS that loads or escapes', () => {
    const imported = html("<svg xmlns='http://www.w3.org/2000/svg'><style>@import url('https://fonts.googleapis.com/css2?family=Inter'); text { font-family: Inter; }</style><text>a</text></svg>");
    expect(imported).not.toContain('googleapis');
    expect(imported).toContain('font-family: Inter');
    for (const css of ['rect { fill: url(https://evil.example/a.svg#x) }', 'rect { background: u\\72l(https://evil.example/a) }', 'rect { background: image-set("https://evil.example/a" 1x) }', 'rect { fill: expression(alert(1)) }']) {
      expect(html(`<svg xmlns="http://www.w3.org/2000/svg"><style>${css}</style><rect/></svg>`), css).not.toContain('<style');
    }
    // A local reference is fine (gradients, markers)
    expect(html('<svg xmlns="http://www.w3.org/2000/svg"><style>rect { fill: url(#grad) }</style><rect/></svg>')).toContain('url(#grad)');
  });
  it('drops style attributes that load something', () => {
    const out = html('<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.example/a)" width="1"/><rect style="--bg:#fff" width="2"/></svg>');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('--bg:#fff');
  });
  it('a crafted label cannot cut a hole through the markup (no string surgery on the output)', () => {
    const out = html('<svg xmlns="http://www.w3.org/2000/svg"><text id="@import" x="1">&lt;text id="@import"&gt;;" onmouseover="alert(1)" x=&lt;/text&gt;</text></svg>');
    expect(out).not.toMatch(/<[^>]+onmouseover/i);
  });
});

describe('setSvg', () => {
  it('shows the drawing in a shadow root, so its styles stay out of the app', () => {
    const host = document.createElement('div');
    document.body.append(host);
    setSvg(host, '<svg xmlns="http://www.w3.org/2000/svg"><style>text { fill: red }</style><text>a</text></svg>');
    expect(host.childNodes.length).toBe(0);
    expect(host.shadowRoot?.querySelector('svg text')?.textContent).toBe('a');
    expect(host.shadowRoot?.querySelectorAll('style').length).toBe(2); // base + the drawing's own
    setSvg(host, '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    expect(host.shadowRoot?.querySelector('text')).toBeNull();
    host.remove();
  });
});
