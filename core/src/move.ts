// "Move to team": what is lost or changes when issues switch teams, computed up front from the
// metadata (same rules as backend/convex/ops/move.ts). A pure function, so it is testable without
// UI and costs the list nothing.
import { matchingState } from '@selfbound/backend/shared/workflow';
import { t, tn } from './i18n.ts';
import type { Issue, Meta } from './types.ts';

export interface MovePlan {
  /** Projects that are dropped (names, no duplicates) */
  projects: string[];
  /** Issues whose project is dropped */
  projectIssues: number;
  /** Team labels of the old team that are dropped (names, no duplicates) */
  labels: string[];
  /** Status changes to a differently named status in the target team: "In progress → Running" */
  statuses: string[];
  /** Number of issues that actually change teams */
  count: number;
}

export function movePlan(meta: Meta | null, issues: readonly Issue[], teamId: string): MovePlan {
  const plan: MovePlan = { projects: [], projectIssues: 0, labels: [], statuses: [], count: 0 };
  if (!meta) return plan;
  const projects = new Set<string>();
  const labels = new Set<string>();
  const statuses = new Set<string>();
  const target = meta.workflowStates.filter((s) => s.teamId === teamId && s.archivedAt === undefined);
  for (const issue of issues) {
    if (issue.teamId === teamId) continue;
    plan.count++;
    const project = issue.projectId ? meta.projects.find((p) => p._id === issue.projectId) : undefined;
    if (issue.projectId && project?.teamId !== teamId) {
      plan.projectIssues++;
      if (project) projects.add(project.name);
    }
    for (const labelId of issue.labelIds) {
      const label = meta.labels.find((l) => l._id === labelId);
      if (label?.teamId && label.teamId !== teamId) labels.add(label.name);
    }
    const from = issue.stateId ? meta.workflowStates.find((s) => s._id === issue.stateId) : undefined;
    const to = from ? matchingState(target, from) : undefined;
    if (from && to && from.name.trim().toLowerCase() !== to.name.trim().toLowerCase()) statuses.add(`${from.name} → ${to.name}`);
  }
  plan.projects = [...projects];
  plan.labels = [...labels];
  plan.statuses = [...statuses];
  return plan;
}

/** Is something dropped that the user cannot easily get back (project, team labels)? */
export const hasLoss = (plan: MovePlan) => plan.projectIssues > 0 || plan.labels.length > 0;

/** Lines for the confirmation, such as 'Project "Export" is removed'. */
export function moveLines(plan: MovePlan, from: readonly string[], team: { name: string; key: string }): string[] {
  const lines: string[] = [];
  if (plan.projectIssues > 0) {
    const names = plan.projects.map((name) => t('“{name}”', { name })).join(', ');
    if (plan.count === 1) lines.push(t('Project {names} is removed (projects belong to one team).', { names }));
    else if (names) lines.push(tn(plan.projectIssues, '{count} issue loses its project: {names}.', '{count} issues lose their project: {names}.', { names }));
    else lines.push(tn(plan.projectIssues, '{count} issue loses its project.', '{count} issues lose their project.'));
  }
  if (plan.labels.length) lines.push(t('Labels of the old team are removed: {labels}.', { labels: plan.labels.join(', ') }));
  if (plan.statuses.length) lines.push(t('Status: {values}.', { values: plan.statuses.join(', ') }));
  lines.push(
    from.length === 1
      ? t('New ID in {team}, {key} stays valid as a link.', { team: team.key, key: from[0] })
      : t('New IDs in {team}, the old ones stay valid as links.', { team: team.key }),
  );
  return lines;
}
