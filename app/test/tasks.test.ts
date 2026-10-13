import { describe, expect, it } from 'vitest';
import { toggleTask } from '../src/lib/tasks.ts';

describe('click a task in the rendered view', () => {
  const md = '- [ ] one\n- [x] two\n\n```md\n- [ ] in code\n```\n\n> 1. [ ] in a quote\n\n* [X] capital';
  it('toggles exactly the n-th task; code does not count', () => {
    expect(toggleTask(md, 0, 4)).toBe(md.replace('- [ ] one', '- [x] one'));
    expect(toggleTask(md, 1, 4)).toBe(md.replace('- [x] two', '- [ ] two'));
    expect(toggleTask(md, 2, 4)).toBe(md.replace('> 1. [ ] in a quote', '> 1. [x] in a quote'));
    expect(toggleTask(md, 3, 4)).toBe(md.replace('* [X] capital', '* [ ] capital'));
  });
  it('"```ts" inside code does not close the fence', () => {
    const src = '```md\n```ts\n- [ ] in code\n```\n\n- [ ] real';
    expect(toggleTask(src, 0, 1)).toBe(src.replace('- [ ] real', '- [x] real'));
  });
  it('if the count does not match the rendered view, nothing changes', () => {
    expect(toggleTask(md, 0, 5)).toBeNull();
    expect(toggleTask(md, 4, 4)).toBeNull();
  });
});
