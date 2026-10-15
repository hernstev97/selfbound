<script lang="ts">
  // Pick the theme for one mode: Selfbound, bundled and custom themes of matching lightness as cards with
  // color swatches, below them a preview, contrast notes and custom colors.
  import { t } from '@selfbound/core/i18n';
  import { BUILTIN } from '../../lib/look/builtin.ts';
  import { look, SELFBOUND_THEME } from '../../lib/look/index.ts';
  import { varLabel, type MappedTheme } from '../../lib/look/map.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { SWATCHES } from '../../themes/swatches.ts';
  import ThemeColors from './ThemeColors.svelte';
  import ThemePreview from './ThemePreview.svelte';

  let { mode }: { mode: 'dark' | 'light' } = $props();

  // Selfbound without a theme: values from app.css (sidebar, content, text, accent, keyword, string, function).
  const SELFBOUND_SWATCH = {
    dark: ['#0a0a0b', '#131315', '#e4e4e7', '#5e6ad2', '#c39bea', '#8fd19d', '#8db8f0'],
    light: ['#f3f3f4', '#fcfcfd', '#2d2d33', '#5e6ad2', '#8237ad', '#2c6a39', '#245ea8'],
  };

  const settingsSlice = fromSlice(look.settings);
  const settings = $derived(settingsSlice.current);
  const themesSlice = fromSlice(look.themes);
  const fixesSlice = fromSlice(look.fixes);
  const selected = $derived(settings[mode]);
  const options = $derived([
    { ref: SELFBOUND_THEME, name: 'Selfbound', author: t('Default'), swatch: SELFBOUND_SWATCH[mode] as string[] | null },
    ...BUILTIN.filter((b) => b.type === mode).map((b) => ({ ref: b.id, name: b.name, author: b.author, swatch: SWATCHES[b.id] as string[] | null })),
    ...themesSlice.current.filter((c) => c.type === mode).map((c) => ({ ref: `custom:${c.id}`, name: c.name, author: t('Custom theme'), swatch: null as string[] | null, at: c.updatedAt })),
  ]);
  const selectedName = $derived(options.find((o) => o.ref === selected)?.name ?? 'Selfbound');

  // Mapping of the selected theme for preview and colors (loads only this theme).
  let mapped = $state<MappedTheme | null>(null);
  let customSwatch = $state<Record<string, string[]>>({});
  // Also refresh when the selected custom theme was edited (updatedAt).
  const selectedAt = $derived(themesSlice.current.find((c) => `custom:${c.id}` === selected)?.updatedAt);
  $effect(() => {
    const ref = selected;
    void settings.overrides;
    void selectedAt;
    let stale = false;
    look
      .mapped(ref)
      .then((m) => {
        if (!stale) mapped = m && m.type === mode ? m : null;
      })
      .catch(() => {
        if (!stale) mapped = null;
      });
    return () => (stale = true);
  });
  // Swatches of custom themes (few, small), per revision
  $effect(() => {
    for (const c of themesSlice.current) {
      const ref = `custom:${c.id}`;
      const slot = `${ref}@${c.updatedAt}`;
      if (c.type !== mode || customSwatch[slot]) continue;
      look
        .mapped(ref)
        .then((m) => {
          if (m) customSwatch = { ...customSwatch, [slot]: [m.vars['bg-app'], m.vars['bg-panel'], m.vars.text, m.vars.accent, m.vars['syn-keyword'], m.vars['syn-string'], m.vars['syn-func']] };
        })
        .catch(() => {});
    }
  });
  const fixes = $derived(selected === SELFBOUND_THEME ? [] : fixesSlice.current[mode]);
  let colorsOpen = $state(false);
</script>

<div class="theme-mode" data-testid="theme-picker-{mode}">
  <div class="theme-mode-head">
    <h3 class="theme-mode-title">{mode === 'dark' ? t('Dark theme') : t('Light theme')}</h3>
    <span class="theme-mode-name" data-testid="theme-selected-{mode}">{selectedName}</span>
  </div>
  <div class="theme-grid" role="group" aria-label={mode === 'dark' ? t('Dark theme') : t('Light theme')}>
    {#each options as o (o.ref)}
      {@const swatch = o.swatch ?? customSwatch[`${o.ref}@${'at' in o ? o.at : ''}`]}
      <button class={['theme-card', o.ref === selected && 'on']} aria-pressed={o.ref === selected} data-testid="theme-card" data-mode={mode} data-id={o.ref} onclick={() => look.set({ [mode]: o.ref })}>
        <span class="theme-swatch" aria-hidden="true">
          {#if swatch}
            <span class="sw-side" style:background={swatch[0]}></span>
            <span class="sw-main" style:background={swatch[1]}>
              <span class="sw-line" style:background={swatch[2]}></span>
              <span class="sw-line short" style:background={swatch[2]}></span>
              <span class="sw-dots">{#each swatch.slice(3) as c, i (i)}<span style:background={c}></span>{/each}</span>
            </span>
          {/if}
        </span>
        <span class="theme-name">{o.name}</span>
        <span class="theme-author">{o.author}</span>
      </button>
    {/each}
  </div>
  <div class="theme-detail">
    <ThemePreview {mode} vars={mapped?.vars ?? null} testid="theme-preview-{mode}" />
    <div class="theme-notes">
      {#if selected === SELFBOUND_THEME}
        <p class="theme-note">{t('The Selfbound colors. Pick a theme to adjust its colors.')}</p>
      {:else}
        {#if fixes.length}
          <p class="theme-note" data-testid="contrast-note-{mode}">
            {t('Lightened or darkened for readability: {names}.', { names: fixes.map((f) => varLabel(f.name)).join(', ') })}
          </p>
        {:else}
          <p class="theme-note" data-testid="contrast-note-{mode}">{t('All text reaches the minimum contrast without adjustment.')}</p>
        {/if}
        <button class="btn small" aria-expanded={colorsOpen} data-testid="theme-colors-toggle-{mode}" onclick={() => (colorsOpen = !colorsOpen)}>{colorsOpen ? t('Hide colors') : t('Adjust colors')}</button>
      {/if}
    </div>
  </div>
  {#if colorsOpen && selected !== SELFBOUND_THEME && mapped}
    <ThemeColors ref={selected} {mapped} />
  {/if}
</div>
