<script lang="ts">
  import { ICON } from '@xlr8/core';
  import { t, tn } from '@xlr8/core/i18n';
  import { PROJECT_STATE_LABEL } from '@xlr8/core/app/admin';
  import { api } from '@xlr8/backend/api';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import TeamLogo from '../components/TeamLogo.svelte';

  const pageSlice = fromSlice(app.nav.page);
  const metaSlice = fromSlice(app.store.meta);
  const versionSlice = fromSlice(app.store.version);
  const teamKey = $derived(pageSlice.current.name === 'projects' ? pageSlice.current.team : '');
  const team = $derived(metaSlice.current?.teams.find((x) => x.key === teamKey));
  // Knowledge pages per project, queried only when the team has knowledge and the page is open.
  let pageCounts = $state<Record<string, number>>({});
  $effect(() => {
    const id = team?.wiki ? team._id : null;
    pageCounts = {};
    if (!id) return;
    const { slice, release } = app.store.watch(api.wiki.projectCounts, { teamId: id });
    const update = () => (pageCounts = slice.get() ?? {});
    update();
    const stop = slice.subscribe(update);
    return () => {
      stop();
      release();
    };
  });

  async function openPages(e: MouseEvent, projectId: string) {
    e.preventDefault();
    e.stopPropagation();
    const wiki = await app.loadWiki();
    app.nav.go({ name: 'wiki', team: teamKey });
    wiki.setFilter({ projectId, topicId: null });
  }

  const STATE: Record<string, string> = PROJECT_STATE_LABEL;

  const projects = $derived.by(() => {
    void versionSlice.current;
    const meta = metaSlice.current;
    if (!meta || !team) return [];
    const counts = new Map<string, { open: number; done: number }>();
    for (const issue of app.store.all()) {
      if (!issue.projectId || issue.deletedAt !== undefined || issue.teamId !== team._id) continue;
      const c = counts.get(issue.projectId) ?? { open: 0, done: 0 };
      if (issue.status === 'done') c.done++;
      else if (issue.status !== 'canceled' && issue.status !== 'duplicate') c.open++;
      counts.set(issue.projectId, c);
    }
    return meta.projects.filter((p) => p.teamId === team._id).map((p) => ({ ...p, counts: counts.get(p._id) ?? { open: 0, done: 0 } }));
  });
</script>

<header class="location-bar">
  <button class="icon-btn plain mobile-only" aria-label={t('Navigation')} onclick={() => app.toggleSidebar()}><span class="icon">{@html ICON.menu}</span></button>
  <div class="crumbs">
    {#if team}<span class="crumb"><TeamLogo team={app.main.teamBadge(team._id)} size={14} /><span class="crumb-title">{team.name}</span></span><span class="icon crumb-sep">{@html ICON.chevronRight}</span>{/if}
    <span class="crumb"><span class="icon">{@html ICON.projects}</span><span class="crumb-title">{t('Projects')}</span></span>
  </div>
</header>
<div class="page" data-testid="projects-page">
  <div class="page-content">
    {#if projects.length === 0}
      <div class="empty">
        <div class="empty-icon"><span class="icon">{@html ICON.projects}</span></div>
        <div class="empty-text">{team ? t('{team} has no projects yet. Create projects in the settings.', { team: team.name }) : t('This team has no projects yet. Create projects in the settings.')}</div>
        <button class="btn" onclick={() => app.nav.goView({ kind: 'active', team: teamKey })}>{t('Go to issues')}</button>
      </div>
    {:else}
      <div class="card-list">
        {#each projects as p (p._id)}
          {@const total = p.counts.open + p.counts.done}
          <a class="card-row" href="/team/{teamKey}/project/{p._id}" onclick={(e) => { e.preventDefault(); app.nav.goView({ kind: 'project', team: teamKey, project: p._id }); }}>
            <span class="icon" style="color: var(--text-muted)">{@html ICON.projects}</span>
            <span class="t">{p.name}<div class="sub">{STATE[p.state] ?? p.state} · {t('{count} open', { count: p.counts.open })} · {t('{count} done', { count: p.counts.done })}{#if pageCounts[p._id]} · <span role="link" tabindex="0" style="color: var(--accent-text); cursor: pointer" data-testid="project-pages" onclick={(e) => void openPages(e, p._id)} onkeydown={(e) => e.key === 'Enter' && void openPages(e as unknown as MouseEvent, p._id)}>{tn(pageCounts[p._id], '{count} page', '{count} pages')}</span>{/if}</div></span>
            <span class="progress" title={t('{pct} % done', { pct: total ? Math.round((p.counts.done / total) * 100) : 0 })}><div style:width="{total ? (p.counts.done / total) * 100 : 0}%"></div></span>
          </a>
        {/each}
      </div>
    {/if}
  </div>
</div>
