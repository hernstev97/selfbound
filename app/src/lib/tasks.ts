// Click a task in rendered Markdown (description, own comment): toggle the n-th "[ ]" in the
// source without loading the editor. Only when the count clearly matches the rendered view.

const TASK = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(\](?:[ \t]|$))/;
const FENCE = /^(?:[ \t]*>)*[ \t]{0,3}(`{3,}|~{3,})/;
/** Closing fence: only fence characters and whitespace, no info string. */
const CLOSE = /^(?:[ \t]*>)*[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * The text with task `index` toggled, or null if the number of tasks in the text is not `total`
 * (checkboxes in the rendered view), e.g. tasks inside HTML blocks.
 */
export function toggleTask(markdown: string, index: number, total: number): string | null {
  const lines = markdown.split('\n');
  const hits: number[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    if (fence) {
      const c = CLOSE.exec(line)?.[1];
      if (c && c[0] === fence[0] && c.length >= fence.length) fence = null;
      return;
    }
    const f = FENCE.exec(line)?.[1];
    if (f) {
      fence = f;
      return;
    }
    if (TASK.test(line)) hits.push(i);
  });
  if (hits.length !== total || index < 0 || index >= total) return null;
  const at = hits[index]!;
  lines[at] = lines[at]!.replace(TASK, (_all, a: string, c: string, b: string) => a + (c === ' ' ? 'x' : ' ') + b);
  return lines.join('\n');
}
