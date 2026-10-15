<script lang="ts">
  // One pattern for the command menu, search, help, filters and all property pickers:
  // focus in the search field, typing filters, ↑/↓ moves, Enter applies, Esc cancels.
  import { ICON, dayOf, monthLabel, parseDay, today, type PaletteKind } from '@selfbound/core';
  import { intlLocale, t } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { autofocus, keepInView } from '../lib/ui.ts';
  import { leave } from '../lib/motion.ts';
  import { modal } from '../lib/modal.ts';
  import TeamLogo from './TeamLogo.svelte';

  const paletteSlice = fromSlice(app.palette.state);
  const p = $derived(paletteSlice.current);
  const active = $derived(p?.active ?? -1);
  const shellSlice = fromSlice(app.shell);

  // Touch (phone): no autofocus in the search field (the keyboard would pop up at once) and no
  // shortcuts in the entries.
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  const PICKER_KEY: Partial<Record<PaletteKind, string>> = { status: 'S', priority: 'P', labels: 'L', estimate: '⇧E', model: '⇧M', sprint: '⇧C', project: '⇧P', due: '⇧D', filter: 'F' };

  // Reads only `active`: runs after each change of it, once the entries are in the DOM.
  function revealActive(list: HTMLElement) {
    const el = list.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }

  // Two-letter weekday names, Monday first (Mo Tu … / Mo Di …). 2024-01-01 was a Monday.
  const weekday = new Intl.DateTimeFormat(intlLocale(), { weekday: 'short' });
  const WEEKDAYS = Array.from({ length: 7 }, (_, i) => weekday.format(new Date(2024, 0, 1 + i)).slice(0, 2));
  function monthDays(month: string) {
    const [y, m] = month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const offset = (first.getDay() + 6) % 7;
    const days: { day: string; other: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(y, m - 1, 1 - offset + i);
      days.push({ day: dayOf(d), other: d.getMonth() !== m - 1 });
    }
    return days;
  }
  const todayDay = today();
</script>

{#if p}{#key p.seq}
  <!-- Every open is a fresh element (focus, position); the previous one fades out beside it. -->
  <!-- z-index 57: above the create dialog (52), which would otherwise hide pickers anchored to its chips. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="overlay"
    style:z-index="57"
    data-testid="palette-overlay"
    out:leave|global
    {@attach modal({ trap: false, focus: false })}
    onpointerdown={(e) => {
      if (e.target === e.currentTarget) app.palette.close();
    }}
  >
    <div
      class={['palette', p.anchor && 'anchored', p.anchor && (p.kind === 'labels' || p.kind === 'parent' || p.kind === 'relation' || p.kind === 'duplicate' || p.kind === 'due' || p.kind === 'snooze' || p.kind === 'model') && 'wide']}
      style:left={p.anchor ? `${p.anchor.x}px` : shellSlice.current.peek && (p.kind === 'search' || p.kind === 'command') ? 'calc(50% - 250px)' : undefined}
      style:top={p.anchor ? `${p.anchor.y}px` : undefined}
      data-testid="palette"
      data-kind={p.kind}
      role="dialog"
      aria-modal="true"
      aria-label={p.title}
      {@attach p.anchor && keepInView}
    >
      {#if p.targetLabel || p.parent}
        <div>
          {#if p.targetLabel}<span class="palette-target" data-testid="palette-target">{p.targetLabel}</span>{/if}
          {#if p.parent}<button class="palette-parent" onclick={() => app.palette.back()}><span class="icon">{@html ICON.chevronLeft}</span>{p.parent}</button>{/if}
        </div>
      {/if}
      <div class="palette-input-wrap">
        <input
          class="palette-input"
          data-testid="palette-input"
          placeholder={p.placeholder}
          value={p.query}
          oninput={(e) => app.palette.setQuery(e.currentTarget.value)}
          autocomplete="off"
          spellcheck="false"
          {@attach !coarse && autofocus}
        />
        {#if p.anchor && PICKER_KEY[p.kind] && !coarse}<span class="kbd">{PICKER_KEY[p.kind]}</span>{/if}
      </div>
      <div class="palette-list" data-testid="palette-list" {@attach revealActive}>
        {#each p.items as item, i (item.id)}
          {#if item.section && item.section !== p.items[i - 1]?.section}
            <div class="palette-section">{item.section}</div>
          {/if}
          <button
            class={['menu-item', i === active && 'active', item.danger && 'danger']}
            data-testid="palette-item"
            data-id={item.id}
            data-index={i}
            onpointermove={() => app.palette.hover(i)}
            onclick={() => app.palette.choose(i)}
          >
            {#if item.checkbox}
              <span class={['box', item.checked && 'on']}>{#if item.checked}{@html ICON.check}{/if}</span>
            {:else if p.kind !== 'command' && p.kind !== 'search' && p.kind !== 'help' && p.kind !== 'filter'}
              <span class="check">{#if item.checked}{@html ICON.check}{/if}</span>
            {/if}
            {#if item.team && !item.icon}
              <TeamLogo team={item.team} />
            {:else if item.icon}
              <span class="icon">{@html item.icon}</span>
              {#if item.team}<TeamLogo team={item.team} size={14} />{/if}
            {:else if item.dot !== undefined}
              <span class="icon"><span class="label-dot" style:--hue={item.dot}></span></span>
            {/if}
            <span class="label">{item.label}</span>
            {#if item.detail}<span class="detail">{item.detail}</span>{/if}
            {#if item.snippet}<span class="snippet">{item.snippet}</span>{:else}<span class="grow"></span>{/if}
            {#if item.shortcut && !coarse}<span class="shortcut">{item.shortcut}</span>{/if}
            {#if item.submenu}<span class="icon arrow">{@html ICON.caretRight}</span>{/if}
          </button>
        {:else}
          <div class="palette-empty" data-testid="palette-empty">{t('No results')}</div>
        {/each}
      </div>
      {#if p.hint}<div class="palette-hint">{p.hint}</div>{/if}
      {#if p.calendar}
        {@const cal = p.calendar}
        <div class="calendar" data-testid="calendar">
          <div class="cal-head">
            <button class="icon-btn plain" aria-label={t('Previous month')} onclick={() => app.palette.shiftMonth(-1)}><span class="icon">{@html ICON.chevronLeft}</span></button>
            <span>{monthLabel(cal.month)}</span>
            <button class="icon-btn plain" aria-label={t('Next month')} onclick={() => app.palette.shiftMonth(1)}><span class="icon">{@html ICON.chevronRight}</span></button>
          </div>
          <div class="cal-grid">
            {#each WEEKDAYS as wd (wd)}<span class="cal-wd">{wd}</span>{/each}
            {#each monthDays(cal.month) as d (d.day)}
              <button class={['cal-day', d.other && 'other', d.day === todayDay && 'today', d.day === cal.selected && 'sel']} data-day={d.day} disabled={!!cal.min && d.day < cal.min} onclick={() => app.palette.pickDay(d.day)}>{parseDay(d.day).getDate()}</button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
{/key}{/if}
