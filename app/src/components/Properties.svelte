<script lang="ts">
  // Properties column on the right (stacked cards). Each row opens the same picker as its shortcut.
  import { ICON, PRIORITY_ICON, statusIcon, type DetailState, type PaletteKind } from '@selfbound/core';
  import { t, tn } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { anchorOf, tip } from '../lib/ui.ts';
  import { logoClass } from '../lib/providerLogo.ts';
  import TeamLogo from './TeamLogo.svelte';
  import IssuePublic from './IssuePublic.svelte';

  let { detail: d }: { detail: DetailState } = $props();

  // Inherited models are dimmed and name their source; the context window is info only.
  const modelNote = $derived.by(() => {
    const m = d.model;
    if (!m) return [];
    const source = m.source === 'parent' ? t('From parent {key}', { key: m.from ?? '' }) : m.source === 'team' ? t('Default of {team}', { team: m.from ?? '' }) : null;
    return [source, m.context].filter((x): x is string => !!x);
  });

  function open(kind: PaletteKind, e: MouseEvent & { currentTarget: HTMLElement }) {
    if (d.deleted) return;
    app.palette.open(kind, { anchor: anchorOf(e.currentTarget), target: { kind: 'issues', ids: [d.id] } });
  }
</script>

<div class="props-card">
  <button class="prop-row" data-testid="detail-status" title={tip(t('Change status'), 'issue.status')} onclick={(e) => open('status', e)}><span class="icon">{@html statusIcon(d.status, d.statusColor)}</span><span class="val">{d.statusLabel}</span></button>
  <button class="prop-row" data-testid="detail-priority" title={tip(t('Set priority'), 'issue.priority')} onclick={(e) => open('priority', e)}
    ><span class="icon">{@html PRIORITY_ICON[d.priority]}</span>{#if d.priority === 0}<span class="empty-val">{t('Priority')}</span>{:else}<span class="val">{d.priorityLabel}</span>{/if}</button
  >
  <button class="prop-row" data-testid="detail-estimate" title={tip(t('Estimate'), 'issue.estimate')} onclick={(e) => open('estimate', e)}
    ><span class="icon" style="color: var(--text-muted)">{@html ICON.estimate}</span>{#if d.estimate === null}<span class="empty-val">{t('Estimate')}</span>{:else}<span class="val">{tn(d.estimate, '{count} point', '{count} points')}</span>{/if}</button
  >
  <button class="prop-row" data-testid="detail-due" title={tip(t('Due date'), 'issue.due')} onclick={(e) => open('due', e)}
    ><span class="icon" style:color={d.due?.overdue ? 'var(--danger-text)' : 'var(--text-muted)'}>{@html ICON.calendar}</span>{#if !d.due}<span class="empty-val">{t('Due date')}</span>{:else}<span class="val" style:color={d.due.overdue ? 'var(--danger-text)' : undefined}>{d.due.long}</span>{/if}</button
  >
  {#if d.snoozable || d.snoozed}
    <button class="prop-row" data-testid="detail-snooze" title={tip(t('Snooze'), 'issue.snooze')} onclick={(e) => open('snooze', e)}
      ><span class="icon" style="color: var(--text-muted)">{@html ICON.snooze}</span>{#if !d.snoozed}<span class="empty-val">{t('Snooze')}</span>{:else}<span class="val">{t('Snoozed until {date}', { date: d.snoozed.long })}</span>{/if}</button
    >
  {/if}
</div>

<div class="props-card">
  <div class="props-title">{t('Labels')}</div>
  <div class="prop-labels" data-testid="detail-labels">
    {#each d.labels as label (label.id)}
      <button class="pill" onclick={(e) => open('labels', e)}><span class="label-dot" style:--hue={label.hue}></span>{label.name}</button>
    {/each}
    <button class="round-add" title={tip(t('Labels'), 'issue.labels')} aria-label={t('Add label')} data-testid="detail-add-label" onclick={(e) => open('labels', e)}><span class="icon">{@html ICON.plus}</span></button>
  </div>
</div>

<!-- Plain rows like the first card: icon and tooltip name the field, an empty one shows its noun. -->
<div class="props-card">
  <button class="prop-row" data-testid="detail-project" title={tip(t('Project'), 'issue.project')} onclick={(e) => open('project', e)}
    ><span class="icon" style="color: var(--text-muted)">{@html ICON.projects}</span>{#if d.project}<span class="val">{d.project.name}</span>{:else}<span class="empty-val">{t('Project')}</span>{/if}</button
  >
  <button class="prop-row" data-testid="detail-sprint" title={tip(t('Sprint'), 'issue.sprint')} onclick={(e) => open('sprint', e)}
    ><span class="icon" style="color: var(--text-muted)">{@html ICON.sprint}</span>{#if d.sprint}<span class="val">{d.sprint.name}{d.sprint.state === 'active' ? ` · ${t('running')}` : d.sprint.state === 'planning' ? ` · ${t('planned')}` : ''}{d.sprint.late ? ` · ${t('added late')}` : ''}</span>{:else}<span class="empty-val">{t('Sprint')}</span>{/if}</button
  >
  <button class="prop-row" data-testid="detail-model" title={tip(t('Model'), 'issue.model')} onclick={(e) => open('model', e)}
    ><span class={['icon mi', logoClass(d.model?.logo)]} style="color: var(--text-muted)"></span>{#if d.model}<span class={['val', d.model.source !== 'issue' && 'inherited']}>{d.model.label}</span>{:else}<span class="empty-val">{t('Model')}</span>{/if}</button
  >
  {#if modelNote.length || d.model?.problem}
    <div class="prop-note" data-testid="detail-model-note">{modelNote.join(' · ')}{#if d.model?.problem}<span class="warn">{modelNote.length ? ' · ' : ''}{d.model.problem}</span>{/if}</div>
  {/if}
  <button class="prop-row" data-testid="detail-parent" title={tip(t('Set parent'), 'issue.parent')} onclick={(e) => open('parent', e)}
    ><span class="icon" style="color: var(--text-muted)">{@html ICON.parent}</span>{#if d.parent}<span class="val">{d.parent.key} {d.parent.title}</span>{:else}<span class="empty-val">{t('Parent')}</span>{/if}</button
  >
</div>

<IssuePublic detail={d} />

<div class="props-card">
  <div class="prop-meta">
    <button class="prop-row" data-testid="detail-team" title={tip(t('Move to team'), 'issue.team')} onclick={(e) => open('team', e)}><TeamLogo team={d.team} size={14} /><span class="val">{d.team.name}</span></button>
    <div title={d.createdFull}>{d.createdBy === t('You') ? t('Created {when} by you', { when: d.created }) : t('Created {when} by {actor}', { when: d.created, actor: d.createdBy })}</div>
    <div>{t('Updated {when}', { when: d.updated })}</div>
  </div>
</div>
