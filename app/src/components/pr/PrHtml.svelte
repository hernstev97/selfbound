<script lang="ts">
  // Shows HTML from GitHub (sanitized by lib/prHtml.ts). Images and videos from private repos point
  // to the backend's media proxy (/ghmedia/…), which returns a fresh address every time.
  // A click on an image reports all images of this text to `onimage` (image viewer in the same tab).
  // Ctrl/Cmd click and middle click open a new tab as usual; images that link to another page
  // (e.g. bot badges) stay links.
  import { grammarsReady, loadGrammars } from '../../lib/highlightLoad.ts';
  import { highlightedCode, highlightVersion, onHighlightChange } from '../../lib/markdown.ts';
  import { languageFor } from '../../lib/languages.ts';
  import { cleanPrHtml, loadPrHtml } from '../../lib/prHtml.ts';
  import type { ViewerImage } from './ImageViewer.svelte';

  let { html, onimage }: { html: string; onimage?: (images: ViewerImage[], index: number) => void } = $props();
  const loaded = cleanPrHtml('') !== null;
  let ready = $state(loaded);
  if (!loaded) loadPrHtml().then(() => (ready = true));
  const clean = $derived(ready ? cleanPrHtml(html) : null);

  // GitHub marks fenced code as `div.highlight-source-ts > pre` with its own token classes (not
  // styled here); color it like our own code blocks, with the chosen theme.
  let root = $state<HTMLElement>();
  let colors = $state(highlightVersion());
  $effect(() => {
    colors = highlightVersion(); // a change between init and now
    return onHighlightChange(() => (colors = highlightVersion()));
  });
  $effect(() => {
    void clean;
    void colors;
    if (!root) return;
    const blocks: { pre: HTMLElement; lang: string; grammar: string }[] = [];
    for (const pre of root.querySelectorAll<HTMLElement>('div.highlight > pre')) {
      const lang = /\bhighlight-(?:source|text)-([a-z0-9+#]+)/.exec(pre.parentElement!.className)?.[1] ?? '';
      const grammar = languageFor(lang)?.grammar;
      if (grammar) blocks.push({ pre, lang, grammar });
    }
    if (!blocks.length) return;
    const names = [...new Set(blocks.map((b) => b.grammar))];
    if (!grammarsReady(names)) {
      loadGrammars(names).catch(() => {}); // if loading fails, the code stays plain
      return;
    }
    for (const { pre, lang } of blocks) {
      const colored = highlightedCode(pre.textContent ?? '', lang);
      if (colored !== null) pre.innerHTML = colored;
    }
  });

  /** Small images (badges, icons) do not open the image viewer. */
  const MIN_SIZE = 48;

  /** The image itself, or a link that points only to the image (how GitHub embeds images). */
  function viewable(img: HTMLImageElement): boolean {
    if (img.complete && img.naturalWidth > 0 && img.naturalWidth < MIN_SIZE && img.naturalHeight < MIN_SIZE) return false;
    const href = img.closest('a')?.getAttribute('href');
    if (!href) return true;
    return href === img.getAttribute('src') || /\/ghmedia\/|private-user-images\.githubusercontent\.com|user-images\.githubusercontent\.com|camo\.githubusercontent\.com|\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(href);
  }

  function onclick(e: MouseEvent & { currentTarget: HTMLElement }) {
    if (!onimage || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = (e.target as HTMLElement | null)?.closest('img');
    if (!(target instanceof HTMLImageElement) || !viewable(target)) return;
    e.preventDefault();
    const all = [...e.currentTarget.querySelectorAll('img')].filter(viewable);
    const images = all.map((img) => ({
      src: img.currentSrc || img.src,
      alt: img.getAttribute('alt') ?? '',
      href: img.closest('a')?.getAttribute('href') || img.src,
    }));
    onimage(images, Math.max(0, all.indexOf(target)));
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="md pr-md" {onclick} bind:this={root}>
  {#if clean !== null}
    {@html clean}
  {/if}
</div>
