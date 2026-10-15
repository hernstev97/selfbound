<script lang="ts">
  // The owner's avatar: the profile picture as a circle; without one the initials of the name on a
  // color derived from it; without a name a neutral person glyph. The picture is a cropped square
  // (the circle is drawn here).
  import { initials, nameHue } from '@selfbound/core';

  let { name = null, url = null, size = 18 }: { name?: string | null; url?: string | null; size?: number } = $props();
  // Picture failed to load: initials until a different URL arrives.
  let brokenUrl = $state<string | null>(null);
  const letters = $derived(name ? initials(name) : '');
</script>

<span class="avatar" style:--size="{size}px" style:--hue={name ? nameHue(name) : 250} data-testid="avatar" title={name ?? undefined}>
  {#if url && brokenUrl !== url}
    <img src={url} alt="" width={size} height={size} decoding="async" referrerpolicy="no-referrer" onerror={() => (brokenUrl = url)} />
  {:else if letters}
    <span class="letters" aria-hidden="true">{letters}</span>
  {:else}
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="5.5" r="2.5" stroke="currentColor" stroke-width="1.3" /><path d="M3.5 13.5c.4-2.4 2.2-4 4.5-4s4.1 1.6 4.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
  {/if}
</span>

<style>
  .avatar {
    width: var(--size);
    height: var(--size);
    flex: none;
    border-radius: 50%;
    overflow: hidden;
    display: inline-grid;
    place-items: center;
    background: oklch(0.56 0.12 var(--hue));
    color: white;
    font-size: calc(var(--size) * 0.42);
    font-weight: 650;
    line-height: 1;
    user-select: none;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  svg {
    width: 62%;
    height: 62%;
  }
</style>
