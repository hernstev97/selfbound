import { Marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { embedExtension } from '../src/lib/embedBlock.ts';

const render = (md: string) => new Marked({ gfm: true, breaks: true }).use({ extensions: [embedExtension] }).parse(md, { async: false }) as string;
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const X = 'https://x.com/demo_user/status/1585341984679469056';

describe('embed placeholders in Markdown', () => {
  it('a link alone on a line becomes a placeholder that still contains the link', () => {
    expect(render(YT)).toBe(`<div class="embed" data-embed="youtube" data-embed-id="dQw4w9WgXcQ"><a class="embed-link" href="${YT}">${YT}</a></div>\n`);
    expect(render(X)).toContain('data-embed="x" data-embed-id="1585341984679469056"');
  });

  it('also in <…> and as [text](link); the text stays as the fallback link text', () => {
    expect(render(`<${YT}>`)).toContain('data-embed="youtube"');
    const html = render(`[My <talk>](${X})`);
    expect(html).toContain('data-embed="x"');
    expect(html).toContain(`href="${X}">My &lt;talk&gt;</a>`);
  });

  it('keeps the start time', () => {
    expect(render('https://youtu.be/dQw4w9WgXcQ?t=1m30s')).toContain('data-embed-start="90"');
    expect(render(YT)).not.toContain('data-embed-start');
  });

  it('works between paragraphs, after a text line, in lists and quotes', () => {
    expect(render(`before\n\n${YT}\n\nafter`).match(/data-embed=/g)).toHaveLength(1);
    const html = render(`text line\n${YT}\nnext line`);
    expect(html).toContain('<p>text line</p>');
    expect(html).toContain('data-embed="youtube"');
    expect(html).toContain('<p>next line</p>');
    expect(render(`- ${YT}`)).toContain('data-embed="youtube"');
    expect(render(`> ${X}`)).toContain('data-embed="x"');
  });

  it('inside text, with more on the line, in code or with other links it stays a link', () => {
    for (const md of [`see ${YT}`, `${YT} is great`, `${YT}.`, `[${YT}](${X}) more`, '`' + YT + '`', '```\n' + YT + '\n```', 'https://example.com/watch?v=dQw4w9WgXcQ', 'http://youtu.be/dQw4w9WgXcQ', 'https://youtu.be/short']) {
      expect(render(md), md).not.toContain('data-embed=');
    }
  });

  it('a hostile label cannot add markup', () => {
    const html = render(`["><img src=x onerror=alert(1)>](${YT})`);
    expect(html).not.toMatch(/<img/);
    expect(html).toContain('data-embed="youtube"');
  });
});
