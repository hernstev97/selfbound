<script lang="ts">
  // Color picker: the dot shows the color, a click opens the palette.
  import { HUES } from '@xlr8/core/app/admin';
  import { t } from '@xlr8/core/i18n';
  import { backCloses } from '../../lib/ui.ts';

  let { hue, pick, label = t('Color'), testid }: { hue: number; pick: (hue: number) => void; label?: string; testid?: string } = $props();
  let open = $state(false);

  function outside(node: HTMLElement) {
    const onDown = (e: PointerEvent) => {
      if (!node.contains(e.target as Node)) open = false;
    };
    setTimeout(() => window.addEventListener('pointerdown', onDown));
    return () => window.removeEventListener('pointerdown', onDown);
  }
</script>

<span class="hue-picker">
  <button class="hue-dot" style:--hue={hue} aria-label={label} title={label} data-testid={testid} onclick={() => (open = !open)}></button>
  {#if open}
    <span class="hue-pop" role="listbox" aria-label={label} {@attach outside} {@attach backCloses(() => (open = false))}>
      {#each HUES as h (h)}
        <button
          class={['hue-dot', h === hue && 'on']}
          style:--hue={h}
          role="option"
          aria-selected={h === hue}
          aria-label={t('Hue {hue}', { hue: h })}
          onclick={() => {
            open = false;
            if (h !== hue) pick(h);
          }}
        ></button>
      {/each}
    </span>
  {/if}
</span>
