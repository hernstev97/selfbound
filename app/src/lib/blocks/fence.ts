// Markup of a fenced block that a renderer claims. Pure and DOM-free. The source stays in the page
// as an ordinary code block (readable, copyable, shown when drawing fails); mount.ts draws on top of
// it once the block is visible.
import { codeBlockHtml } from '../codeblock.ts';
import type { BlockRenderer } from './registry.ts';

export function blockFenceHtml(renderer: BlockRenderer, code: string, info: string | undefined) {
  return codeBlockHtml(code, info, null).replace('<div class="codeblock"', `<div class="codeblock vblock" data-block="${renderer.id}"`);
}
