<script lang="ts">
  // After the first key of a two-key sequence (G, O): what can follow. Shown only when the second
  // key takes a moment, so a fast "G I" never sees it. The keyboard itself needs none of this.
  import { ACTIONS } from '@selfbound/core';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';

  const pending = fromSlice(app.keys.pending);
  let shown = $state<string | null>(null);
  $effect(() => {
    const key = pending.current;
    if (!key) {
      shown = null;
      return;
    }
    const timer = setTimeout(() => (shown = key), 250);
    return () => clearTimeout(timer);
  });
  // "Go to: Inbox" → "Inbox": the first key already says what kind of step this is.
  const next = $derived(
    shown
      ? ACTIONS.filter((a) => !a.hidden && (!a.when || a.when(app))).flatMap((a) =>
          (a.keys ?? []).filter((k) => k.startsWith(`${shown} `)).map((k) => ({ key: k.slice(shown!.length + 1), label: a.label.split(': ').pop()!.replace(/ …$/, '') })),
        )
      : [],
  );
</script>

{#if shown && next.length}
  <div class="key-hint" role="status" data-testid="key-hint">
    <span class="kbd">{shown.toUpperCase()}</span>
    {#each next as n (n.key)}
      <span><span class="kbd">{n.key.toUpperCase()}</span>{n.label}</span>
    {/each}
  </div>
{/if}
