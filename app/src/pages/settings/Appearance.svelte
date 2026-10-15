<script lang="ts">
  // Appearance: color scheme and font size (this device only), themes for light and dark, custom
  // VS Code themes and fonts for text and code (all devices, stored in Convex: appearance.ts).
  import '../../styles/appearance.css';
  import type { FontSize, Theme } from '@selfbound/core';
  import { ICON } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { api } from '@selfbound/backend/api';
  import type { Id } from '@selfbound/backend/dataModel';
  import { app } from '../../app-instance.ts';
  import { FONTS, LOCAL_NAME, type FontKind } from '../../lib/look/fonts.ts';
  import { look, SELFBOUND_THEME, type CustomThemeMeta } from '../../lib/look/index.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import InlineText from './InlineText.svelte';
  import ThemeEditor from './ThemeEditor.svelte';
  import ThemePicker from './ThemePicker.svelte';

  look.start(app);

  const prefsSlice = fromSlice(app.prefs.state);
  const prefs = $derived(prefsSlice.current);
  const settingsSlice = fromSlice(look.settings);
  const settings = $derived(settingsSlice.current);
  const themesSlice = fromSlice(look.themes);
  const loadedSlice = fromSlice(look.loaded);

  const MODES: [Theme, string][] = [
    ['system', t('System')],
    ['dark', t('Dark')],
    ['light', t('Light')],
  ];
  const SIZES: [FontSize, string][] = [
    ['small', t('Small')],
    ['normal', t('Normal')],
    ['large', t('Large')],
  ];

  /** Editor: null = closed, '' = new theme, otherwise the id of the custom theme */
  let editing = $state<string | null>(null);

  function rename(theme: CustomThemeMeta, name: string) {
    app.store.call(api.appearance.renameTheme, { id: theme.id, name }).catch((error: unknown) => app.toasts.error(t('Not renamed'), error));
  }

  async function remove(theme: CustomThemeMeta) {
    const ref = `custom:${theme.id}`;
    const before = look.settings.get();
    try {
      // Fetch the JSON first so that "Undo" can recreate the theme.
      const doc = await app.store.client.query(api.appearance.theme, { id: theme.id });
      await app.store.call(api.appearance.deleteTheme, { id: theme.id });
      app.toasts.show(t('"{name}" deleted', { name: theme.name }), doc ? { label: t('Undo'), run: () => void restore(doc, ref, before) } : undefined);
    } catch (error) {
      app.toasts.error(t('Not deleted'), error);
    }
  }

  async function restore(doc: { name: string; type: 'dark' | 'light'; source: string }, ref: string, before: typeof settings) {
    try {
      const { id } = await app.store.call(api.appearance.saveTheme, { name: doc.name, type: doc.type, source: doc.source });
      // Restore only what referred to the deleted theme; changes made since then stay.
      const next = `custom:${id}`;
      const now = look.settings.get();
      const own = before.overrides.find((o) => o.theme === ref);
      look.set({
        dark: before.dark === ref && now.dark === SELFBOUND_THEME ? next : now.dark,
        light: before.light === ref && now.light === SELFBOUND_THEME ? next : now.light,
        overrides: own ? [...now.overrides.filter((o) => o.theme !== next), { theme: next, colors: own.colors }] : now.overrides,
      });
    } catch (error) {
      app.toasts.error(t('Not restored'), error);
    }
  }

  // ---- Fonts
  const choice = (ref: string) => (ref.startsWith('local:') ? 'local' : ref);
  let localName = $state<Record<FontKind, string>>({ sans: '', mono: '' });
  let localError = $state<Record<FontKind, string | null>>({ sans: null, mono: null });
  $effect(() => {
    for (const kind of ['sans', 'mono'] as const) {
      const ref = settings[kind];
      if (ref.startsWith('local:')) localName[kind] = ref.slice('local:'.length);
    }
  });

  let pendingLocal = $state<Record<FontKind, boolean>>({ sans: false, mono: false });

  /** Choice in the menu. "Installed locally" takes effect only with a name; until then the previous font stays. */
  function pickFont(kind: FontKind, value: string) {
    localError[kind] = null;
    if (value === 'local') {
      pendingLocal[kind] = true;
      const name = localName[kind].trim();
      if (name && LOCAL_NAME.test(name)) look.set({ [kind]: `local:${name}` });
      return;
    }
    pendingLocal[kind] = false;
    look.set({ [kind]: value });
  }

  function setLocal(kind: FontKind, name: string) {
    const trimmed = name.trim();
    if (!LOCAL_NAME.test(trimmed)) {
      localError[kind] = t('Only letters, digits, spaces, dots, hyphens and underscores (at most 64 characters).');
      return;
    }
    localError[kind] = null;
    pendingLocal[kind] = false;
    look.set({ [kind]: `local:${trimmed}` });
  }
</script>

<h1 class="page-title">{t('Appearance')}</h1>
<p class="page-lead">{t('Themes and fonts apply on all devices, color scheme and font size only on this one. Everything takes effect right away, without reloading.')}</p>

<h2 class="section-title">{t('This device')}</h2>
<div class="card-list">
  <div class="card-row">
    <span class="t">{t('Color scheme')}<div class="sub">{t('System follows the device setting.')}</div></span>
    <span class="seg" data-testid="theme-switch">
      {#each MODES as [value, label] (value)}<button class={[prefs.theme === value && 'on']} onclick={() => app.prefs.set({ theme: value })}>{label}</button>{/each}
    </span>
  </div>
  <div class="card-row">
    <span class="t">{t('Font size')}<div class="sub">{t('Row heights stay the same so lists stay fast.')}</div></span>
    <span class="seg" data-testid="font-switch">
      {#each SIZES as [value, label] (value)}<button class={[prefs.fontSize === value && 'on']} onclick={() => app.prefs.set({ fontSize: value })}>{label}</button>{/each}
    </span>
  </div>
</div>

<h2 class="section-title">{t('Themes')}</h2>
<p class="section-lead">{t('Well-known VS Code themes, one each for light and dark. The color scheme decides which one applies. Text, warnings and errors stay readable: where a theme has too little contrast, Selfbound adjusts the lightness.')}</p>
<ThemePicker mode="dark" />
<ThemePicker mode="light" />

<div class="section-head">
  <h2 class="section-title">{t('Custom themes')}</h2>
  {#if editing === null}
    <button class="btn small" data-testid="theme-add" onclick={() => (editing = '')}><span class="icon">{@html ICON.plus}</span>{t('Add theme')}</button>
  {/if}
</div>
{#if editing === ''}
  <ThemeEditor close={() => (editing = null)} />
{/if}
<div class="card-list" data-testid="custom-themes">
  {#each themesSlice.current as theme (theme.id)}
    <div class="card-row" data-testid="custom-theme" data-id={theme.id}>
      <InlineText value={theme.name} label={t('Theme name')} maxlength={80} testid="custom-theme-name" save={(name) => rename(theme, name)} />
      <span class="num">{theme.type === 'dark' ? t('Dark') : t('Light')}{settings.dark === `custom:${theme.id}` || settings.light === `custom:${theme.id}` ? ` · ${t('in use')}` : ''}</span>
      <span class="row-tools">
        <button class="btn small" data-testid="custom-theme-edit" onclick={() => (editing = theme.id)}>{t('Edit')}</button>
        <button class="btn small" data-testid="custom-theme-delete" onclick={() => void remove(theme)}>{t('Delete')}</button>
      </span>
    </div>
    {#if editing === theme.id}
      <ThemeEditor id={theme.id as Id<'customThemes'>} close={() => (editing = null)} />
    {/if}
  {:else}
    <div class="card-row muted">{loadedSlice.current ? t('No custom themes yet. Paste the JSON of a VS Code theme or upload it.') : t('Loading …')}</div>
  {/each}
</div>

<h2 class="section-title">{t('Fonts')}</h2>
<p class="section-lead">{t('Self-hosted (Fontsource), loaded only when selected. For a locally installed font, enter its name.')}</p>
<div class="card-list">
  {#each [{ kind: 'sans' as const, label: t('Text and interface'), sample: t('Sprint 42: pick a theme, check contrast · 0123456789') }, { kind: 'mono' as const, label: 'Code', sample: 'const theme = pick("mocha", 0x2A); // Il1 O0 => !=' }] as f (f.kind)}
    <div class="card-row col">
      <div class="font-row">
        <span class="t">{f.label}</span>
        <select class="input" aria-label={t('Font for {name}', { name: f.label })} data-testid="font-{f.kind}" value={pendingLocal[f.kind] ? 'local' : choice(settings[f.kind])} onchange={(e) => pickFont(f.kind, e.currentTarget.value)}>
          {#if f.kind === 'sans'}<option value="inter">{t('Inter (default)')}</option><option value="system">{t('System font')}</option>
          {:else}<option value="system">{t('System font (default)')}</option>{/if}
          {#each FONTS.filter((x) => x.kind === f.kind) as font (font.id)}<option value={font.id}>{font.name}</option>{/each}
          <option value="local">{t('Installed locally …')}</option>
        </select>
      </div>
      {#if pendingLocal[f.kind] || settings[f.kind].startsWith('local:')}
        <div class="font-row">
          <span class="sub">{t('Name of the installed font')}</span>
          <input
            class="input"
            aria-label={t('Name of the installed font for {name}', { name: f.label })}
            placeholder={t('e.g. {example}', { example: f.kind === 'sans' ? 'Helvetica Neue' : 'Berkeley Mono' })}
            maxlength="64"
            data-testid="font-{f.kind}-local"
            value={localName[f.kind]}
            onchange={(e) => setLocal(f.kind, e.currentTarget.value)}
            onkeydown={(e) => e.key === 'Enter' && setLocal(f.kind, e.currentTarget.value)}
          />
        </div>
        {#if localError[f.kind]}<p class="field-error" role="alert">{localError[f.kind]}</p>{/if}
      {/if}
      <div class={['font-sample', f.kind === 'mono' && 'mono-sample']} data-testid="font-{f.kind}-sample">{f.sample}</div>
    </div>
  {/each}
</div>
