<script lang="ts">
  // Priority limits (XLR8-91): at most N open urgent / high issues per team, for the whole instance.
  // "Warn" keeps the change and shows a hint, "Block" rejects it (app, MCP); recurrences and the import drop the priority.
  import { PRIORITY_ICON, PRIORITY_LABEL } from '@selfbound/core';
  import { limitsOf, priorityBudget } from '@selfbound/core/sprintlogic';
  import { t } from '@selfbound/core/i18n';
  import { PRIORITY_LIMIT_MAX, type PriorityLimit, type PriorityLimits } from '@selfbound/backend/shared/priorityLimits';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { admin } from './admin.ts';

  type Key = keyof PriorityLimits;
  type Mode = 'off' | 'warn' | 'block';
  const ROWS: { key: Key; priority: 1 | 2 }[] = [
    { key: 'urgent', priority: 1 },
    { key: 'high', priority: 2 },
  ];
  const MODES: [Mode, string][] = [
    ['off', t('No limit')],
    ['warn', t('Warn')],
    ['block', t('Block')],
  ];

  const metaSlice = fromSlice(app.store.meta);
  const versionSlice = fromSlice(app.store.version);
  const limits = $derived(limitsOf(metaSlice.current));
  // The fullest team per priority, so lowering a limit shows what already exceeds it.
  const fullest = $derived.by(() => {
    void versionSlice.current;
    const out = { urgent: { count: 0, team: '' }, high: { count: 0, team: '' } };
    for (const [teamId, b] of priorityBudget(app.store.all())) {
      const team = app.store.team(teamId)?.key ?? '';
      if (b.urgent > out.urgent.count) out.urgent = { count: b.urgent, team };
      if (b.high > out.high.count) out.high = { count: b.high, team };
    }
    return out;
  });
  // The number typed last per row, kept while "No limit" is chosen.
  let remembered = $state<Record<Key, number>>({ urgent: 1, high: 3 });
  $effect(() => {
    for (const { key } of ROWS) if (limits[key].max !== null) remembered[key] = limits[key].max!;
  });

  const modeOf = (limit: PriorityLimit): Mode => (limit.max === null ? 'off' : limit.hard ? 'block' : 'warn');

  function save(key: Key, limit: PriorityLimit) {
    void admin.setPriorityLimits({ ...limits, [key]: limit });
  }

  function setMode(key: Key, mode: Mode) {
    if (mode === modeOf(limits[key])) return;
    save(key, mode === 'off' ? { max: null, hard: false } : { max: limits[key].max ?? remembered[key], hard: mode === 'block' });
  }

  function setMax(key: Key, input: HTMLInputElement) {
    const value = Number(input.value);
    if (input.value.trim() === '' || !Number.isInteger(value) || value < 0 || value > PRIORITY_LIMIT_MAX) {
      input.value = String(limits[key].max ?? remembered[key]);
      return;
    }
    remembered[key] = value;
    if (value !== limits[key].max) save(key, { ...limits[key], max: value });
  }
</script>

<h1 class="page-title">{t('Priorities')}</h1>
<p class="page-lead">{t('How many open urgent and high issues a team may have. The limits apply to every team of this instance, each team counted on its own. Open means every status that is not done, canceled or a duplicate.')}</p>
<h2 class="section-title">{t('Limits per team')}</h2>
<div class="card-list" data-testid="priority-limits">
  {#each ROWS as row (row.key)}
    {@const limit = limits[row.key]}
    {@const mode = modeOf(limit)}
    {@const top = fullest[row.key]}
    <div class="card-row" data-testid="priority-limit-{row.key}" data-mode={mode}>
      <span class="icon">{@html PRIORITY_ICON[row.priority]}</span>
      <span class="t"
        >{PRIORITY_LABEL[row.priority]}<div class="sub">
          {#if mode === 'off'}{t('No limit: any number of open issues per team.')}
          {:else if mode === 'warn'}{t('More than {max} per team: the change is saved, with a hint.', { max: limit.max ?? 0 })}
          {:else}{t('More than {max} per team: the change is rejected, also for agents (MCP). Recurring issues and the import come without the priority.', { max: limit.max ?? 0 })}{/if}
          {#if limit.max !== null && top.count > limit.max}<br />{t('{team} already has {count}. They stay; only new ones count against the limit.', { team: top.team, count: top.count })}{/if}
        </div></span
      >
      {#if mode !== 'off'}
        <input
          class="input small num"
          type="number"
          min="0"
          max={PRIORITY_LIMIT_MAX}
          step="1"
          aria-label={t('Limit for {priority}', { priority: PRIORITY_LABEL[row.priority] })}
          data-testid="priority-limit-{row.key}-max"
          value={limit.max ?? remembered[row.key]}
          onchange={(e) => setMax(row.key, e.currentTarget)}
          onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      {/if}
      <span class="seg" data-testid="priority-limit-{row.key}-mode">
        {#each MODES as [value, label] (value)}<button class={[mode === value && 'on']} data-mode={value} onclick={() => setMode(row.key, value)}>{label}</button>{/each}
      </span>
    </div>
  {/each}
</div>
