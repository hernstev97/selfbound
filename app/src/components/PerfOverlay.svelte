<script lang="ts">
  // Measurement overlay (?perf=1): time from the last interaction to the next frame.
  import { t } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';

  const perfSlice = fromSlice(app.perf.state);
  const perf = $derived(perfSlice.current);
</script>

{#if perf.enabled}
  {@const last = perf.last}
  <div class={['perf-overlay', last && last.ms > 100 && 'slow']} data-testid="perf-overlay">
    {last ? `${last.label}: ${last.ms.toFixed(1)} ms` : t('Measurement overlay on')}
  </div>
{/if}
