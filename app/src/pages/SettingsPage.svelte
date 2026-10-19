<script lang="ts">
  import '../styles/settings.css';
  // Settings (own chunk): navigation on the left (replaces the sidebar, SettingsNav), the section on
  // the right. Extension point: settings/sections.ts plus a case here.
  import { ICON } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { SECTION_LABEL } from './settings/sections.ts';
  import Profile from './settings/Profile.svelte';
  import General from './settings/General.svelte';
  import Appearance from './settings/Appearance.svelte';
  import Teams from './settings/Teams.svelte';
  import TeamDetail from './settings/TeamDetail.svelte';
  import Projects from './settings/Projects.svelte';
  import Labels from './settings/Labels.svelte';
  import Agents from './settings/Agents.svelte';
  import Models from './settings/Models.svelte';
  import Recurrences from './settings/Recurrences.svelte';
  import Priorities from './settings/Priorities.svelte';
  import Ops from './settings/Ops.svelte';
  import Github from './settings/Github.svelte';
  import Notifications from './settings/Notifications.svelte';
  import About from './settings/About.svelte';

  const pageSlice = fromSlice(app.nav.page);
  const page = $derived(pageSlice.current);
  const section = $derived(page.name === 'settings' ? page.section : 'general');
  const sub = $derived(page.name === 'settings' ? page.sub : undefined);
  const metaSlice = fromSlice(app.store.meta);
  const subLabel = $derived(section === 'teams' && sub ? (metaSlice.current?.teams.find((x) => x.key === sub)?.name ?? sub) : sub);
</script>

<header class="location-bar">
  <button class="icon-btn plain mobile-only" aria-label={t('Navigation')} onclick={() => app.toggleSidebar()}><span class="icon">{@html ICON.menu}</span></button>
  <div class="crumbs">
    <span class="crumb"><span class="icon">{@html ICON.settings}</span><span class="crumb-title">{t('Settings')}</span></span>
    {#if SECTION_LABEL[section]}
      <span class="icon crumb-sep">{@html ICON.chevronRight}</span>
      {#if sub}
        <a class="crumb" href="/settings/{section}" onclick={(e) => { e.preventDefault(); app.nav.go({ name: 'settings', section }); }}><span class="crumb-title">{SECTION_LABEL[section]}</span></a>
        <span class="icon crumb-sep">{@html ICON.chevronRight}</span>
        <span class="crumb"><span class="crumb-title">{subLabel}</span></span>
      {:else}
        <span class="crumb"><span class="crumb-title">{SECTION_LABEL[section]}</span></span>
      {/if}
    {/if}
  </div>
</header>
<div class="page" data-testid="settings-page" data-section={section}>
  <div class="page-content">
    {#if section === 'profile'}
      <Profile />
    {:else if section === 'general'}
      <General />
    {:else if section === 'appearance'}
      <Appearance />
    {:else if section === 'notifications'}
      <Notifications />
    {:else if section === 'teams' && sub}
      {#key sub}<TeamDetail teamKey={sub} />{/key}
    {:else if section === 'teams'}
      <Teams />
    {:else if section === 'projects'}
      <Projects />
    {:else if section === 'labels'}
      <Labels />
    {:else if section === 'agents'}
      <Agents />
    {:else if section === 'models'}
      <Models />
    {:else if section === 'recurrences'}
      <Recurrences />
    {:else if section === 'priorities'}
      <Priorities />
    {:else if section === 'github'}
      <Github />
    {:else if section === 'ops'}
      <Ops />
    {:else if section === 'about'}
      <About />
    {:else}
      <div class="empty" style="padding: 48px 0">
        <div class="empty-text">{t('This section does not exist.')}</div>
        <button class="btn" onclick={() => app.nav.go({ name: 'settings', section: 'general' })}>{t('Go to settings')}</button>
      </div>
    {/if}
  </div>
</div>
