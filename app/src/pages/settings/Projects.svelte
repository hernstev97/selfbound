<script lang="ts">
  // Projects per team (every project belongs to exactly one team and shows its logo).
  import { ICON, type TeamId } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { PROJECT_STATE_LABEL, type ProjectState } from '@selfbound/core/app/admin';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import TeamLogo from '../../components/TeamLogo.svelte';
  import InlineText from './InlineText.svelte';
  import { admin } from './admin.ts';

  const metaSlice = fromSlice(app.store.meta);
  const meta = $derived(metaSlice.current);
  const STATES = Object.entries(PROJECT_STATE_LABEL) as [ProjectState, string][];
  let addingFor = $state<string | null>(null);
  let name = $state('');

  async function create(e: SubmitEvent, teamId: string) {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await admin.createProject(teamId as TeamId, name.trim());
    if (ok) {
      name = '';
      addingFor = null;
    }
  }
</script>

<h1 class="page-title">{t('Projects')}</h1>
<p class="page-lead">{t('Every project belongs to exactly one team. In lists, the project is preceded by its team’s logo.')}</p>

{#each meta?.teams ?? [] as team (team._id)}
  {@const projects = meta!.projects.filter((p) => p.teamId === team._id)}
  <div class="section-head">
    <TeamLogo team={app.main.teamBadge(team._id)} />
    <h2 class="section-title inline">{team.name}</h2>
    <span class="sub">{projects.length}</span>
    <span class="bar-spacer"></span>
    <button class="btn ghost small" data-testid="project-add-{team.key}" onclick={() => { addingFor = team._id; name = ''; }}><span class="icon">{@html ICON.plus}</span>{t('Project')}</button>
  </div>
  <div class="card-list" data-testid="projects-{team.key}">
    {#each projects as p (p._id)}
      <div class="card-row" data-testid="project-row">
        <TeamLogo team={app.main.teamBadge(team._id)} size={14} />
        <span class="t"><InlineText value={p.name} label={t('Project name')} save={(v) => admin.updateProject(p._id, { name: v })} /></span>
        <span class="dp-select">
          <select aria-label={t('Status')} value={p.state} onchange={(e) => admin.updateProject(p._id, { state: e.currentTarget.value as ProjectState })}>
            {#each STATES as [value, label] (value)}<option {value}>{label}</option>{/each}
          </select>
          <span class="icon">{@html ICON.chevronDown}</span>
        </span>
      </div>
    {/each}
    {#if addingFor === team._id}
      <form class="card-row" onsubmit={(e) => create(e, team._id)}>
        <input class="input grow" placeholder={t('Project name')} data-testid="project-new-name" bind:value={name} {@attach (n) => n.focus()} onkeydown={(e) => e.key === 'Escape' && (addingFor = null)} />
        <button class="btn primary small" type="submit">{t('Create')}</button>
      </form>
    {:else if projects.length === 0}
      <div class="card-row muted">{t('No projects yet.')}</div>
    {/if}
  </div>
{/each}
