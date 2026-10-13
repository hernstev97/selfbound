<script lang="ts">
  // Peek: floating card at the top right (space; ↑/↓ moves through the list with it).
  import { ICON, PRIORITY_ICON, statusIcon } from '@xlr8/core';
  import { t, tn } from '@xlr8/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import Markdown from './Markdown.svelte';
  import { leave } from '../lib/motion.ts';

  const detailSlice = fromSlice(app.detail.state);
  const paletteSlice = fromSlice(app.palette.state);
  const d = $derived(detailSlice.current);
  const beside = $derived(paletteSlice.current !== null);
  // Cut at a line boundary so no link (image, Drive video) breaks in the middle.
  const shortBody = $derived.by(() => {
    const text = d?.body?.markdown ?? '';
    if (text.length <= 1200) return text;
    const cut = text.slice(0, 1200);
    const line = cut.lastIndexOf('\n');
    return line > 600 ? cut.slice(0, line) : cut;
  });
</script>

{#if d}
  <aside class={['peek', beside && 'beside-palette']} data-testid="peek" aria-label={t('Preview {key}', { key: d.key })} out:leave|global>
    <div class="peek-key">{d.key}</div>
    <h2 class="peek-title" data-testid="peek-title">{d.title}</h2>
    {#if d.project || d.sprint}
      <div class="peek-sub">
        {#if d.project}<span class="icon">{@html ICON.projects}</span><span>{d.project.name}</span>{/if}
        {#if d.project && d.sprint}<span>·</span>{/if}
        {#if d.sprint}<span class="icon">{@html ICON.sprint}</span><span>{d.sprint.name}{d.sprint.late ? ` (${t('added late')})` : ''}</span>{/if}
      </div>
    {/if}
    <div class="peek-props">
      <span class="peek-prop"><span class="icon">{@html statusIcon(d.status, d.statusColor)}</span>{d.statusLabel}</span>
      <span class="peek-prop"><span class="icon">{@html PRIORITY_ICON[d.priority]}</span>{d.priorityLabel}</span>
      {#if d.estimate !== null}<span class="peek-prop"><span class="icon">{@html ICON.estimate}</span>{tn(d.estimate, '{count} point', '{count} points')}</span>{/if}
      {#if d.due}<span class="peek-prop" style:color={d.due.overdue ? 'var(--danger-text)' : undefined}><span class="icon">{@html ICON.calendar}</span>{d.due.long}</span>{/if}
    </div>
    {#if d.labels.length}
      <div class="peek-labels">
        {#each d.labels as label (label.id)}<span class="peek-prop"><span class="label-dot" style:--hue={label.hue}></span>{label.name}</span>{/each}
      </div>
    {/if}
    {#if d.body === null}
      <div data-testid="peek-loading">
        <div class="skeleton-bar" style="width: 86%; margin: 6px 0"></div>
        <div class="skeleton-bar" style="width: 68%; margin: 6px 0"></div>
      </div>
    {:else if d.body.markdown.trim()}
      <div class="peek-desc" data-testid="peek-description"><Markdown markdown={shortBody} /></div>
    {:else}
      <div class="peek-desc desc-placeholder" data-testid="peek-description">{t('No description.')}</div>
    {/if}
    <div class="peek-foot">
      <span>{t('Created {when} by {actor}', { when: d.created, actor: d.createdBy })}</span><span>·</span><span>{t('Updated {when}', { when: d.updated })}</span>
    </div>
  </aside>
{/if}
