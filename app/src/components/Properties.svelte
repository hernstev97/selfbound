<script lang="ts">
  // Properties column on the right (stacked cards). Each row opens the same picker as its shortcut.
  import { ICON, PRIORITY_ICON, statusIcon, type DetailState, type PaletteKind } from '@xlr8/core';
  import { t, tn } from '@xlr8/core/i18n';
  import { app } from '../app-instance.ts';
  import { anchorOf, tip } from '../lib/ui.ts';
  import TeamLogo from './TeamLogo.svelte';

  let { detail: d }: { detail: DetailState } = $props();

  function open(kind: PaletteKind, e: MouseEvent & { currentTarget: HTMLElement }) {
    if (d.deleted) return;
    app.palette.open(kind, { anchor: anchorOf(e.currentTarget), target: { kind: 'issues', ids: [d.id] } });
  }
</script>

<div class="props-card">
  <button class="prop-row" data-testid="detail-status" title={tip(t('Change status'), 'issue.status')} onclick={(e) => open('status', e)}><span class="icon">{@html statusIcon(d.status, d.statusColor)}</span><span class="val">{d.statusLabel}</span></button>
  <button class="prop-row" data-testid="detail-priority" title={tip(t('Set priority'), 'issue.priority')} onclick={(e) => open('priority', e)}
    ><span class="icon">{@html PRIORITY_ICON[d.priority]}</span>{#if d.priority === 0}<span class="empty-val">{t('Set priority')}</span>{:else}<span class="val">{d.priorityLabel}</span>{/if}</button
  >
  <button class="prop-row" data-testid="detail-estimate" title={tip(t('Estimate'), 'issue.estimate')} onclick={(e) => open('estimate', e)}
    ><span class="icon" style="color: var(--text-muted)">{@html ICON.estimate}</span>{#if d.estimate === null}<span class="empty-val">{t('Set estimate')}</span>{:else}<span class="val">{tn(d.estimate, '{count} point', '{count} points')}</span>{/if}</button
  >
  <button class="prop-row" data-testid="detail-due" title={tip(t('Due date'), 'issue.due')} onclick={(e) => open('due', e)}
    ><span class="icon" style:color={d.due?.overdue ? 'var(--danger-text)' : 'var(--text-muted)'}>{@html ICON.calendar}</span>{#if !d.due}<span class="empty-val">{t('Set due date')}</span>{:else}<span class="val" style:color={d.due.overdue ? 'var(--danger-text)' : undefined}>{d.due.long}</span>{/if}</button
  >
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

<div class="props-card">
  <div class="props-title">{t('Project')}</div>
  <button class="prop-row" data-testid="detail-project" title={tip(t('Project'), 'issue.project')} onclick={(e) => open('project', e)}
    ><span class="icon" style="color: var(--text-muted)">{@html ICON.projects}</span>{#if d.project}<span class="val">{d.project.name}</span>{:else}<span class="empty-val">{t('Choose project')}</span>{/if}</button
  >
  <div class="props-title">{t('Sprint')}</div>
  <button class="prop-row" data-testid="detail-sprint" title={tip(t('Sprint'), 'issue.sprint')} onclick={(e) => open('sprint', e)}
    ><span class="icon" style="color: var(--text-muted)">{@html ICON.sprint}</span>{#if d.sprint}<span class="val">{d.sprint.name}{d.sprint.state === 'active' ? ` · ${t('running')}` : d.sprint.state === 'planning' ? ` · ${t('planned')}` : ''}{d.sprint.late ? ` · ${t('added late')}` : ''}</span>{:else}<span class="empty-val">{t('Add to sprint')}</span>{/if}</button
  >
  <div class="props-title">{t('Parent')}</div>
  <button class="prop-row" data-testid="detail-parent" title={tip(t('Set parent'), 'issue.parent')} onclick={(e) => open('parent', e)}
    ><span class="icon" style="color: var(--text-muted)">{@html ICON.parent}</span>{#if d.parent}<span class="val">{d.parent.key} {d.parent.title}</span>{:else}<span class="empty-val">{t('Set parent')}</span>{/if}</button
  >
</div>

<div class="props-card">
  <div class="prop-meta">
    <button class="prop-row" data-testid="detail-team" title={tip(t('Move to team'), 'issue.team')} onclick={(e) => open('team', e)}><TeamLogo team={d.team} size={14} /><span class="val">{d.team.name}</span></button>
    <div title={d.createdFull}>{t('Created {when} by {actor}', { when: d.created, actor: d.createdBy })}</div>
    <div>{t('Updated {when}', { when: d.updated })}</div>
  </div>
</div>
