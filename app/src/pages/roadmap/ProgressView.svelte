<script lang="ts">
  // Progress tracker: one row per project (or category) on a time axis. The bar runs from the first
  // started issue to the last completion (all done) or to today, a dashed part on to the end of the
  // period; completions are points on the row. Rows unfold into their issues. Zoom: a quarter, two
  // quarters or a year fill the visible width; "Today" scrolls back to now.
  import { ZOOM_DAYS, ZOOMS, dayOfString, type Zoom } from '@selfbound/core/roadmap';
  import { ICON, type IssueId } from '@selfbound/core';
  import { t, translated } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { tip } from '../../lib/ui.ts';
  import { PROJECT_STATE_TEXT, STAGE_TEXT, dayText, monthText, periodText } from './labels.ts';

  const uiSlice = fromSlice(app.roadmap.ui);
  const progressSlice = fromSlice(app.roadmap.progress);
  const jumpSlice = fromSlice(app.roadmap.jumpToday);
  const mobileSlice = fromSlice(app.mobile);
  const ui = $derived(uiSlice.current);
  const view = $derived(progressSlice.current);
  const ZOOM_TEXT: Record<Zoom, string> = translated({ quarter: 'Quarter', half: 'Two quarters', year: 'Year' });

  /** Width of the name column (px); the track takes the rest */
  const nameW = $derived(mobileSlice.current ? 150 : 280);
  let viewport = $state(0);
  const perDay = $derived(Math.max(0.5, (viewport - nameW - 16) / ZOOM_DAYS[ui.zoom]));
  const x = (day: number) => (day - (view?.axis.start ?? 0)) * perDay;
  const trackW = $derived(view ? (view.axis.end - view.axis.start) * perDay : 0);
  const expanded = $derived(new Set(ui.expanded));
  const today = $derived(view?.axis.today ?? 0);

  let scroller = $state<HTMLElement>();
  /** Scroll so that today sits in the left third of the track (on open, on "Today", after a zoom). */
  function showToday(smooth: boolean) {
    if (!scroller || !view) return;
    const visible = scroller.clientWidth - nameW;
    scroller.scrollTo({ left: Math.max(0, x(today) - visible / 3), behavior: smooth ? 'smooth' : 'auto' });
  }
  let shownJump = -1;
  let shownZoom: Zoom | null = null;
  $effect(() => {
    const jump = jumpSlice.current;
    const zoom = ui.zoom;
    if (!scroller || !view || viewport === 0) return;
    if (jump !== shownJump || zoom !== shownZoom) {
      const smooth = shownJump !== -1 && jump !== shownJump;
      shownJump = jump;
      shownZoom = zoom;
      showToday(smooth);
    }
  });

  // Keep the focused row in view (J/K).
  $effect(() => {
    const id = ui.focus;
    if (!id || !scroller) return;
    const row = scroller.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    if (scroller.contains(document.activeElement) && document.activeElement !== row) row.focus({ preventScroll: true });
  });

  /** End of a bar: the last completion when everything is done, else today. */
  const barEnd = (start: number, end: number | null) => Math.max(start + 1, (end ?? today) + 1);

  function openIssue(id: IssueId, e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    app.roadmap.open(id, { toggle: true });
  }
</script>

<div class="pg-tools" role="toolbar" aria-label={t('Progress')}>
  <div class="seg" role="group" aria-label={t('Rows')}>
    <button class={[ui.rows === 'projects' && 'on']} aria-pressed={ui.rows === 'projects'} title={tip(t('One row per project'), 'roadmap.rows')} data-testid="progress-rows-projects" onclick={() => app.roadmap.setRows('projects')}>{t('Projects')}</button>
    <button class={[ui.rows === 'categories' && 'on']} aria-pressed={ui.rows === 'categories'} title={tip(t('One row per category'), 'roadmap.rows')} data-testid="progress-rows-categories" onclick={() => app.roadmap.setRows('categories')}>{t('Categories')}</button>
  </div>
  <div class="seg" role="group" aria-label={t('Zoom')}>
    {#each ZOOMS as zoom (zoom)}
      <button class={[ui.zoom === zoom && 'on']} aria-pressed={ui.zoom === zoom} data-testid="progress-zoom-{zoom}" onclick={() => app.roadmap.setZoom(zoom)}>{ZOOM_TEXT[zoom]}</button>
    {/each}
  </div>
  <button class="btn ghost small" title={tip(t('Scroll to today'), 'roadmap.today')} data-testid="progress-today" onclick={() => app.roadmap.today()}><span class="icon">{@html ICON.calendar}</span>{t('Today')}</button>
  <span class="pg-legend" aria-hidden="true">
    <span><i class="pg-key-bar"></i>{t('worked on')}</span>
    <span><i class="pg-key-plan"></i>{t('planned until')}</span>
    <span><i class="pg-key-dot"></i>{t('completed')}</span>
  </span>
</div>

<div class="pg-scroll" bind:this={scroller} bind:clientWidth={viewport} data-testid="roadmap-progress">
  {#if view}
    <div class="pg-grid" style:--name-w="{nameW}px" style:width="{nameW + trackW}px">
      <div class="pg-head">
        <div class="pg-corner">{ui.rows === 'projects' ? t('Project') : t('Category')}</div>
        <div class="pg-axis" style:width="{trackW}px">
          <div class="pg-quarters">
            {#each view.axis.quarters as q (q.start)}
              <span style:left="{x(q.start)}px" style:width="{q.days * perDay}px">{t('Q{quarter} {year}', { quarter: q.quarter, year: q.year })}</span>
            {/each}
          </div>
          <div class="pg-months">
            {#each view.axis.months as m (m.start)}
              <span style:left="{x(m.start)}px" style:width="{m.days * perDay}px">{m.days * perDay >= 34 ? monthText(m.year, m.month) : monthText(m.year, m.month, 'narrow')}</span>
            {/each}
          </div>
        </div>
      </div>
      <div class="pg-lines" aria-hidden="true" style:width="{trackW}px">
        {#each view.axis.months as m (m.start)}<span class={[m.month % 3 === 1 && 'q']} style:left="{x(m.start)}px"></span>{/each}
        <span class="pg-now" style:left="{x(today)}px"><b>{t('Today')}</b></span>
      </div>
      <div class="pg-rows">
        {#if view.rows.length === 0}
          <p class="rm-hint">{t('Nothing here with these filters.')}</p>
        {/if}
        {#each view.rows as row (row.key)}
          {@const open = expanded.has(row.key)}
          {@const period = periodText(row.period)}
          <div class={['pg-row', ui.focus === `row:${row.key}` && 'focus']} style:--hue={row.hue ?? 'var(--accent-hue)'} data-testid="progress-row">
            <button class="pg-name" aria-expanded={open} data-focus-id="row:{row.key}" onclick={() => app.roadmap.toggleRow(row.key)} onfocus={() => app.roadmap.focus(`row:${row.key}`)}>
              <span class={['group-chevron', !open && 'closed']} aria-hidden="true"><span class="icon mi ui-caretDown"></span></span>
              <span class="pg-name-text">
                <span class="pg-title">{row.name}</span>
                <span class="pg-sub">
                  {#if row.state}{PROJECT_STATE_TEXT[row.state] ?? row.state}{/if}{#if row.state && period} · {/if}{#if period}{period}{/if}
                </span>
              </span>
              <span class="pg-count" data-testid="progress-count">{row.done}/{row.total}</span>
              <span class="pg-mini" aria-hidden="true"><i style:width="{row.total ? (row.done / row.total) * 100 : 0}%"></i></span>
            </button>
            <div class="pg-track" style:width="{trackW}px">
              {#if row.period && row.target !== null}
                {@const from = dayOfString(row.period.start)}
                <span class="pg-period" style:left="{x(from)}px" style:width="{(row.target + 1 - from) * perDay}px"></span>
              {/if}
              {#if row.start !== null}
                <span class={['pg-bar', row.end !== null && 'done']} style:left="{x(row.start)}px" style:width="{(barEnd(row.start, row.end) - row.start) * perDay}px" title={row.end !== null ? t('{from} to {to}', { from: dayText(row.start), to: dayText(row.end) }) : t('Since {from}', { from: dayText(row.start) })}>
                  <span class="pg-bar-label">{t('{done} of {total} done', { done: row.done, total: row.total })}</span>
                </span>
              {/if}
              {#if row.end === null && row.target !== null && row.target > today}
                {@const from = Math.max(today + 1, row.start ?? today + 1)}
                <span class="pg-plan" style:left="{x(from)}px" style:width="{Math.max(2, (row.target + 1 - from) * perDay)}px" title={t('Planned until {date}', { date: dayText(row.target) })}></span>
              {/if}
              {#if row.target !== null}<span class="pg-target" style:left="{x(row.target + 1)}px" title={t('End of the period: {date}', { date: dayText(row.target) })}></span>{/if}
              {#each row.completions as c (c.id)}
                <span class="pg-dot" style:left="{x(c.day + 0.5)}px" title={t('Completed {date}', { date: dayText(c.day) })}></span>
              {/each}
            </div>
          </div>
          {#if open}
            {#each row.issues as issue (issue.id)}
              <div class={['pg-row', 'sub', ui.focus === issue.id && 'focus']} data-testid="progress-issue">
                <a class="pg-name sub" href="/issue/{issue.key}" data-focus-id={issue.id} onclick={(e) => openIssue(issue.id, e)} onfocus={() => app.roadmap.focus(issue.id)}>
                  <span class="rm-stage-dot" data-stage={issue.stage} title={STAGE_TEXT[issue.stage]}></span>
                  <span class="pg-key">{issue.key}</span>
                  <span class="pg-title">{issue.title}</span>
                  {#if issue.public}<span class="rm-public" title={t('Public: appears in the image export')}><span class="icon">{@html ICON.eye}</span></span>{/if}
                </a>
                <div class="pg-track" style:width="{trackW}px">
                  {#if issue.start !== null}
                    <span class={['pg-bar', 'thin', issue.end !== null && 'done']} style:left="{x(issue.start)}px" style:width="{(barEnd(issue.start, issue.end) - issue.start) * perDay}px" title={issue.end !== null ? t('{from} to {to}', { from: dayText(issue.start), to: dayText(issue.end) }) : t('Since {from}', { from: dayText(issue.start) })}></span>
                  {/if}
                  {#if issue.end !== null}<span class="pg-dot" style:left="{x(issue.end + 0.5)}px" title={t('Completed {date}', { date: dayText(issue.end) })}></span>{/if}
                </div>
              </div>
            {/each}
            {#if row.issues.length === 0}<div class="pg-row sub"><span class="pg-name sub muted">{t('No issues')}</span><div class="pg-track" style:width="{trackW}px"></div></div>{/if}
          {/if}
        {/each}
      </div>
    </div>
  {/if}
</div>
