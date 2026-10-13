<script lang="ts">
  // Teams: list with logo, key, issue count, dormant; order; create a new team.
  import { ICON, type TeamId } from '@xlr8/core';
  import { t, tn } from '@xlr8/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import TeamLogo from '../../components/TeamLogo.svelte';
  import { admin } from './admin.ts';
  import { HUES } from '@xlr8/core/app/admin';

  const metaSlice = fromSlice(app.store.meta);
  const versionSlice = fromSlice(app.store.version);
  const darkSlice = fromSlice(app.prefs.dark);
  const teams = $derived(metaSlice.current?.teams ?? []);
  const counts = $derived.by(() => {
    void versionSlice.current;
    const c = new Map<string, number>();
    for (const i of app.store.all()) if (i.deletedAt === undefined && !i.pending) c.set(i.teamId, (c.get(i.teamId) ?? 0) + 1);
    return c;
  });

  let adding = $state(false);
  let name = $state('');
  let key = $state('');
  let keyTouched = $state(false);
  $effect(() => {
    if (!keyTouched) key = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
  });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim() || !key.trim()) return;
    const hue = HUES[teams.length % HUES.length];
    const result = await admin.createTeam({ key: key.trim(), name: name.trim(), hue });
    if (result) {
      app.toasts.show(t('Team {key} created', { key: result.key }));
      adding = false;
      name = '';
      keyTouched = false;
    }
  }

  function badge(id: string) {
    void darkSlice.current;
    void metaSlice.current;
    return app.main.teamBadge(id);
  }
  const open = (k: string) => app.nav.go({ name: 'settings', section: 'teams', sub: k });
</script>

<div class="title-row">
  <h1 class="page-title">{t('Teams')}</h1>
  <button class="btn small" data-testid="team-add" onclick={() => (adding = !adding)}><span class="icon">{@html ICON.plus}</span>{t('New team')}</button>
</div>
<p class="page-lead">{t('Same order as in the sidebar. Dormant teams are listed there under "More". Upload logos in the team.')}</p>

{#if adding}
  <form class="card-list form" onsubmit={create} data-testid="team-form">
    <label class="card-row"><span class="t">{t('Name')}</span><input class="input" data-testid="team-new-name" bind:value={name} placeholder={t('e.g. {example}', { example: 'Acme' })} {@attach (n) => n.focus()} /></label>
    <label class="card-row"><span class="t">{t('Key')}<div class="sub">{t('2–6 characters, capital letters and digits. Part of every identifier (ACME-12).')}</div></span><input class="input mono short" data-testid="team-new-key" bind:value={key} maxlength="6" oninput={() => (keyTouched = true)} /></label>
    <div class="card-row end"><button class="btn ghost small" type="button" onclick={() => (adding = false)}>{t('Cancel')}</button><button class="btn primary small" type="submit" data-testid="team-new-submit">{t('Create')}</button></div>
  </form>
{/if}

<div class="card-list" data-testid="team-list">
  {#each teams as team, i (team._id)}
    <div class="card-row link" data-testid="team-row" data-key={team.key}>
      <button class="row-link" onclick={() => open(team.key)} aria-label={t('Edit {name}', { name: team.name })}></button>
      <TeamLogo team={badge(team._id)} size={20} />
      <span class="t">{team.name}<div class="sub">{team.key} · {team.wiki === 'only' ? t('Knowledge only') : tn(counts.get(team._id) ?? 0, '{count} issue', '{count} issues')}{team.dormant ? ` · ${t('dormant')}` : ''}</div></span>
      <span class="row-tools">
        <button class="icon-btn plain" aria-label={t('Move up')} title={t('Move up')} disabled={i === 0} onclick={() => admin.moveTeam(team._id as TeamId, -1)}><span class="icon">{@html ICON.arrowUp}</span></button>
        <button class="icon-btn plain" aria-label={t('Move down')} title={t('Move down')} disabled={i === teams.length - 1} onclick={() => admin.moveTeam(team._id as TeamId, 1)}><span class="icon">{@html ICON.arrowDown}</span></button>
      </span>
      <span class="icon chev">{@html ICON.chevronRight}</span>
    </div>
  {/each}
</div>
