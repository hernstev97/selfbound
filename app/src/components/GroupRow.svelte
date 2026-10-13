<script lang="ts">
  import { type ListRow, type Draft } from '@xlr8/core';
  import { t } from '@xlr8/core/i18n';
  import type { ListController } from '@xlr8/core/app/list';
  import { app } from '../app-instance.ts';
  import TeamLogo from './TeamLogo.svelte';

  type GroupListRow = Extract<ListRow, { kind: 'group' }>;
  // `cols`: column icons (lib/columns.ts groupColsHtml), the same text for all headers.
  let { row, top, list = app.main, cols }: { row: GroupListRow; top: number; list?: ListController; cols: string } = $props();

  const TINT: Record<string, string> = {
    triage: 'var(--status-triage)',
    backlog: 'var(--status-backlog)',
    todo: 'var(--status-todo)',
    in_progress: 'var(--status-progress)',
    in_review: 'var(--status-review)',
    done: 'var(--status-done)',
    canceled: 'var(--status-canceled)',
    duplicate: 'var(--status-canceled)',
  };
  const tint = $derived(row.group.status ? (row.group.color ?? TINT[row.group.status]) : row.group.priority === 1 ? 'var(--urgent)' : undefined);

  // "+" creates an issue with the group's value.
  function add(e: MouseEvent) {
    e.stopPropagation();
    const g = row.group;
    const ctx: Partial<Draft> = {};
    // Group status: the status with this name in the draft's team.
    if (g.by === 'status' && g.status) {
      ctx.status = g.status;
      ctx.stateName = g.label;
    }
    if (g.by === 'priority' && g.priority !== undefined) ctx.priority = g.priority;
    if (g.by === 'team') ctx.teamId = g.value;
    if (g.by === 'project' && g.value !== 'none') ctx.projectId = g.value;
    if (g.by === 'sprint' && g.value !== 'none') ctx.sprintId = g.value;
    if (g.by === 'scope') ctx.sprintId = app.store.meta.get()?.sprints.find((s) => s.state === 'active')?._id ?? null;
    app.create.open(ctx);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="group-row" data-testid="group-header" data-group={row.group.value} data-status={row.group.status} style:top="{top}px" onclick={() => list.toggleGroup(row.key)}>
  <div class="group-box" style:--tint={tint}>
    <button class={['group-chevron', row.collapsed && 'closed']} aria-label={row.collapsed ? t('Expand') : t('Collapse')} aria-expanded={!row.collapsed}><span class="icon mi ui-caretDown"></span></button>
    {#if row.group.status}
      <span class="icon mi s-{row.group.status}" style:color={row.group.color}></span>
    {:else if row.group.priority !== undefined}
      <span class="icon mi p-priority p-{row.group.priority}"></span>
    {:else if row.group.team}
      <TeamLogo team={row.group.team} />
    {:else if row.group.by === 'project'}
      <span class="icon mi ui-projects" style="color: var(--text-muted)"></span>
    {:else if row.group.by === 'sprint' || row.group.by === 'scope'}
      <span class="icon mi ui-sprint" style:color={row.group.value === 'late' ? 'var(--status-progress)' : 'var(--text-muted)'}></span>
    {/if}
    <span>{row.group.label}</span>
    <span class="group-count">{row.count}</span>
    {#if row.group.budget}
      <span class={['group-budget', row.group.overBudget && 'over']} data-testid="group-budget" title={t('Priority budget: at most 1 urgent and 3 high open')}>{row.group.budget}</span>
    {/if}
    {@html cols}
    <button class="group-add" title={t('Create issue in this group')} aria-label={t('Create issue')} onclick={add}><span class="icon mi ui-plus"></span></button>
  </div>
</div>
