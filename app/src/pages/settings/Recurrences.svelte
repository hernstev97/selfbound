<script lang="ts">
  // Recurring tasks: templates from which the hourly cron creates an issue on the due day
  // in the instance's time zone. Create them here or from an issue via "Repeat …".
  import { ICON, PRIORITY_ICON, PRIORITY_LABEL, dayLabel, type LabelId, type Priority, type TeamId } from '@selfbound/core';
  import { intlLocale, t } from '@selfbound/core/i18n';
  import { api } from '@selfbound/backend/api';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { useQuery } from '../../lib/live.svelte.ts';
  import TeamLogo from '../../components/TeamLogo.svelte';
  import Dialog from './Dialog.svelte';
  import { admin } from './admin.ts';

  // Monday first (weekday 1–7); 2024-01-01 was a Monday.
  const weekdayName = new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', timeZone: 'UTC' });
  const WEEKDAYS = Array.from({ length: 7 }, (_, i) => weekdayName.format(Date.UTC(2024, 0, 1 + i)));
  const list = useQuery(api.recurrences.list, {});
  const metaSlice = fromSlice(app.store.meta);
  const meta = $derived(metaSlice.current);
  const items = $derived([...(list.current ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || a.nextDate.localeCompare(b.nextDate)));

  let adding = $state(false);
  let teamId = $state('');
  let title = $state('');
  let description = $state('');
  let priority = $state<Priority>(0);
  let labelIds = $state<string[]>([]);
  let cadence = $state<'weekly' | 'monthly'>('weekly');
  let weekday = $state(1);
  let monthDay = $state(1);
  let removing = $state<{ _id: string; title: string } | null>(null);
  $effect(() => {
    if (!teamId && meta) teamId = meta.teams.find((x) => !x.dormant && x.wiki !== 'only')?._id ?? '';
  });
  const labels = $derived((meta?.labels ?? []).filter((l) => !l.archived && (!l.teamId || l.teamId === teamId)));

  function when(r: { cadence: string; weekday?: number; monthDay?: number }) {
    return r.cadence === 'weekly' ? t('Every week on {weekday}', { weekday: WEEKDAYS[(r.weekday ?? 1) - 1] }) : t('Every month on day {day}', { day: r.monthDay ?? 1 });
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!title.trim() || !teamId) return;
    const ok = await admin.createRecurrence({
      teamId: teamId as TeamId,
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      priority,
      labelIds: labelIds as LabelId[],
      cadence,
      ...(cadence === 'weekly' ? { weekday } : { monthDay }),
    });
    if (ok) {
      app.toasts.show(t('"{title}" created', { title: title.trim() }));
      title = '';
      description = '';
      labelIds = [];
      adding = false;
    }
  }

  function toggleLabel(id: string) {
    labelIds = labelIds.includes(id) ? labelIds.filter((l) => l !== id) : [...labelIds, id];
  }
</script>

<div class="title-row">
  <h1 class="page-title">{t('Recurrences')}</h1>
  <button class="btn small" data-testid="recurrence-add" onclick={() => (adding = !adding)}><span class="icon">{@html ICON.plus}</span>{t('New recurrence')}</button>
</div>
<p class="page-lead">{t('On the due day, Selfbound creates an issue with status Todo, due that day. From an issue, use the More menu: "Repeat …".')}</p>

{#if adding}
  <form class="card-list form" onsubmit={create} data-testid="recurrence-form">
    <label class="card-row"><span class="t">{t('Team')}</span>
      <span class="dp-select">
        <select data-testid="recurrence-team" value={teamId} onchange={(e) => (teamId = e.currentTarget.value)}>
          {#each meta?.teams.filter((x) => !x.dormant && x.wiki !== 'only') ?? [] as team (team._id)}<option value={team._id}>{team.name}</option>{/each}
        </select>
        <span class="icon">{@html ICON.chevronDown}</span>
      </span>
    </label>
    <label class="card-row"><span class="t">{t('Title')}</span><input class="input grow" data-testid="recurrence-title" bind:value={title} placeholder={t('e.g. Test-decrypt a backup')} /></label>
    <label class="card-row col"><span class="t">{t('Description')} <span class="sub">{t('optional, Markdown')}</span></span><textarea class="input" rows="2" bind:value={description}></textarea></label>
    <div class="card-row"><span class="t">{t('Priority')}</span>
      <span class="seg">
        {#each [0, 1, 2, 3, 4] as const as p (p)}<button type="button" class={[priority === p && 'on']} title={PRIORITY_LABEL[p]} aria-label={PRIORITY_LABEL[p]} onclick={() => (priority = p)}><span class="icon">{@html PRIORITY_ICON[p]}</span></button>{/each}
      </span>
    </div>
    {#if labels.length}
      <div class="card-row wrap"><span class="t">{t('Labels')}</span>
        <span class="label-chips">
          {#each labels as l (l._id)}<button type="button" class={['pill toggleable', labelIds.includes(l._id) && 'on']} onclick={() => toggleLabel(l._id)}><span class="label-dot" style:--hue={l.hue}></span>{l.name}</button>{/each}
        </span>
      </div>
    {/if}
    <div class="card-row"><span class="t">{t('Cadence')}</span>
      <span class="seg" data-testid="recurrence-cadence">
        <button type="button" class={[cadence === 'weekly' && 'on']} onclick={() => (cadence = 'weekly')}>{t('Weekly')}</button>
        <button type="button" class={[cadence === 'monthly' && 'on']} onclick={() => (cadence = 'monthly')}>{t('Monthly')}</button>
      </span>
      <span class="dp-select">
        {#if cadence === 'weekly'}
          <select aria-label={t('Weekday')} data-testid="recurrence-weekday" value={weekday} onchange={(e) => (weekday = Number(e.currentTarget.value))}>{#each WEEKDAYS as d, i (d)}<option value={i + 1}>{d}</option>{/each}</select>
        {:else}
          <select aria-label={t('Day of the month')} data-testid="recurrence-monthday" value={monthDay} onchange={(e) => (monthDay = Number(e.currentTarget.value))}>{#each Array.from({ length: 28 }, (_, i) => i + 1) as d (d)}<option value={d}>{t('on day {day}', { day: d })}</option>{/each}</select>
        {/if}
        <span class="icon">{@html ICON.chevronDown}</span>
      </span>
    </div>
    <div class="card-row end"><button class="btn ghost small" type="button" onclick={() => (adding = false)}>{t('Cancel')}</button><button class="btn primary small" type="submit" data-testid="recurrence-create">{t('Create')}</button></div>
  </form>
{/if}

<div class="card-list" data-testid="recurrence-list">
  {#if list.current === undefined}
    <div class="card-row muted">{t('Loading …')}</div>
  {:else if items.length === 0}
    <div class="card-row muted">{t('No recurrences yet.')}</div>
  {/if}
  {#each items as r (r._id)}
    <div class={['card-row', !r.active && 'archived']} data-testid="recurrence-row" data-title={r.title}>
      <TeamLogo team={app.main.teamBadge(r.teamId)} />
      <span class="icon">{@html PRIORITY_ICON[r.priority as Priority]}</span>
      <span class="t">{r.title}<div class="sub">{when(r)} · {r.active ? t('next on {date}', { date: dayLabel(r.nextDate) }) : t('paused')}</div></span>
      <button class="btn ghost small" data-testid="recurrence-pause" onclick={() => admin.setRecurrenceActive(r._id, !r.active)}>{r.active ? t('Pause') : t('Resume')}</button>
      <button class="btn ghost small danger" data-testid="recurrence-remove" onclick={() => (removing = r)}>{t('Delete')}</button>
    </div>
  {/each}
</div>

{#if removing}
  <Dialog title={t('Delete recurrence?')} close={() => (removing = null)} testid="recurrence-remove-dialog">
    <p class="dialog-text">{t('"{title}" will no longer create new issues. Issues already created stay. To suspend it, "Pause" is enough.', { title: removing.title })}</p>
    <div class="dialog-foot">
      <button class="btn ghost" onclick={() => (removing = null)}>{t('Cancel')}</button>
      <button class="btn danger-fill" data-testid="recurrence-remove-confirm" onclick={() => { const r = removing!; removing = null; void admin.removeRecurrence(r._id as never); }}>{t('Delete')}</button>
    </div>
  </Dialog>
{/if}
