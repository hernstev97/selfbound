<script lang="ts" module>
  export interface ViewerImage {
    src: string;
    alt: string;
    /** Address to open in a new tab (the link around the image, otherwise the image itself) */
    href: string;
  }
</script>

<script lang="ts">
  // Images from a pull request, large in the same tab. Sits above the whole app (appended to <body>
  // so no ancestor with transform/overflow constrains it) and blocks the rest (modal).
  // Esc closes, ←/→ step through the images of the same text, a click on the image shows it at
  // original size (scrollable), a click beside it closes. The viewer catches these keys before the
  // app's shortcuts, otherwise Esc would also close the pull request next to it.
  import { ICON } from '@xlr8/core';
  import { t } from '@xlr8/core/i18n';
  import { modal } from '../../lib/modal.ts';

  let { images, index = $bindable(0), onclose }: { images: ViewerImage[]; index?: number; onclose: () => void } = $props();

  const img = $derived(images[Math.min(index, images.length - 1)]!);
  const many = $derived(images.length > 1);
  let zoomed = $state(false);

  function step(delta: number) {
    if (!many) return;
    index = (index + delta + images.length) % images.length;
    zoomed = false;
  }

  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      let handled = true;
      if (e.key === 'Escape') onclose();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  });

  const portal = (node: HTMLElement) => {
    document.body.append(node);
    return () => node.remove();
  };
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  class={['img-viewer', zoomed && 'zoomed']}
  role="dialog"
  aria-modal="true"
  aria-label={img.alt || t('Image')}
  tabindex="-1"
  data-testid="image-viewer"
  {@attach portal}
  {@attach modal()}
  onclick={(e) => {
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('img-viewer-stage')) onclose();
  }}
>
  <div class="img-viewer-bar">
    {#if many}<span class="img-viewer-count tnum" data-testid="image-viewer-count">{index + 1} / {images.length}</span>{/if}
    <span class="grow"></span>
    <a class="icon-btn plain" href={img.href} target="_blank" rel="noopener noreferrer" title={t('Open in new tab')} aria-label={t('Open in new tab')}><span class="icon">{@html ICON.open}</span></a>
    <button class="icon-btn plain" title={t('Close (Esc)')} aria-label={t('Close')} data-testid="image-viewer-close" data-autofocus onclick={onclose}><span class="icon">{@html ICON.close}</span></button>
  </div>
  <div class="img-viewer-stage">
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <img src={img.src} alt={img.alt} referrerpolicy="no-referrer" data-testid="image-viewer-img" title={zoomed ? t('Fit to screen') : t('Original size')} onclick={() => (zoomed = !zoomed)} />
  </div>
  {#if many}
    <button class="img-viewer-nav prev" aria-label={t('Previous image')} title={t('Previous image (←)')} onclick={() => step(-1)}><span class="icon">{@html ICON.chevronLeft}</span></button>
    <button class="img-viewer-nav next" aria-label={t('Next image')} title={t('Next image (→)')} data-testid="image-viewer-next" onclick={() => step(1)}><span class="icon">{@html ICON.chevronRight}</span></button>
  {/if}
  {#if img.alt}<div class="img-viewer-caption">{img.alt}</div>{/if}
</div>
