<script lang="ts">
  // Labels and label groups: create, rename, color, group (single choice yes/no), archive.
  import { ICON, type LabelGroupDoc } from '@selfbound/core';
  import { t, tn } from '@selfbound/core/i18n';
  import { HUES } from '@selfbound/core/app/admin';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import InlineText from './InlineText.svelte';
  import HuePicker from './HuePicker.svelte';
  import { admin } from './admin.ts';

  const metaSlice = fromSlice(app.store.meta);
  const versionSlice = fromSlice(app.store.version);
  const meta = $derived(metaSlice.current);
  let showArchived = $state(false);
  let newLabel = $state('');
  let newGroup = $state('');
  let newGroupExclusive = $state(true);
  let addLabelTo = $state<string | null>(null);

  const usage = $derived.by(() => {
    void versionSlice.current;
    const c = new Map<string, number>();
    for (const i of app.store.all()) if (i.deletedAt === undefined) for (const l of i.labelIds) c.set(l, (c.get(l) ?? 0) + 1);
    return c;
  });
  const groups = $derived([...(meta?.labelGroups ?? []).map((g) => ({ id: g._id as string, group: g })), { id: 'none', group: null }]);
  const labelsOf = (groupId: string) => (meta?.labels ?? []).filter((l) => (l.groupId ?? 'none') === groupId && (showArchived || !l.archived));

  async function createLabel(e: SubmitEvent, groupId: string) {
    e.preventDefault();
    if (!newLabel.trim()) return;
    const hue = HUES[(meta?.labels.length ?? 0) % HUES.length];
    const ok = await admin.createLabel({ name: newLabel.trim(), hue, ...(groupId !== 'none' ? { groupId: groupId as LabelGroupDoc['_id'] } : {}) });
    if (ok) {
      newLabel = '';
      addLabelTo = null;
    }
  }

  async function createGroup(e: SubmitEvent) {
    e.preventDefault();
    if (!newGroup.trim()) return;
    const ok = await admin.createGroup({ name: newGroup.trim(), exclusive: newGroupExclusive });
    if (ok) newGroup = '';
  }
</script>

<div class="title-row">
  <h1 class="page-title">{t('Labels')}</h1>
  <label class="check-label"><input type="checkbox" bind:checked={showArchived} /> {t('Show archived')}</label>
</div>
<p class="page-lead">{t('Single-choice groups allow only one label per issue (e.g. type: bug or feature). Archived labels stay on their issues but can no longer be assigned.')}</p>

{#each groups as { id, group } (id)}
  {@const labels = labelsOf(id)}
  <div class="section-head" data-testid="label-group" data-group={group?.name ?? 'none'}>
    {#if group}
      <HuePicker hue={group.hue} label={t('Group color')} pick={(h) => admin.updateGroup(group._id, { hue: h })} />
      <span class="section-title inline"><InlineText value={group.name} label={t('Group name')} save={(v) => admin.updateGroup(group._id, { name: v })} /></span>
      <label class="check-label" title={t('At most one label of this group per issue')}>
        <button class={['toggle small', group.exclusive && 'on']} role="switch" aria-checked={group.exclusive} aria-label={t('Single choice')} onclick={() => admin.updateGroup(group._id, { exclusive: !group.exclusive })}></button>{t('Single choice')}
      </label>
    {:else}
      <h2 class="section-title inline">{t('No group')}</h2>
    {/if}
    <span class="bar-spacer"></span>
    <button class="btn ghost small" data-testid="label-add-{group?.name ?? 'none'}" onclick={() => { addLabelTo = id; newLabel = ''; }}><span class="icon">{@html ICON.plus}</span>{t('Label')}</button>
  </div>
  <div class="card-list">
    {#each labels as l (l._id)}
      <div class={['card-row', l.archived && 'archived']} data-testid="label-row" data-name={l.name}>
        <HuePicker hue={l.hue} pick={(h) => admin.updateLabel(l._id, { hue: h })} />
        <span class="t"><InlineText value={l.name} label={t('Label name')} save={(v) => admin.updateLabel(l._id, { name: v })} /></span>
        <span class="sub">{tn(usage.get(l._id) ?? 0, '{count} issue', '{count} issues')}</span>
        <span class="dp-select">
          <select aria-label={t('Group')} value={l.groupId ?? 'none'} onchange={(e) => admin.updateLabel(l._id, { groupId: e.currentTarget.value === 'none' ? null : (e.currentTarget.value as never) })}>
            <option value="none">{t('No group')}</option>
            {#each meta?.labelGroups ?? [] as g (g._id)}<option value={g._id}>{g.name}</option>{/each}
          </select>
          <span class="icon">{@html ICON.chevronDown}</span>
        </span>
        <button class="btn ghost small" data-testid="label-archive" onclick={() => admin.updateLabel(l._id, { archived: !l.archived })}>{l.archived ? t('Unarchive') : t('Archive')}</button>
      </div>
    {/each}
    {#if addLabelTo === id}
      <form class="card-row" onsubmit={(e) => createLabel(e, id)}>
        <input class="input grow" placeholder={t('Label name')} data-testid="label-new-name" bind:value={newLabel} {@attach (n) => n.focus()} onkeydown={(e) => e.key === 'Escape' && (addLabelTo = null)} />
        <button class="btn primary small" type="submit">{t('Create')}</button>
      </form>
    {:else if labels.length === 0}
      <div class="card-row muted">{t('No labels.')}</div>
    {/if}
  </div>
{/each}

<h2 class="section-title">{t('New group')}</h2>
<form class="card-list form" onsubmit={createGroup}>
  <div class="card-row">
    <input class="input grow" placeholder={t('Group name, e.g. Area')} data-testid="group-new-name" bind:value={newGroup} />
    <label class="check-label"><input type="checkbox" bind:checked={newGroupExclusive} /> {t('Single choice')}</label>
    <button class="btn small" type="submit">{t('Create group')}</button>
  </div>
</form>
