<script lang="ts">
  // Override single colors of a theme. Takes effect right away in the whole app; the contrast check
  // applies here too (an "adjusted" note with the value that actually applies).
  import { ICON } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { look, overridesFor } from '../../lib/look/index.ts';
  import { VAR_GROUPS, VAR_GROUP_LABEL, VARS, type MappedTheme } from '../../lib/look/map.ts';
  import { fromSlice } from '../../slice.svelte.ts';

  let { ref, mapped }: { ref: string; mapped: MappedTheme } = $props();

  const settingsSlice = fromSlice(look.settings);
  const own = $derived(overridesFor(settingsSlice.current, ref));
  const fixed = $derived(new Map(mapped.fixes.map((f) => [f.name, f])));
</script>

<div class="theme-colors" data-testid="theme-colors">
  <div class="theme-colors-head">
    <span class="sub">{t('Custom colors apply only to this theme, on all devices.')}</span>
    {#if Object.keys(own).length}
      <button class="btn small" data-testid="theme-colors-reset" onclick={() => look.resetOverrides(ref)}>{t('Reset all')}</button>
    {/if}
  </div>
  {#each VAR_GROUPS as group (group)}
    <h4 class="theme-colors-group">{VAR_GROUP_LABEL[group]}</h4>
    <div class="theme-colors-grid">
      {#each VARS.filter((v) => v.group === group) as v (v.name)}
        {@const value = mapped.vars[v.name]}
        {@const fix = fixed.get(v.name)}
        <label class={['theme-color', own[v.name] && 'own']} data-testid="theme-color" data-name={v.name}>
          <input type="color" value={own[v.name] ?? value} aria-label={v.label} oninput={(e) => look.setOverride(ref, v.name, e.currentTarget.value, { debounce: true })} />
          <span class="theme-color-text">
            <span class="theme-color-label">{v.label}</span>
            <span class="theme-color-value">
              {value}{#if fix}<span class="theme-color-fix" title={t('Contrast before {ratio} : 1, required {min} : 1', { ratio: fix.ratio, min: fix.min })}>{t('adjusted from {value}', { value: own[v.name] ?? fix.before })}</span>{/if}
            </span>
          </span>
          {#if own[v.name]}
            <button class="icon-btn plain theme-color-reset" aria-label={t('Reset {name}', { name: v.label })} onclick={(e) => { e.preventDefault(); look.setOverride(ref, v.name, null); }}><span class="icon">{@html ICON.restore}</span></button>
          {/if}
        </label>
      {/each}
    </div>
  {/each}
</div>
