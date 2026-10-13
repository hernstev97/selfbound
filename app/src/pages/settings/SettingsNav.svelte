<script lang="ts">
  import '../../styles/settings.css';
  // Left-hand settings navigation: replaces the sidebar, with "Back to app" at the top.
  import { ICON } from '@xlr8/core';
  import { t } from '@xlr8/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import TeamLogo from '../../components/TeamLogo.svelte';
  import { SECTIONS } from './sections.ts';

  const pageSlice = fromSlice(app.nav.page);
  const metaSlice = fromSlice(app.store.meta);
  const page = $derived(pageSlice.current);
  const section = $derived(page.name === 'settings' ? page.section : '');
  const sub = $derived(page.name === 'settings' ? page.sub : undefined);
  const teams = $derived(metaSlice.current?.teams ?? []);

  function go(e: MouseEvent, sectionId: string, subId?: string) {
    if (e.metaKey || e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    app.nav.go({ name: 'settings', section: sectionId, ...(subId ? { sub: subId } : {}) });
  }
</script>

<div class="ws-head settings-head">
  <button class="nav-item back" data-testid="settings-back" onclick={() => app.nav.toLastView()}>
    <span class="icon">{@html ICON.back}</span><span class="label">{t('Back to app')}</span>
  </button>
</div>
<nav class="nav-scroll" data-testid="settings-nav">
  {#each SECTIONS as group (group.key)}
    <div class="nav-section static">{group.label}</div>
    {#each group.items as item (item.id)}
      <a class={['nav-item', section === item.id && !sub && 'active']} href="/settings/{item.id}" data-testid="settings-nav-{item.id}" onclick={(e) => go(e, item.id)}>
        <span class="icon">{@html ICON[item.icon]}</span><span class="label">{item.label}</span>
      </a>
    {/each}
  {/each}
  <div class="nav-section static">{t('Teams')}</div>
  {#each teams as team (team._id)}
    <a class={['nav-item', section === 'teams' && sub === team.key && 'active']} href="/settings/teams/{team.key}" onclick={(e) => go(e, 'teams', team.key)}>
      <TeamLogo team={app.main.teamBadge(team._id)} size={14} /><span class="label">{team.name}</span>{#if team.dormant}<span class="count">{t('dormant')}</span>{/if}
    </a>
  {/each}
</nav>
