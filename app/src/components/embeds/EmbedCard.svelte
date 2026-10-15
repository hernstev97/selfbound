<script module lang="ts">
  // One request per link and minute, however many cards show it.
  const asked = new Map<string, number>();
</script>

<script lang="ts">
  // Card for a YouTube or X link (XLR8-73). Gets its data from the backend cache (`embeds.get`);
  // if nothing is cached or it is old, `embeds.resolve` fetches it there. The browser never talks to
  // the provider; the YouTube player loads only on click (YoutubeCard). While there is no data, or
  // the link cannot be embedded, the plain link in the Markdown stays visible.
  import { api } from '@selfbound/backend/api';
  import { embedTtl, type EmbedProvider, type EmbedView } from '@selfbound/backend/shared/embeds';
  import { app } from '../../app-instance.ts';
  import XCard from './XCard.svelte';
  import YoutubeCard from './YoutubeCard.svelte';

  interface Props {
    provider: EmbedProvider;
    id: string;
    start?: number;
    /** The plain link of the placeholder; hidden while the card is shown. */
    link: HTMLElement;
  }
  let { provider, id, start, link }: Props = $props();

  let view = $state<EmbedView | null | undefined>(undefined); // undefined: loading, null: not cached

  $effect(() => {
    const watch = app.store.watch(api.embeds.get, { provider, id });
    const update = () => (view = watch.slice.get());
    update();
    const stop = watch.slice.subscribe(update);
    return () => {
      stop();
      watch.release();
    };
  });

  $effect(() => {
    if (view === undefined) return;
    if (view && Date.now() - view.fetchedAt < embedTtl(view)) return;
    const key = `${provider}:${id}`;
    if (Date.now() - (asked.get(key) ?? 0) < 60_000) return;
    asked.set(key, Date.now());
    // The card follows through `get`. If this fails (offline, provider down), the link stays until the card is shown again.
    app.store.client.action(api.embeds.resolve, { provider, id }).catch(() => {});
  });

  const shown = $derived(view?.status === 'ok' ? view : null);
  $effect(() => {
    link.hidden = shown !== null;
    return () => (link.hidden = false);
  });
</script>

{#if shown}
  <!-- Clicks on the card must not start editing the surrounding description. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="embed-wrap" onclick={(e) => e.stopPropagation()}>
    {#if provider === 'youtube'}
      <YoutubeCard view={shown} {id} {start} />
    {:else}
      <XCard view={shown} />
    {/if}
  </div>
{/if}

<style>
  .embed-wrap {
    max-width: 560px;
    margin: 0.5em 0;
  }
</style>
