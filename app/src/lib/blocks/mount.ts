// Draws visual blocks into rendered Markdown (the `.vblock[data-block]` placeholders from
// fence.ts) and into the editor preview. Nothing is loaded until a block is about to become
// visible. While it loads, and if it fails, the source code block stays; a failure adds a note.
import { t } from '@selfbound/core/i18n';
import { BLOCKS, loadBlock, type BlockRenderer } from './registry.ts';
import { onThemeChange } from './theme.ts';

type State = 'loading' | 'ready' | 'error';

/** Draws `source` into `host` with the renderer; resolves to an error message or null. The host's accessible name gains the renderer's description of the drawing. */
export async function drawBlock(renderer: BlockRenderer, source: string, host: HTMLElement, signal: AbortSignal): Promise<string | null> {
  try {
    const module = await loadBlock(renderer);
    if (signal.aborted) return null;
    host.replaceChildren();
    const description = await module.render(source, host, { signal });
    if (description) host.setAttribute('aria-label', `${renderer.label()}: ${description}`);
    return null;
  } catch (error) {
    if (signal.aborted) return null;
    host.replaceChildren();
    const reason = error instanceof Error ? error.message : String(error);
    return reason.split('\n')[0]!.slice(0, 300) || t('unknown error');
  }
}

function setNote(block: HTMLElement, message: string | null) {
  block.querySelector(':scope > .vblock-error')?.remove();
  if (!message) return;
  const note = document.createElement('p');
  note.className = 'vblock-error';
  note.setAttribute('role', 'status');
  note.textContent = message;
  block.append(note);
}

/** Visible failure text, e.g. "Diagram could not be drawn: Parse error on line 2". */
export function failureText(renderer: BlockRenderer, reason: string) {
  return t('{kind} could not be drawn: {reason}', { kind: renderer.label(), reason });
}

/**
 * Draws every placeholder under `root` once it is close to the viewport. Returns a function that
 * stops everything (call it when the HTML is replaced).
 */
export function mountBlocks(root: HTMLElement, blocks: readonly BlockRenderer[] = BLOCKS): (() => void) | undefined {
  const nodes = root.querySelectorAll<HTMLElement>('.vblock[data-block]:not([data-state])');
  if (!nodes.length) return;
  const controllers = new Map<HTMLElement, AbortController>();
  let unTheme: (() => void) | null = null;

  const draw = async (el: HTMLElement) => {
    const renderer = blocks.find((b) => b.id === el.dataset.block);
    const source = el.querySelector('code')?.textContent ?? '';
    if (!renderer) return;
    controllers.get(el)?.abort();
    const controller = new AbortController();
    controllers.set(el, controller);
    const set = (state: State) => (el.dataset.state = state);
    set('loading');
    setNote(el, null);
    const host = document.createElement('div');
    host.className = 'vblock-view';
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', renderer.label());
    el.querySelector(':scope > .vblock-view')?.remove();
    el.prepend(host);
    const error = await drawBlock(renderer, source, host, controller.signal);
    if (controller.signal.aborted) return;
    if (error === null) return void set('ready');
    host.remove();
    set('error');
    setNote(el, failureText(renderer, error));
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const el = entry.target as HTMLElement;
        void draw(el);
        // Themed drawings (fixed colors) are drawn again when the theme changes.
        if (!unTheme && blocks.find((b) => b.id === el.dataset.block)?.themed) {
          unTheme = onThemeChange(() => {
            for (const [block] of controllers) if (blocks.find((b) => b.id === block.dataset.block)?.themed && block.dataset.state === 'ready') void draw(block);
          });
        }
      }
    },
    { rootMargin: '200px' },
  );
  for (const node of nodes) observer.observe(node);
  return () => {
    observer.disconnect();
    unTheme?.();
    for (const controller of controllers.values()) controller.abort();
  };
}
