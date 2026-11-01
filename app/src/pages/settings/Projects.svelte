<script lang="ts">
  // Projects per team (every project belongs to exactly one team and shows its logo). A project is
  // also a stage of the team's roadmap (SELF-113): goal, "ready when", a rough period and a color,
  // in the team's order (arrows). The details unfold per project.
  import { ICON, type TeamId } from '@selfbound/core';
  import { normalizePeriod } from '@selfbound/backend/shared/roadmap';
  import { t } from '@selfbound/core/i18n';
  import { PROJECT_STATE_LABEL, type ProjectState } from '@selfbound/core/app/admin';
  import type { ProjectDoc } from '@selfbound/core/types';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import TeamLogo from '../../components/TeamLogo.svelte';
  import InlineText from './InlineText.svelte';
  import HuePicker from './HuePicker.svelte';
  import { admin } from './admin.ts';

  const metaSlice = fromSlice(app.store.meta);
  const meta = $derived(metaSlice.current);
  const STATES = Object.entries(PROJECT_STATE_LABEL) as [ProjectState, string][];
  let addingFor = $state<string | null>(null);
  let name = $state('');
  let openId = $state<string | null>(null);
  let periodError = $state<string | null>(null);

  async function create(e: SubmitEvent, teamId: string) {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await admin.createProject(teamId as TeamId, name.trim());
    if (ok) {
      name = '';
      addingFor = null;
    }
  }

  function saveText(p: ProjectDoc, field: 'description' | 'readyWhen', value: string) {
    const next = value.trim();
    if (next === (p[field] ?? '')) return;
    void admin.updateProject(p._id, { [field]: next || null });
  }

  function savePeriod(p: ProjectDoc, value: string) {
    const raw = value.trim();
    if (!raw) {
      periodError = null;
      if (p.period) void admin.updateProject(p._id, { period: null });
      return;
    }
    const period = normalizePeriod(raw);
    if (!period) {
      periodError = t('A quarter like 2027-Q1 or a month like 2027-03.');
      return;
    }
    periodError = null;
    if (period !== p.period) void admin.updateProject(p._id, { period });
  }
</script>

<h1 class="page-title">{t('Projects')}</h1>
<p class="page-lead">{t('Every project belongs to exactly one team. In lists, the project is preceded by its team’s logo. On the roadmap, the projects are the stages in this order.')}</p>

{#each meta?.teams ?? [] as team (team._id)}
  {@const projects = meta!.projects.filter((p) => p.teamId === team._id).sort((a, b) => a.order - b.order)}
  <div class="section-head">
    <TeamLogo team={app.main.teamBadge(team._id)} />
    <h2 class="section-title inline">{team.name}</h2>
    <span class="sub">{projects.length}</span>
    <span class="bar-spacer"></span>
    <button class="btn ghost small" data-testid="project-add-{team.key}" onclick={() => { addingFor = team._id; name = ''; }}><span class="icon">{@html ICON.plus}</span>{t('Project')}</button>
  </div>
  <div class="card-list" data-testid="projects-{team.key}">
    {#each projects as p, i (p._id)}
      {@const open = openId === p._id}
      <div class="card-row" data-testid="project-row">
        <TeamLogo team={app.main.teamBadge(team._id)} size={14} />
        <span class="t"><InlineText value={p.name} label={t('Project name')} save={(v) => admin.updateProject(p._id, { name: v })} />{#if p.period && !open}<div class="sub">{p.period}</div>{/if}</span>
        <span class="dp-select">
          <select aria-label={t('Status')} value={p.state} onchange={(e) => admin.updateProject(p._id, { state: e.currentTarget.value as ProjectState })}>
            {#each STATES as [value, label] (value)}<option {value}>{label}</option>{/each}
          </select>
          <span class="icon">{@html ICON.chevronDown}</span>
        </span>
        <button class="icon-btn plain" aria-label={t('Move up')} title={t('Move up')} disabled={i === 0} data-testid="project-up" onclick={() => void admin.moveProject(p._id, -1)}><span class="icon">{@html ICON.chevronUp}</span></button>
        <button class="icon-btn plain" aria-label={t('Move down')} title={t('Move down')} disabled={i === projects.length - 1} data-testid="project-down" onclick={() => void admin.moveProject(p._id, 1)}><span class="icon">{@html ICON.chevronDown}</span></button>
        <button class="icon-btn plain" aria-expanded={open} aria-label={t('Roadmap details')} title={t('Roadmap details')} data-testid="project-details" onclick={() => { openId = open ? null : p._id; periodError = null; }}><span class={['icon', 'pj-chevron', open && 'open']}>{@html ICON.caretDown}</span></button>
      </div>
      {#if open}
        <div class="card-row pj-details" data-testid="project-fields">
          <label class="pj-field">
            <span>{t('Goal')}</span>
            <textarea class="input" rows="3" maxlength={2000} value={p.description ?? ''} placeholder={t('What this stage is about, in a few sentences.')} data-testid="project-goal" onblur={(e) => saveText(p, 'description', e.currentTarget.value)}></textarea>
          </label>
          <label class="pj-field">
            <span>{t('Ready when')}</span>
            <textarea class="input" rows="2" maxlength={2000} value={p.readyWhen ?? ''} placeholder={t('When the stage counts as done.')} data-testid="project-ready" onblur={(e) => saveText(p, 'readyWhen', e.currentTarget.value)}></textarea>
          </label>
          <div class="pj-line">
            <label class="pj-field">
              <span>{t('Period')}</span>
              <input class="input" value={p.period ?? ''} placeholder="2027-Q1" maxlength={20} data-testid="project-period" onblur={(e) => savePeriod(p, e.currentTarget.value)} onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
              {#if periodError}<span class="field-error" role="alert">{periodError}</span>{:else}<span class="sub">{t('Rough, no exact date: a quarter or a month.')}</span>{/if}
            </label>
            <div class="pj-field">
              <span>{t('Color')}</span>
              <span class="pj-hue">
                <HuePicker hue={p.hue ?? team.hue} label={t('Color on the roadmap')} testid="project-hue" pick={(h) => admin.updateProject(p._id, { hue: h })} />
                {#if p.hue !== undefined}<button class="btn ghost small" onclick={() => admin.updateProject(p._id, { hue: null })}>{t('Reset')}</button>{/if}
              </span>
            </div>
          </div>
        </div>
      {/if}
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

<style>
  .pj-details {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    padding-left: 38px;
  }
  .pj-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }
  .pj-field > span:first-child {
    font-size: var(--fs-small);
    font-weight: 590;
    color: var(--text-muted);
  }
  .pj-field textarea {
    resize: vertical;
    font: inherit;
  }
  .pj-field .sub {
    font-size: var(--fs-mini);
    color: var(--text-muted);
  }
  .pj-line {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  .pj-hue {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
  }
  .pj-chevron {
    transition: transform var(--dur-2) var(--ease);
    transform: rotate(-90deg);
  }
  .pj-chevron.open {
    transform: none;
  }
</style>
