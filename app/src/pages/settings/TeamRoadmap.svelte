<script lang="ts">
  // Roadmap of a team (SELF-113): on or off (entry in the sidebar), the label group whose labels are
  // the categories (in their order), the stage each status shows as, and the branding of the image
  // export (title, subtitle, accent color; the logo is the team logo above).
  import { ICON, workflowsOf, type StateId, type TeamDoc, type TeamId } from '@selfbound/core';
  import { STAGE_CHOICES, defaultStage, type StageChoice } from '@selfbound/backend/shared/roadmap';
  import { byLabelOrder } from '@selfbound/core/roadmap';
  import { hueColor } from '@selfbound/core/app/roadmap';
  import type { LabelGroupDoc } from '@selfbound/core/types';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { STAGE_TEXT } from '../roadmap/labels.ts';
  import { admin } from './admin.ts';

  let { team }: { team: TeamDoc } = $props();
  const metaSlice = fromSlice(app.store.meta);
  const meta = $derived(metaSlice.current);
  const settings = $derived(team.roadmap ?? { on: false });
  const groups = $derived((meta?.labelGroups ?? []).filter((g) => !g.teamId || g.teamId === team._id));
  const categories = $derived(settings.categoryGroupId ? (meta?.labels ?? []).filter((l) => l.groupId === settings.categoryGroupId && !l.archived).sort(byLabelOrder) : []);
  const states = $derived(workflowsOf(meta).allOf(team._id).filter((s) => s.archivedAt === undefined));
  const id = $derived(team._id as TeamId);

  function stageOf(stateId: string): StageChoice | '' {
    return settings.stages?.find((m) => m.stateId === stateId)?.stage ?? '';
  }

  /** '' = back to the default of the status type. */
  function setStage(stateId: StateId, stage: StageChoice | '') {
    const rest = (settings.stages ?? []).filter((m) => m.stateId !== stateId);
    void admin.updateRoadmap(id, { stages: stage ? [...rest, { stateId, stage }] : rest });
  }

  function saveText(field: 'title' | 'subtitle', value: string) {
    const next = value.trim();
    if (next === (settings[field] ?? '')) return;
    void admin.updateRoadmap(id, { [field]: next || null });
  }

  const fallbackAccent = $derived(hueColor(team.hue));
  let accentTimer: ReturnType<typeof setTimeout> | null = null;
  /** The color picker reports while dragging; save once it rests. */
  function pickAccent(value: string) {
    if (accentTimer) clearTimeout(accentTimer);
    accentTimer = setTimeout(() => void admin.updateRoadmap(id, { accent: value }), 300);
  }

  const groupName = (g: LabelGroupDoc) => (g.teamId ? g.name : t('{name} (workspace)', { name: g.name }));
</script>

<h2 class="section-title">{t('Roadmap')}</h2>
<p class="section-lead">{t('The projects are the stages of the roadmap, in their order. The labels of one group are its categories. Only issues marked as public appear in the image export.')}</p>
<div class="card-list" data-testid="team-roadmap">
  <div class="card-row">
    <span class="t">{t('Roadmap')}<div class="sub">{t('Shows "Roadmap" in the sidebar with the release view and the progress tracker.')}</div></span>
    <button class={['toggle', settings.on && 'on']} role="switch" aria-checked={settings.on} aria-label={t('Roadmap')} data-testid="team-roadmap-on" onclick={() => void admin.updateRoadmap(id, { on: !settings.on })}></button>
  </div>
  {#if settings.on}
    <div class="card-row">
      <span class="t">{t('Categories')}<div class="sub">{t('A label group; an exclusive group works best (one category per issue).')}</div></span>
      <span class="dp-select">
        <select aria-label={t('Categories')} data-testid="team-roadmap-group" value={settings.categoryGroupId ?? ''} onchange={(e) => void admin.updateRoadmap(id, { categoryGroupId: (e.currentTarget.value || null) as never })}>
          <option value="">{t('None')}</option>
          {#each groups as g (g._id)}<option value={g._id}>{groupName(g)}{g.exclusive ? ` · ${t('one per issue')}` : ''}</option>{/each}
        </select>
        <span class="icon">{@html ICON.chevronDown}</span>
      </span>
    </div>
    {#if categories.length}
      <div class="card-row column" data-testid="team-roadmap-categories">
        <span class="t">{t('Order of the categories')}</span>
        <ol class="rm-order">
          {#each categories as label, i (label._id)}
            <li>
              <span class="label-dot" style:--hue={label.hue}></span>
              <span class="grow">{label.name}</span>
              <button class="icon-btn plain" aria-label={t('Move up')} disabled={i === 0} onclick={() => void admin.moveLabel(label._id, -1)}><span class="icon">{@html ICON.chevronUp}</span></button>
              <button class="icon-btn plain" aria-label={t('Move down')} disabled={i === categories.length - 1} onclick={() => void admin.moveLabel(label._id, 1)}><span class="icon">{@html ICON.chevronDown}</span></button>
            </li>
          {/each}
        </ol>
      </div>
    {:else if settings.categoryGroupId}
      <div class="card-row muted">{t('The group has no labels yet. Add them under Settings → Labels.')}</div>
    {/if}
    <div class="card-row column" data-testid="team-roadmap-stages">
      <span class="t">{t('Status on the roadmap')}<div class="sub">{t('What each status shows as on the roadmap. "Not shown" keeps its issues off the roadmap.')}</div></span>
      <div class="rm-stage-map">
        {#each states as s (s._id)}
          <label class="rm-stage-line">
            <span class="grow">{s.name}</span>
            <span class="dp-select">
              <select aria-label={t('Roadmap status for {status}', { status: s.name })} data-testid="team-roadmap-stage" data-state={s.name} value={stageOf(s._id)} onchange={(e) => setStage(s._id as StateId, e.currentTarget.value as StageChoice | '')}>
                <option value="">{t('Default: {stage}', { stage: STAGE_TEXT[defaultStage(s)] })}</option>
                {#each STAGE_CHOICES as stage (stage)}<option value={stage}>{STAGE_TEXT[stage]}</option>{/each}
              </select>
              <span class="icon">{@html ICON.chevronDown}</span>
            </span>
          </label>
        {/each}
      </div>
    </div>
    <div class="card-row">
      <span class="t">{t('Export title')}<div class="sub">{t('Empty: the team name.')}</div></span>
      <input class="input" value={settings.title ?? ''} placeholder={team.name} maxlength={80} data-testid="team-roadmap-title" onblur={(e) => saveText('title', e.currentTarget.value)} onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
    </div>
    <div class="card-row">
      <span class="t">{t('Export subtitle')}<div class="sub">{t('Optional, e.g. "Early access".')}</div></span>
      <input class="input" value={settings.subtitle ?? ''} maxlength={160} data-testid="team-roadmap-subtitle" onblur={(e) => saveText('subtitle', e.currentTarget.value)} onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
    </div>
    <div class="card-row">
      <span class="t">{t('Accent color')}<div class="sub">{t('For the image export. Empty: the team color.')}</div></span>
      <input type="color" class="rm-color" aria-label={t('Accent color')} data-testid="team-roadmap-accent" value={settings.accent ?? fallbackAccent} oninput={(e) => pickAccent(e.currentTarget.value)} />
      {#if settings.accent}<button class="btn ghost small" onclick={() => void admin.updateRoadmap(id, { accent: null })}>{t('Reset')}</button>{/if}
    </div>
  {/if}
</div>

<style>
  .card-row.column {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .rm-order {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .rm-order li,
  .rm-stage-line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .rm-stage-map {
    display: flex;
    flex-direction: column;
  }
  .rm-color {
    width: 44px;
    height: 32px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: none;
  }
</style>
