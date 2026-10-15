<script lang="ts">
  // Create dialog: team, title, description, property chips with the same pickers.
  // Ctrl Enter creates, Ctrl Shift Enter creates and stays open ("Create more").
  import { ICON, PRIORITY_ICON, PRIORITY_LABEL, statusIcon, dayLabel, formatShortcut, issueModel, modelLabel, type PaletteKind } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { leave } from '../lib/motion.ts';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import type { ImageField } from '../lib/imageInput.ts';
  import { anchorOf } from '../lib/ui.ts';
  import { modal } from '../lib/modal.ts';
  import ImageButton from './ImageButton.svelte';
  import TeamLogo from './TeamLogo.svelte';
  import TextEditor from './TextEditor.svelte';

  const stateSlice = fromSlice(app.create.state);
  const metaSlice = fromSlice(app.store.meta);
  const s = $derived(stateSlice.current);
  const d = $derived(s.draft);
  const meta = $derived(metaSlice.current);
  // Status in the chosen team (also depends on the metadata: statuses per team).
  const draftState = $derived((void meta, app.create.draftStateView(d)));
  const team = $derived(d.teamId ? app.main.teamBadge(d.teamId) : null);
  const labels = $derived(d.labelIds.map((id) => meta?.labels.find((l) => l._id === id)).filter((l) => !!l));
  const project = $derived(d.projectId ? meta?.projects.find((p) => p._id === d.projectId) : undefined);
  const sprint = $derived(d.sprintId ? meta?.sprints.find((x) => x._id === d.sprintId) : undefined);
  const parent = $derived(d.parentId ? app.store.get(d.parentId as never) : undefined);
  // The draft's own model, or what it will inherit (dimmed).
  const model = $derived(d.teamId ? issueModel(meta, { model: d.model ?? undefined, teamId: d.teamId as never }, parent) : null);

  let titleEl = $state<HTMLInputElement | null>(null);
  let descField = $state<ImageField | null>(null);
  // Focus the title only on open or a new focusTick, not on every draft change.
  const focusKey = $derived(s.open ? s.focusTick : 0);
  $effect(() => {
    if (focusKey && titleEl) queueMicrotask(() => titleEl?.focus());
  });

  // After a picker choice, focus returns to the chip that opened it, not to the title.
  // Same idea as focusKey: the effect depends only on "picker open?", not on the draft.
  const paletteSlice = fromSlice(app.palette.state);
  const pickerOpen = $derived(paletteSlice.current !== null);
  let pickedFrom: HTMLElement | null = null;
  $effect(() => {
    if (pickerOpen || !pickedFrom) return;
    const chip = pickedFrom;
    pickedFrom = null;
    queueMicrotask(() => {
      if (chip.isConnected) chip.focus();
    });
  });

  function pick(kind: PaletteKind, e: MouseEvent & { currentTarget: HTMLElement }) {
    pickedFrom = e.currentTarget;
    app.palette.open(kind, { anchor: anchorOf(e.currentTarget), target: { kind: 'draft' } });
  }
  const SUBMIT = formatShortcut('mod+enter');
</script>

{#if s.open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="overlay dim"
    data-testid="create-overlay"
    data-scrim
    out:leave
    onpointerdown={(e) => {
      if (e.target === e.currentTarget) app.create.close();
    }}
  ></div>
  <div class="create" data-testid="create-dialog" role="dialog" aria-modal="true" aria-label={t('New issue')} out:leave {@attach modal()}>
    <div class="create-head">
      <button class="chip" data-testid="create-team" onclick={(e) => pick('team', e)}>
        {#if team}<TeamLogo team={team} size={14} /><span class="chip-text">{team.key}</span>{:else}{t('Choose team')}{/if}
      </button>
      <span class="icon" style="color: var(--text-faint)">{@html ICON.chevronRight}</span>
      <span style="color: var(--text-muted); font-size: var(--fs-mini)">{d.parentId && parent ? t('Sub-issue of {key}', { key: parent.key }) : t('New issue')}</span>
      <span class="bar-spacer"></span>
      <button class="btn small" onclick={() => app.create.close()} title={t('Close and keep as draft')}>{t('Save as draft')}</button>
      <!-- × closes like Esc and keeps the content as a draft; Discard is at the bottom. -->
      <button class="icon-btn plain" aria-label={t('Close')} title={`${t('Close, the draft stays')} · ${formatShortcut('escape')}`} data-testid="create-close" onclick={() => app.create.close()}><span class="icon">{@html ICON.close}</span></button>
    </div>
    <div class="create-body">
      <input
        class="create-title"
        data-testid="create-title"
        data-autofocus
        placeholder={t('Issue title')}
        value={d.title}
        bind:this={titleEl}
        oninput={(e) => app.create.update({ title: e.currentTarget.value })}
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            (e.currentTarget.parentElement?.querySelector('.create-desc') as HTMLElement | null)?.focus();
          }
        }}
      />
      <TextEditor
        class="create-desc"
        testid="create-description"
        placeholder={t('Add description … ("/" for blocks, images with Ctrl V)')}
        label={t('Description')}
        value={d.description}
        onchange={(text) => app.create.update({ description: text })}
        upload={{ create: true }}
        bind:field={descField}
      />
    </div>
    <div class="create-chips">
      <button class="chip" data-testid="create-status" onclick={(e) => pick('status', e)}><span class="icon">{@html statusIcon(draftState.status, draftState.color)}</span>{draftState.name}</button>
      <button class={['chip', d.priority === 0 && 'unset']} data-testid="create-priority" onclick={(e) => pick('priority', e)}><span class="icon">{@html PRIORITY_ICON[d.priority]}</span>{d.priority === 0 ? t('Priority') : PRIORITY_LABEL[d.priority]}</button>
      <button class={['chip', !labels.length && 'unset']} data-testid="create-labels" onclick={(e) => pick('labels', e)}>
        {#if labels.length}
          {#each labels as label (label._id)}<span class="label-dot" style:--hue={label.hue}></span>{/each}<span class="chip-text">{labels.map((l) => l.name).join(', ')}</span>
        {:else}<span class="icon">{@html ICON.label}</span>{t('Labels')}{/if}
      </button>
      <button class={['chip', !project && 'unset']} data-testid="create-project" onclick={(e) => pick('project', e)}><span class="icon">{@html ICON.projects}</span><span class="chip-text">{project?.name ?? t('Project')}</span></button>
      <button class={['chip', d.estimate === null && 'unset']} data-testid="create-estimate" onclick={(e) => pick('estimate', e)}><span class="icon">{@html ICON.estimate}</span>{d.estimate ?? t('Estimate')}</button>
      <button class={['chip', !d.dueDate && 'unset']} data-testid="create-due" onclick={(e) => pick('due', e)}><span class="icon">{@html ICON.calendar}</span>{d.dueDate ? dayLabel(d.dueDate) : t('Due date')}</button>
      <button class={['chip', !sprint && 'unset']} data-testid="create-sprint" onclick={(e) => pick('sprint', e)}><span class="icon">{@html ICON.sprint}</span>{sprint?.name ?? t('Sprint')}</button>
      <button class={['chip', model?.source !== 'issue' && 'unset']} data-testid="create-model" title={model && model.source !== 'issue' ? t('Inherited') : undefined} onclick={(e) => pick('model', e)}><span class="icon">{@html ICON.model}</span><span class="chip-text">{model ? modelLabel(meta, model.choice) : t('Model')}</span></button>
      <button class={['chip', !parent && 'unset']} data-testid="create-parent" onclick={(e) => pick('parent', e)}><span class="icon">{@html ICON.parent}</span><span class="chip-text">{parent ? parent.key : t('Parent')}</span></button>
    </div>
    <div class="create-foot">
      <ImageButton field={() => descField} target={{ create: true }} />
      <button class="btn small ghost" data-testid="create-discard" data-sound="destructive" title={t('Discard content (undo in the toast)')} onclick={() => app.create.discard()}>{t('Discard')}</button>
      {#if s.error}<span class="error" data-testid="create-error">{s.error}</span>{/if}
      <span class="bar-spacer"></span>
      <button class="create-more" data-testid="create-more" onclick={() => app.create.toggleCreateMore()} title={`${t('Create more')} · ${formatShortcut('mod+shift+enter')}`}>
        <span class={['toggle', s.createMore && 'on']}></span>{t('Create more')}
      </button>
      <button class="btn primary" data-testid="create-submit" title={`${t('Create')} · ${SUBMIT}`} onclick={() => app.create.submit()}>{t('Create issue')}</button>
    </div>
  </div>
{/if}
