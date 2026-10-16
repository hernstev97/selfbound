<script lang="ts">
  // Default model of a team (XLR8-93): for its issues that set no model and whose parent sets none.
  // Step by step like the chip: model (enabled ones, grouped by provider), then effort, then speed.
  import { ICON, modelInfo, modelKey, type ModelChoice, type TeamDoc, type TeamId } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { parseModelKey, speedsOf, STANDARD_SPEED } from '@selfbound/backend/shared/models';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { admin } from './admin.ts';

  let { team }: { team: TeamDoc } = $props();
  const metaSlice = fromSlice(app.store.meta);
  const meta = $derived(metaSlice.current);
  const current = $derived(team.defaultModel ?? null);
  const info = $derived(current ? modelInfo(meta, current) : undefined);
  const groups = $derived.by(() => {
    const by = new Map<string, { provider: string; name: string; models: { key: string; name: string }[] }>();
    for (const m of meta?.models ?? []) {
      if (m.removed) continue;
      const g = by.get(m.provider) ?? { provider: m.provider, name: m.providerName, models: [] };
      g.models.push({ key: modelKey(m.provider, m.modelId), name: m.name });
      by.set(m.provider, g);
    }
    return [...by.values()];
  });

  function save(choice: ModelChoice | null) {
    void admin.setTeamModel(team._id as TeamId, choice);
  }
  function pickModel(key: string) {
    const id = parseModelKey(key);
    // A new model starts without effort and speed: the old values may not exist there.
    save(id ? { provider: id.provider, modelId: id.modelId } : null);
  }
</script>

<div class="card-row wrap" data-testid="team-model">
  <span class="t"
    >{t('Default model')}
    <div class="sub">{t('For issues of this team that set no model and whose parent sets none. Agents see it in get_issue and list_issues.')}{#if current && !info}<span class="warn-text">{` ${t('Not enabled in the settings')}`}</span>{/if}</div></span
  >
  <span class="dp-select">
    <select aria-label={t('Default model')} data-testid="team-model-model" value={current ? modelKey(current.provider, current.modelId) : ''} onchange={(e) => pickModel(e.currentTarget.value)}>
      <option value="">{t('None')}</option>
      {#if current && !info}<option value={modelKey(current.provider, current.modelId)}>{current.modelId}</option>{/if}
      {#each groups as g (g.provider)}
        <optgroup label={g.name}>{#each g.models as m (m.key)}<option value={m.key}>{m.name}</option>{/each}</optgroup>
      {/each}
    </select>
    <span class="icon">{@html ICON.chevronDown}</span>
  </span>
  {#if current && info?.efforts.length}
    <span class="dp-select">
      <select aria-label={t('Effort')} data-testid="team-model-effort" value={current.effort ?? ''} onchange={(e) => save({ ...current, effort: e.currentTarget.value || undefined })}>
        <option value="">{t('Default effort')}</option>
        {#each info.efforts as effort (effort)}<option value={effort}>{effort}</option>{/each}
      </select>
      <span class="icon">{@html ICON.chevronDown}</span>
    </span>
  {/if}
  {#if current && info?.modes.length}
    <span class="dp-select">
      <select aria-label={t('Speed')} data-testid="team-model-speed" value={current.speed ?? STANDARD_SPEED} onchange={(e) => save({ ...current, speed: e.currentTarget.value === STANDARD_SPEED ? undefined : e.currentTarget.value })}>
        {#each speedsOf(info) as speed (speed)}<option value={speed}>{speed === STANDARD_SPEED ? t('Standard speed') : speed}</option>{/each}
      </select>
      <span class="icon">{@html ICON.chevronDown}</span>
    </span>
  {/if}
</div>

<style>
  .warn-text {
    color: var(--warning-text);
  }
</style>
