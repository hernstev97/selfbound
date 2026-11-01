<script lang="ts">
  // Release view: the team's projects as columns in their order, the categories inside with their
  // count (fold them one by one or all at once), cards with picture, title, short text and stage.
  // A card opens its issue (beside the page or as its own page). J/K and ←/→ move the focus.
  import { ICON, type IssueId } from '@selfbound/core';
  import { t, tn } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { PROJECT_STATE_TEXT, STAGE_TEXT, periodText } from './labels.ts';

  const uiSlice = fromSlice(app.roadmap.ui);
  const releaseSlice = fromSlice(app.roadmap.release);
  const besideSlice = fromSlice(app.detail.beside);
  const ui = $derived(uiSlice.current);
  const release = $derived(releaseSlice.current);
  const collapsed = $derived(new Set(ui.collapsed));

  let scroller = $state<HTMLElement>();
  // Keep the focused card in view (J/K, ←/→); the browser focus follows so screen readers hear it.
  $effect(() => {
    const id = ui.focus;
    if (!id || !scroller) return;
    const card = scroller.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (scroller.contains(document.activeElement) && document.activeElement !== card) card.focus({ preventScroll: true });
  });

  function open(id: string, e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    // A click on the card beside closes it; Enter (a click without a pointer, detail 0) opens its page.
    app.roadmap.open(id as IssueId, { toggle: e.detail > 0 });
  }
</script>

<div class="rm-columns" bind:this={scroller} data-testid="roadmap-release">
  {#each release?.columns ?? [] as col (col.id)}
    {@const period = periodText(col.period)}
    <section class="rm-column" style:--hue={col.hue ?? 'var(--accent-hue)'} data-testid="roadmap-column" aria-label={col.name}>
      <header class="rm-col-head">
        <div class="rm-col-title">
          <h2>{col.name}</h2>
          <span class="rm-state" data-state={col.state}>{PROJECT_STATE_TEXT[col.state] ?? col.state}</span>
        </div>
        <div class="rm-col-meta">
          {#if period}<span class="rm-period"><span class="icon">{@html ICON.calendar}</span>{period}</span>{/if}
          <span class="rm-count" data-testid="roadmap-column-count">{t('{done} of {total} done', { done: col.done, total: col.total })}</span>
        </div>
        <div class="rm-progress" role="progressbar" aria-valuemin={0} aria-valuemax={col.total} aria-valuenow={col.done} aria-label={t('{done} of {total} done', { done: col.done, total: col.total })}>
          {#each ['done', 'testing', 'progress'] as const as stage (stage)}
            {#if col.stages[stage]}<div data-stage={stage} style:width="{(col.stages[stage] / Math.max(1, col.total)) * 100}%"></div>{/if}
          {/each}
        </div>
        {#if col.description}<p class="rm-goal" title={col.readyWhen ? `${t('Ready when')}: ${col.readyWhen}` : undefined}>{col.description}</p>{/if}
      </header>
      <div class="rm-col-body">
        {#if col.groups.length === 0}
          <p class="rm-col-empty">{ui.filters.publicOnly || ui.filters.categories.length || ui.filters.stages.length ? t('Nothing here with these filters.') : t('No issues in this stage yet.')}</p>
        {/if}
        {#each col.groups as g (g.key)}
          {@const closed = collapsed.has(`${col.id}:${g.key}`)}
          <div class="rm-group" data-testid="roadmap-category" data-category={g.key}>
            <button class="rm-group-head" aria-expanded={!closed} data-testid="roadmap-category-toggle" onclick={() => app.roadmap.toggleCategory(col.id, g.key)}>
              <span class={['group-chevron', closed && 'closed']} aria-hidden="true"><span class="icon mi ui-caretDown"></span></span>
              {#if g.hue !== null}<span class="rm-dot" style:--hue={g.hue}></span>{/if}
              <span class="rm-group-name">{g.name}</span>
              <span class="group-count">{g.cards.length}</span>
            </button>
            {#if !closed}
              <ul class="rm-cards">
                {#each g.cards as card (card.id)}
                  <li>
                    <a
                      class={['rm-card', ui.focus === card.id && 'focus', besideSlice.current === card.id && 'open']}
                      href="/issue/{card.key}"
                      data-card={card.id}
                      data-testid="roadmap-card"
                      data-public={card.public ? '' : undefined}
                      onclick={(e) => open(card.id, e)}
                      onfocus={() => app.roadmap.focus(card.id)}
                    >
                      {#if card.image}<img class="rm-card-img" src={card.image} alt="" loading="lazy" referrerpolicy="no-referrer" />{/if}
                      <span class="rm-card-top">
                        <span class="rm-stage" data-stage={card.stage}><span class="rm-stage-dot" data-stage={card.stage}></span>{STAGE_TEXT[card.stage]}</span>
                        <span class="rm-card-key">{card.key}</span>
                        {#if card.public}<span class="rm-public" role="img" aria-label={t('Public')} title={t('Public: appears in the image export')}><span class="icon">{@html ICON.eye}</span></span>{/if}
                      </span>
                      <span class="rm-card-title">{card.title}</span>
                      {#if card.title !== card.internalTitle}<span class="rm-card-internal" title={t('Internal title')}>{card.internalTitle}</span>{/if}
                      {#if card.summary}<span class="rm-card-summary">{card.summary}</span>{/if}
                    </a>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {/each}
</div>
{#if release && release.shown === 0 && release.filtered === 0}
  <p class="rm-hint" data-testid="roadmap-empty">{tn(release.columns.length, 'The stage has no issues yet: assign issues to the project.', 'The stages have no issues yet: assign issues to the projects.')}</p>
{/if}
