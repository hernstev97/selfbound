<script lang="ts">
  // Workflow statuses of a team, grouped by type. Per status: name, color, order within the type,
  // default for new issues, archive with "move issues to …". The type is fixed; for another type,
  // create a new status and move the issues.
  import { ICON, statusIcon, workflowsOf, type StateDoc, type StateId, type TeamDoc, type TeamId } from '@selfbound/core';
  import { t, tn } from '@selfbound/core/i18n';
  import { STATE_COLORS } from '@selfbound/core/app/admin';
  import { STATE_TYPES, STATE_TYPE_LABEL, defaultState, statusOfState, suggestedExceptions, type StateType } from '@selfbound/backend/shared/workflow';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import InlineText from './InlineText.svelte';
  import Dialog from './Dialog.svelte';
  import { admin } from './admin.ts';

  let { team }: { team: TeamDoc } = $props();
  const metaSlice = fromSlice(app.store.meta);
  const versionSlice = fromSlice(app.store.version);
  const workflows = $derived(workflowsOf(metaSlice.current));
  let showArchived = $state(false);
  let adding = $state<StateType | null>(null);
  let newName = $state('');
  let colorFor = $state<StateId | null>(null);
  let archiving = $state<StateDoc | null>(null);
  let moveTo = $state<string>('');
  let exFrom = $state<string>('');
  let exTo = $state<string>('');

  const strict = $derived(team.workflow?.strict ?? false);
  const exceptions = $derived(team.workflow?.exceptions ?? []);
  const nameOf = (id: string) => states.find((s) => s._id === id)?.name ?? '?';

  /** Turning it on without own exceptions sets the suggested ones (no dead ends). */
  function toggleStrict() {
    if (strict) void admin.setWorkflow(team._id as TeamId, { strict: false });
    else void admin.setWorkflow(team._id as TeamId, { strict: true, ...(exceptions.length ? {} : { exceptions: suggestedExceptions(active) as { from: StateId; to: StateId }[] }) });
  }

  function addException(e: SubmitEvent) {
    e.preventDefault();
    if (!exFrom || !exTo || exFrom === exTo) return;
    if (exceptions.some((x) => x.from === exFrom && x.to === exTo)) return;
    void admin.setWorkflow(team._id as TeamId, { exceptions: [...exceptions, { from: exFrom as StateId, to: exTo as StateId }] });
    exFrom = '';
    exTo = '';
  }

  function removeException(index: number) {
    void admin.setWorkflow(team._id as TeamId, { exceptions: exceptions.filter((_, i) => i !== index) });
  }

  const states = $derived(workflows.allOf(team._id));
  const active = $derived(states.filter((s) => s.archivedAt === undefined));
  const standard = $derived(defaultState(states, team.workflow));
  /** Issues per status (excluding trash), from the client store. */
  const usage = $derived.by(() => {
    void versionSlice.current;
    const c = new Map<string, number>();
    for (const i of app.store.all()) if (i.teamId === team._id && i.deletedAt === undefined && i.stateId) c.set(i.stateId, (c.get(i.stateId) ?? 0) + 1);
    return c;
  });
  const ofType = (type: StateType) => states.filter((s) => s.type === type && (showArchived || s.archivedAt === undefined)).sort((a, b) => a.position - b.position);
  const needed = (s: StateDoc) => (s.type === 'unstarted' || s.type === 'completed' || s.type === 'canceled') && active.filter((x) => x.type === s.type).length === 1;
  const canDefault = (s: StateDoc) => s.type === 'backlog' || s.type === 'unstarted' || s.type === 'started';

  async function create(e: SubmitEvent, type: StateType) {
    e.preventDefault();
    if (!newName.trim()) return;
    const ok = await admin.createState({ teamId: team._id as TeamId, name: newName.trim(), type });
    if (ok) {
      newName = '';
      adding = null;
    }
  }

  function startArchive(s: StateDoc) {
    if ((usage.get(s._id) ?? 0) === 0) {
      void admin.archiveState(s._id);
      return;
    }
    archiving = s;
    moveTo = active.find((x) => x._id !== s._id && x.type === s.type)?._id ?? active.find((x) => x._id !== s._id)?._id ?? '';
  }

  async function confirmArchive() {
    const s = archiving;
    if (!s || !moveTo) return;
    archiving = null;
    const result = await admin.archiveState(s._id, moveTo as StateId);
    if (result) app.toasts.show(result.more ? tn(result.moved, '"{name}" archived, {count} issue moved (the rest follows shortly)', '"{name}" archived, {count} issues moved (the rest follows shortly)', { name: s.name }) : tn(result.moved, '"{name}" archived, {count} issue moved', '"{name}" archived, {count} issues moved', { name: s.name }));
  }
</script>

<div class="section-head">
  <h2 class="section-title inline">{t('Workflow')}</h2>
  <span class="bar-spacer"></span>
  <label class="check-label"><input type="checkbox" bind:checked={showArchived} data-testid="states-show-archived" /> {t('Show archived')}</label>
</div>
<p class="section-lead">{t('Statuses of this team, sorted by type. New issues start in the default status, issues from agents in triage. A status is never deleted, only archived.')}</p>

<div data-testid="workflow" data-team={team.key}>
  {#each STATE_TYPES as type (type)}
    {@const list = ofType(type)}
    <div class="section-head small" data-testid="state-type" data-type={type}>
      <span class="sub-title">{t(STATE_TYPE_LABEL[type])}</span>
      <span class="bar-spacer"></span>
      {#if !(type === 'triage' && active.some((s) => s.type === 'triage'))}
        <button class="btn ghost small" data-testid="state-add-{type}" onclick={() => { adding = type; newName = ''; }}><span class="icon">{@html ICON.plus}</span>{t('Status')}</button>
      {/if}
    </div>
    <div class="card-list">
      {#each list as s, i (s._id)}
        <div class={['card-row', 'state-row', s.archivedAt !== undefined && 'archived']} data-testid="state-row" data-name={s.name}>
          <span class="state-move">
            <button class="icon-btn plain small" aria-label={t('Move up')} disabled={i === 0 || s.archivedAt !== undefined} onclick={() => admin.moveState(s._id, -1)}><span class="icon">{@html ICON.chevronUp}</span></button>
            <button class="icon-btn plain small" aria-label={t('Move down')} disabled={i === list.length - 1 || s.archivedAt !== undefined} onclick={() => admin.moveState(s._id, 1)}><span class="icon">{@html ICON.chevronDown}</span></button>
          </span>
          <button class="state-color" aria-label={t('Color')} title={t('Color')} data-testid="state-color" onclick={() => (colorFor = colorFor === s._id ? null : s._id)}>
            <span class="icon">{@html statusIcon(statusOfState(s), s.color)}</span>
          </button>
          <span class="t"><InlineText value={s.name} label={t('Status name')} testid="state-name" maxlength={40} save={(v) => admin.updateState(s._id, { name: v })} /></span>
          <span class="sub" data-testid="state-usage">{tn(usage.get(s._id) ?? 0, '{count} issue', '{count} issues')}</span>
          {#if s._id === standard?._id}
            <span class="pill" data-testid="state-default" title={t('New issues start here')}>{t('Default')}</span>
          {:else if canDefault(s) && s.archivedAt === undefined}
            <button class="btn ghost small" data-testid="state-make-default" onclick={() => admin.setWorkflow(team._id as TeamId, { defaultStateId: s._id })}>{t('Make default')}</button>
          {/if}
          {#if s.archivedAt !== undefined}
            <button class="btn ghost small" data-testid="state-restore" onclick={() => admin.restoreState(s._id)}>{t('Unarchive')}</button>
          {:else}
            <button
              class="btn ghost small"
              data-testid="state-archive"
              disabled={needed(s) || team.workflow?.defaultStateId === s._id}
              title={needed(s) ? t('The last status of this type is required') : team.workflow?.defaultStateId === s._id ? t('Choose another default first') : ''}
              onclick={() => startArchive(s)}>{t('Archive')}</button
            >
          {/if}
        </div>
        {#if colorFor === s._id}
          <div class="card-row color-row" data-testid="state-colors">
            <button class={['swatch', 'auto', !s.color && 'on']} title={t('Color of the status type')} aria-label={t('Default color')} onclick={() => { void admin.updateState(s._id, { color: null }); colorFor = null; }}></button>
            {#each STATE_COLORS as c (c)}
              <button class={['swatch', s.color === c && 'on']} style:background={c} aria-label={t('Color {color}', { color: c })} onclick={() => { void admin.updateState(s._id, { color: c }); colorFor = null; }}></button>
            {/each}
          </div>
        {/if}
      {/each}
      {#if adding === type}
        <form class="card-row" onsubmit={(e) => create(e, type)}>
          <input class="input grow" placeholder={t('Status name, e.g. Ready for Planning')} data-testid="state-new-name" maxlength="40" bind:value={newName} {@attach (n) => n.focus()} onkeydown={(e) => e.key === 'Escape' && (adding = null)} />
          <button class="btn primary small" type="submit">{t('Create')}</button>
        </form>
      {:else if list.length === 0}
        <div class="card-row muted">{t('No status of this type.')}</div>
      {/if}
    </div>
  {/each}
</div>

<div class="section-head">
  <h2 class="section-title inline">{t('Fixed order')}</h2>
  <span class="bar-spacer"></span>
  <button class={['toggle', strict && 'on']} role="switch" aria-checked={strict} aria-label={t('Fixed order')} data-testid="workflow-strict" onclick={toggleStrict}></button>
</div>
<p class="section-lead">
  {t('When on, issues go through the statuses only in order. Cancel and duplicate always work, and from triage any backlog or planned status. Exceptions allow further paths. Automation (GitHub merge, sprint close, recurrences), team moves and undo are exempt.')}
</p>
{#if strict}
  <div class="card-list" data-testid="workflow-chain">
    <div class="card-row chain">
      {#each active.filter((s) => s.type !== 'canceled') as s, i (s._id)}
        {#if i > 0}<span class="muted">→</span>{/if}
        <span class="chain-step"><span class="icon">{@html statusIcon(statusOfState(s), s.color)}</span>{s.name}</span>
      {/each}
    </div>
  </div>
  <h3 class="sub-title exceptions-title">{t('Exceptions')}</h3>
  <div class="card-list" data-testid="workflow-exceptions">
    {#each exceptions as ex, i (`${ex.from}>${ex.to}`)}
      <div class="card-row" data-testid="workflow-exception" data-from={nameOf(ex.from)} data-to={nameOf(ex.to)}>
        <span class="t">{nameOf(ex.from)} → {nameOf(ex.to)}</span>
        <button class="btn ghost small" data-testid="workflow-exception-remove" onclick={() => removeException(i)}>{t('Remove')}</button>
      </div>
    {:else}
      <div class="card-row muted">{t('No exceptions.')}</div>
    {/each}
    <form class="card-row" onsubmit={addException}>
      <span class="dp-select">
        <select aria-label={t('From')} data-testid="workflow-exception-from" bind:value={exFrom}>
          <option value="">{t('From …')}</option>
          {#each active as s (s._id)}<option value={s._id}>{s.name}</option>{/each}
        </select>
        <span class="icon">{@html ICON.chevronDown}</span>
      </span>
      <span class="muted">→</span>
      <span class="dp-select">
        <select aria-label={t('To')} data-testid="workflow-exception-to" bind:value={exTo}>
          <option value="">{t('To …')}</option>
          {#each active.filter((s) => s._id !== exFrom) as s (s._id)}<option value={s._id}>{s.name}</option>{/each}
        </select>
        <span class="icon">{@html ICON.chevronDown}</span>
      </span>
      <span class="bar-spacer"></span>
      <button class="btn small" type="submit" data-testid="workflow-exception-add" disabled={!exFrom || !exTo}>{t('Add exception')}</button>
    </form>
  </div>
{/if}

{#if archiving}
  <Dialog title={t('Archive "{name}"', { name: archiving.name })} testid="state-archive-dialog" close={() => (archiving = null)}>
    {@const affected = usage.get(archiving._id) ?? 0}
    <p class="dialog-text">{tn(affected, '{count} issue is in this status. Where should it move?', '{count} issues are in this status. Where should they move?')}</p>
    <span class="dp-select">
      <select aria-label={t('Target')} data-testid="state-move-to" bind:value={moveTo}>
        {#each active.filter((x) => x._id !== archiving?._id) as x (x._id)}<option value={x._id}>{x.name} ({t(STATE_TYPE_LABEL[x.type])})</option>{/each}
      </select>
      <span class="icon">{@html ICON.chevronDown}</span>
    </span>
    <div class="dialog-foot">
      <button class="btn ghost" onclick={() => (archiving = null)}>{t('Cancel')}</button>
      <button class="btn primary" data-testid="state-archive-confirm" disabled={!moveTo} onclick={confirmArchive}>{t('Move and archive')}</button>
    </div>
  </Dialog>
{/if}

<style>
  .state-move {
    display: inline-flex;
    flex-direction: column;
  }
  .state-move .icon-btn {
    height: 12px;
  }
  .state-color {
    display: inline-flex;
    align-items: center;
    padding: 2px;
    border-radius: 4px;
  }
  .state-color:hover {
    background: var(--bg-hover);
  }
  .color-row {
    gap: 6px;
    flex-wrap: wrap;
  }
  .swatch {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid transparent;
  }
  .swatch.on {
    border-color: var(--text);
  }
  .swatch.auto {
    background: conic-gradient(#bec2c8, #f1bf00, #4cb782, #5e6ad2, #95a2b3, #bec2c8);
  }
  .chain {
    flex-wrap: wrap;
    gap: 6px;
  }
  .chain-step {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .exceptions-title {
    margin: 16px 0 6px;
  }
  .sub-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
</style>
