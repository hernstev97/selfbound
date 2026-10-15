<script lang="ts">
  // General: language, time zone (the whole instance), teams in the sidebar, sounds, local cache, sign out.
  // Color scheme, font size, themes and fonts: Appearance (Appearance.svelte).
  import type { SidebarTeamSize } from '@selfbound/core';
  import { ICON } from '@selfbound/core';
  import { LOCALES, LOCALE_NAMES, t, type LocalePref } from '@selfbound/core/i18n';
  import { app, auth } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { admin } from './admin.ts';

  const prefsSlice = fromSlice(app.prefs.state);
  const prefs = $derived(prefsSlice.current);
  const TEAM_SIZES: [SidebarTeamSize, string][] = [
    ['small', t('Small')],
    ['large', t('Large')],
  ];
  // Language names stay in their own language, so everyone finds theirs.
  const LANGUAGES: [LocalePref, string][] = [['auto', t('Automatic (browser language)')], ...LOCALES.map((l): [LocalePref, string] => [l, LOCALE_NAMES[l]])];

  // Time zone of the instance (meta.get). Names from the browser, plus UTC and the stored one if the list lacks them.
  const metaSlice = fromSlice(app.store.meta);
  const instanceZone = $derived(metaSlice.current?.timeZone ?? null);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = $derived.by(() => {
    const names = new Set<string>(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []);
    names.add('UTC');
    if (instanceZone) names.add(instanceZone);
    else if (browserZone) names.add(browserZone);
    return [...names].sort();
  });
  const zoneName = (zone: string) => zone.replaceAll('_', ' ');

  /** The language is chosen at startup (app/src/lib/i18n.ts), so a change reloads the page. */
  function setLocale(locale: LocalePref) {
    if (locale === prefs.locale) return;
    app.prefs.set({ locale });
    location.reload();
  }
</script>

<h1 class="page-title">{t('General')}</h1>
<p class="page-lead">{t('Settings for this device. They take effect right away, without reloading. Color scheme, themes and fonts are under')} <a class="link" href="/settings/appearance" onclick={(e) => { e.preventDefault(); app.nav.go({ name: 'settings', section: 'appearance' }); }}>{t('Appearance')}</a>.</p>
<h2 class="section-title">{t('Language')}</h2>
<div class="card-list">
  <div class="card-row">
    <span class="t">{t('Language')}<div class="sub">{t('Applies to this device. The page reloads after a change.')}</div></span>
    <span class="dp-select">
      <select aria-label={t('Language')} data-testid="settings-locale" value={prefs.locale} onchange={(e) => setLocale(e.currentTarget.value as LocalePref)}>
        {#each LANGUAGES as [value, label] (value)}<option {value}>{label}</option>{/each}
      </select>
      <span class="icon">{@html ICON.chevronDown}</span>
    </span>
  </div>
</div>
<h2 class="section-title">{t('Time zone')}</h2>
<div class="card-list">
  <div class="card-row">
    <span class="t">{t('Time zone')}<div class="sub">{t('Decides where a day begins for due dates, snoozing, sprints, recurring issues, the morning notifications and what agents see as “today”. It applies to the whole instance, not just this device. Saved days do not change.')}</div></span>
    <span class="dp-select">
      <select aria-label={t('Time zone of the instance')} data-testid="settings-timezone" value={instanceZone ?? browserZone} onchange={(e) => void admin.setTimeZone(e.currentTarget.value)}>
        {#each zones as zone (zone)}<option value={zone}>{zoneName(zone)}</option>{/each}
      </select>
      <span class="icon">{@html ICON.chevronDown}</span>
    </span>
  </div>
  {#if instanceZone && browserZone && browserZone !== instanceZone}
    <div class="card-row">
      <span class="t">{t('This browser is in {zone}.', { zone: zoneName(browserZone) })}</span>
      <button class="btn small" data-testid="settings-timezone-browser" onclick={() => void admin.setTimeZone(browserZone)}>{t('Use {zone}', { zone: zoneName(browserZone) })}</button>
    </div>
  {/if}
</div>
<h2 class="section-title">{t('Sidebar')}</h2>
<div class="card-list">
  <div class="card-row">
    <span class="t">{t('Teams in the sidebar')}<div class="sub">{t('Small: logo and name. Large: with counts. The current team always shows its counts.')}</div></span>
    <span class="seg" data-testid="sidebar-teams-switch">
      {#each TEAM_SIZES as [value, label] (value)}<button class={[prefs.sidebarTeams === value && 'on']} onclick={() => app.prefs.set({ sidebarTeams: value })}>{label}</button>{/each}
    </span>
  </div>
</div>
<h2 class="section-title">{t('Sounds')}</h2>
<div class="card-list">
  <div class="card-row">
    <span class="t">{t('Sounds')}<div class="sub">{t('Soft sounds for clicks, keys, menus, success and errors. Applies to this device.')}</div></span>
    <span class="seg" data-testid="sound-switch" data-sound="none">
      <button class={[prefs.sound && 'on']} onclick={() => app.prefs.set({ sound: true })}>{t('On')}</button><button class={[!prefs.sound && 'on']} onclick={() => app.prefs.set({ sound: false })}>{t('Off')}</button>
    </span>
  </div>
  <div class="card-row">
    <span class="t">{t('Volume')}<div class="sub">{t('Dragging plays a sample click.')}</div></span>
    <input class="range" type="range" min="0.05" max="1" step="0.05" value={prefs.soundVolume} disabled={!prefs.sound} aria-label={t('Sound volume')} data-testid="sound-volume" oninput={(e) => app.prefs.set({ soundVolume: Number(e.currentTarget.value) })} />
  </div>
</div>
<h2 class="section-title">{t('Device')}</h2>
<div class="card-list">
  <div class="card-row">
    <span class="t">{t('Local cache')}<div class="sub">{t('For a fast start, a copy of the issues is kept in the browser.')}</div></span>
    <button class="btn small" onclick={() => void app.store.clearCache().then(() => app.toasts.show(t('Cache cleared')))}>{t('Clear')}</button>
  </div>
  {#if auth.kind === 'clerk'}
    <div class="card-row">
      <span class="t">{t('Sign out')}</span>
      <button class="btn small" onclick={() => void auth.signOut()}>{t('Sign out')}</button>
    </div>
  {/if}
</div>
