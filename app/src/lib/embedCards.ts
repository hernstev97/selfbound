// Mounts the embed cards (components/embeds/) into rendered Markdown. Loaded only when a text
// contains a YouTube or X link (markdown.ts → cardEmbeds). A card appears once its placeholder
// is nearly visible; until then, and if anything fails, the plain link stays (embedBlock.ts).
import { mount, unmount } from 'svelte';
import { ID_PATTERN, type EmbedProvider } from '@selfbound/backend/shared/embeds';

export function mountEmbeds(root: HTMLElement): () => void {
  const nodes = root.querySelectorAll<HTMLElement>('.embed[data-embed]:not([data-ready])');
  if (!nodes.length) return () => {};
  const mounted: Record<string, unknown>[] = [];
  let dead = false;

  async function show(el: HTMLElement) {
    const provider = el.dataset.embed as EmbedProvider;
    const id = el.dataset.embedId ?? '';
    const link = el.querySelector<HTMLElement>('a.embed-link');
    if (!ID_PATTERN[provider]?.test(id) || !link || el.dataset.ready) return;
    el.dataset.ready = '1';
    const { default: EmbedCard } = await import('../components/embeds/EmbedCard.svelte');
    if (dead) return;
    mounted.push(mount(EmbedCard, { target: el, props: { provider, id, start: Number(el.dataset.embedStart) || undefined, link } }));
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        void show(entry.target as HTMLElement).catch(() => {}); // if the chunk does not load, the link stays
      }
    },
    { rootMargin: '300px' },
  );
  for (const node of nodes) observer.observe(node);
  return () => {
    dead = true;
    observer.disconnect();
    for (const component of mounted) void unmount(component);
  };
}
