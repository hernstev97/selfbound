<script lang="ts">
  import '../styles/detail.css';
  import '../styles/overlays.css';
  import { ICON, PRIORITY_ICON, STATUS_ICON, statusIcon, type PaletteKind } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { anchorOf, tip } from '../lib/ui.ts';
  import TeamLogo from '../components/TeamLogo.svelte';
  import Description from '../components/Description.svelte';
  import Activity from '../components/Activity.svelte';
  import Properties from '../components/Properties.svelte';
  import IssueKnowledge from '../components/IssueKnowledge.svelte';
  import IssuePullRequests from '../components/pr/IssuePullRequests.svelte';
  import DetailSkeleton from '../components/DetailSkeleton.svelte';

  /** Right-hand side of the split inbox instead of a page of its own */
  let { split = false }: { split?: boolean } = $props();

  const detailSlice = fromSlice(app.detail.state);
  const shellSlice = fromSlice(app.shell);
  const pageSlice = fromSlice(app.nav.page);
  const d = $derived(detailSlice.current);
  const missingKey = $derived(pageSlice.current.name === 'issue' ? pageSlice.current.key : '');

  // Inline title: local text, saved on Enter or blur.
  let title = $state('');
  let editingTitle = $state(false);
  $effect(() => {
    if (!editingTitle && d) title = d.title;
  });
  function saveTitle() {
    editingTitle = false;
    const next = title.replace(/\s+/g, ' ').trim();
    if (d && next && next !== d.title) app.edit.patch([d.id], { title: next });
    else if (d) title = d.title;
  }

  function open(kind: PaletteKind, e: MouseEvent & { currentTarget: HTMLElement }) {
    if (!d) return;
    app.palette.open(kind, { anchor: anchorOf(e.currentTarget), target: { kind: 'issues', ids: [d.id] } });
  }
</script>

<header class="location-bar" data-testid={split ? 'split-bar' : 'location-bar'}>
  <button class="icon-btn plain mobile-only" aria-label={t('Back')} data-testid="detail-back-mobile" onclick={() => app.closeIssue()}><span class="icon">{@html ICON.back}</span></button>
  <div class="crumbs">
    {#if d}
      <a class="crumb" href="/team/{d.team.key}" onclick={(e) => { e.preventDefault(); app.nav.goView({ kind: 'active', team: d!.team.key }); }}>
        <TeamLogo team={d.team} size={14} /><span class="crumb-title">{d.team.name}</span>
      </a>
      <span class="icon crumb-sep">{@html ICON.chevronRight}</span>
      <span class="crumb"><span class="crumb-title tnum" data-testid="detail-key">{d.key}</span></span>
      <span class="crumb desktop-only" style="color: var(--text-muted); font-weight: 450"><span class="crumb-title">{d.title}</span></span>
    {:else}
      <span class="crumb"><span class="crumb-title">{missingKey}</span></span>
    {/if}
  </div>
  <span class="bar-spacer"></span>
  {#if d}
    {#if d.position}
      <span class="detail-nav desktop-only" data-testid="detail-position">
        {d.position.index + 1} / {d.position.total}
        <button class="icon-btn" title={tip(t('Previous issue'), 'nav.up')} aria-label={t('Previous issue')} onclick={() => app.detail.step(-1)}><span class="icon">{@html ICON.chevronUp}</span></button>
        <button class="icon-btn" title={tip(t('Next issue'), 'nav.down')} aria-label={t('Next issue')} onclick={() => app.detail.step(1)}><span class="icon">{@html ICON.chevronDown}</span></button>
      </span>
    {/if}
    {#if split}
      {#if d.inInbox}
        <button class="icon-btn plain" title={tip(d.unread ? t('Mark as read') : t('Mark as unread'), d.unread ? 'inbox.read' : 'inbox.unread')} aria-label={d.unread ? t('Mark as read') : t('Mark as unread')} data-testid="split-read" onclick={() => app.edit.markRead([d!.id], d!.unread, { undo: true })}><span class="icon">{@html ICON.eye}</span></button>
        <button class="btn ghost small" title={tip(t('Remove only the entry; the issue stays'), 'inbox.remove')} data-testid="split-remove" onclick={() => app.edit.removeFromInbox([d!.id])}><span class="icon">{@html ICON.check}</span><span class="btn-label">{t('Remove')}</span></button>
      {/if}
      <button class="icon-btn plain" title={tip(t('Open as a page'), 'issue.open')} aria-label={t('Open as a page')} data-testid="split-open" onclick={() => app.openIssue(d!.id)}><span class="icon">{@html ICON.open}</span></button>
    {/if}
    <button class="icon-btn plain" title={tip(t('Copy ID'), 'issue.copyKey')} aria-label={t('Copy ID')} data-testid="copy-key" onclick={() => app.edit.copyKeys([d!.id])}><span class="icon">{@html ICON.copy}</span></button>
    <button class="icon-btn plain" title={tip(t('Copy link'), 'issue.copyLink')} aria-label={t('Copy link')} data-testid="copy-link" onclick={() => app.edit.copyLink(d!.id)}><span class="icon">{@html ICON.link}</span></button>
    <button class="icon-btn plain" title={tip(t('Copy branch name'), 'issue.copyBranch')} aria-label={t('Copy branch name')} data-testid="copy-branch" onclick={() => app.edit.copyBranch(d!.id)}><span class="icon">{@html ICON.branch}</span></button>
    <button
      class="icon-btn plain"
      title={t('More actions')}
      aria-label={t('More actions')}
      onclick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        app.menu.open(d!.id, r.right - 220, r.bottom + 4);
      }}><span class="icon">{@html ICON.more}</span></button
    >
  {/if}
</header>

{#if !d && shellSlice.current.issue !== 'missing'}
  <!-- Data not there yet (packs loading): placeholder instead of an empty panel. -->
  <DetailSkeleton header={false} />
{:else if !d}
  <div class="detail-missing" data-testid="detail-missing">
    <div class="empty-icon"><span class="icon">{@html ICON.issues}</span></div>
    <div>{t('{key} does not exist (or no longer exists).', { key: missingKey })}</div>
    <button class="btn" onclick={() => app.closeIssue()}>{t('Back')}</button>
  </div>
{:else}
  <div class="detail" data-testid="detail" data-id={d.id}>
    <div class="detail-main">
      <div class="detail-content">
        {#if d.deleted}
          <div class="desc-conflict" style="margin-bottom: 16px">
            <span class="grow">{t('This issue is in the trash.')}</span>
            <button class="btn small" onclick={() => app.edit.restore([d!.id])}>{t('Restore')}</button>
          </div>
        {/if}
        {#if d.parent}
          <button class="btn ghost small parent-link" data-testid="detail-parent-link" onclick={() => app.openIssue(d!.parent!.id)}>
            <span class="icon">{@html ICON.parent}</span><span class="parent-title">{d.parent.key} {d.parent.title}</span>
          </button>
        {/if}
        <textarea
          class="detail-title"
          data-testid="detail-title"
          rows="1"
          bind:value={title}
          onfocus={() => (editingTitle = true)}
          onblur={saveTitle}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.currentTarget as HTMLTextAreaElement).blur();
            } else if (e.key === 'Escape') {
              title = d!.title;
            }
          }}
          disabled={d.deleted}
        ></textarea>

        <div class="mobile-props">
          <button class="chip" onclick={(e) => open('status', e)}><span class="icon">{@html statusIcon(d.status, d.statusColor)}</span>{d.statusLabel}</button>
          <button class="chip" onclick={(e) => open('priority', e)}><span class="icon">{@html PRIORITY_ICON[d.priority]}</span>{d.priorityLabel}</button>
          <button class="chip" onclick={(e) => open('labels', e)}><span class="icon">{@html ICON.label}</span>{d.labels.length ? d.labels.map((l) => l.name).join(', ') : t('Labels')}</button>
          <button class={['chip', !d.project && 'unset']} onclick={(e) => open('project', e)}><span class="icon">{@html ICON.projects}</span>{d.project?.name ?? t('Project')}</button>
          <button class={['chip', !d.sprint && 'unset']} onclick={(e) => open('sprint', e)}><span class="icon">{@html ICON.sprint}</span>{d.sprint?.name ?? t('Sprint')}</button>
          <button class={['chip', !d.due && 'unset']} onclick={(e) => open('due', e)}><span class="icon">{@html ICON.calendar}</span>{d.due?.long ?? t('Due date')}</button>
          {#if d.snoozable || d.snoozed}
            <button class={['chip', !d.snoozed && 'unset']} data-testid="issue-snooze" onclick={(e) => open('snooze', e)}><span class="icon">{@html ICON.snooze}</span>{d.snoozed ? t('Snoozed until {date}', { date: d.snoozed.long }) : t('Snooze')}</button>
          {/if}
          <button class={['chip', d.estimate === null && 'unset']} onclick={(e) => open('estimate', e)}><span class="icon">{@html ICON.estimate}</span>{d.estimate ?? t('Estimate')}</button>
        </div>

        <Description detail={d} />

        <div class="section-title">
          {t('Sub-issues')} {#if d.children.length}<span class="muted">{d.children.filter((c) => c.status === 'done').length}/{d.children.length}</span>{/if}
          <span class="bar-spacer"></span>
          {#if !d.deleted && !d.pending}
            <button class="btn ghost small" data-testid="add-subissue" title={tip(t('Create sub-issue'), 'issue.subissue')} onclick={() => app.create.openSubIssue(d!.id)}><span class="icon">{@html ICON.plus}</span>{t('Create sub-issue')}</button>
          {/if}
        </div>
        {#if d.children.length}
          <div class="sub-list" data-testid="subissues">
            {#each d.children as child (child.id)}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div class="sub-row" onclick={() => app.openIssue(child.id)}>
                <span class="icon">{@html PRIORITY_ICON[child.priority]}</span>
                <span class="icon">{@html STATUS_ICON[child.status]}</span>
                <span class="key">{child.key}</span>
                <span class="t">{child.title}</span>
              </div>
            {/each}
          </div>
        {/if}

        {#if d.relations.length}
          <div class="section-title">{t('Relations')}</div>
          {#each d.relations as group (group.label)}
            <div class="props-title" style="padding-left: 10px">{group.label}</div>
            <div class="sub-list">
              {#each group.items as rel (rel.relationId)}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <div class="sub-row" onclick={() => app.openIssue(rel.id)}>
                  <span class="icon">{@html STATUS_ICON[rel.status]}</span>
                  <span class="key">{rel.key}</span>
                  <span class={['t', rel.deleted && 'deleted']}>{rel.title}</span>
                  <button
                    class="icon-btn plain x"
                    aria-label={t('Remove relation')}
                    title={t('Remove relation')}
                    onclick={(e) => {
                      e.stopPropagation();
                      void app.detail.removeRelation(rel.relationId);
                    }}><span class="icon">{@html ICON.close}</span></button
                  >
                </div>
              {/each}
            </div>
          {/each}
        {/if}

        <IssueKnowledge issueId={d.id} />

        <IssuePullRequests pullRequests={d.pullRequests} {split} />

        <Activity detail={d} />
      </div>
    </div>
    <aside class="props-col" data-testid="properties">
      <Properties detail={d} />
    </aside>
  </div>
{/if}
