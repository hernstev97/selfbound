// Texts of the pull request view.
import { t, tn, translated } from '@selfbound/core/i18n';
import type { MergeMethod, PrCheckState, PrDetail, PrReviewState, PrState, PrView } from '@selfbound/backend/shared/pullRequests';

export const STATE_LABEL: Record<PrState, string> = translated({ open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' });

export const CHECK_LABEL: Record<PrCheckState, string> = translated({
  success: 'Successful',
  failure: 'Failed',
  pending: 'Running or waiting',
  neutral: 'Neutral',
  skipped: 'Skipped',
  cancelled: 'Canceled',
});

export const METHOD_LABEL: Record<MergeMethod, string> = translated({ merge: 'Merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' });

/** Verb after the reviewer's name in the timeline. */
export function reviewLabel(state: PrReviewState | undefined) {
  if (state === 'approved') return t('approved');
  if (state === 'changes_requested') return t('requested changes');
  if (state === 'dismissed') return t('review (dismissed)');
  return t('wrote a review');
}

/** Check summary: failures first, then running checks, otherwise all passed. */
export function checksText(c: { failed: number; pending: number; total: number }) {
  if (c.failed) return t('{failed} of {total} checks failed', { failed: c.failed, total: c.total });
  if (c.pending) return t('{pending} of {total} checks running', { pending: c.pending, total: c.total });
  return tn(c.total, 'The check passed', 'All {count} checks passed');
}

/** One sentence on mergeability below the checks. */
export function mergeHint(pr: PrView['pr'], detail: PrDetail) {
  const base = detail.baseRef;
  if (pr.state === 'merged') {
    return detail.mergedBy ? t('Merged by {user} into {base}.', { user: detail.mergedBy.login, base }) : t('Merged into {base}.', { base });
  }
  if (pr.state === 'closed') return t('Closed without merging.');
  switch (detail.mergeState) {
    case 'clean':
      return t('No conflicts, ready to merge.');
    case 'unstable':
      return t('No conflicts, but not all checks are successful.');
    case 'dirty':
      return t('Conflicts with {base}. Resolve them on GitHub or locally.', { base });
    case 'blocked':
      return t('Merging is blocked by repository rules (reviews or required checks).');
    case 'behind':
      return t('The branch is behind {base}.', { base });
    case 'draft':
      return t('Draft: merging works once the pull request is marked ready on GitHub.');
    default:
      return t('GitHub is still checking whether the pull request can be merged …');
  }
}
