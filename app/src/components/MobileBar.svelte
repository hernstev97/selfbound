<script lang="ts">
  // Phone: floating bar at the bottom plus a round button to create an issue.
  import { t } from '@xlr8/core/i18n';
  import { ICON } from '@xlr8/core';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';

  const sidebarSlice = fromSlice(app.sidebar);
  const active = $derived(sidebarSlice.current.active);
</script>

<div class="mobile-bar" data-testid="mobile-bar">
  <nav class="mobile-tabs">
    <button class={['mobile-tab', active === 'inbox' && 'active']} onclick={() => app.nav.goView({ kind: 'inbox', team: null })}><span class="icon">{@html ICON.inbox}</span>{t('Inbox')}</button>
    <button class={['mobile-tab', (active === 'all' || active.startsWith('team:')) && 'active']} onclick={() => app.nav.goView({ kind: 'all', team: null })}><span class="icon">{@html ICON.issues}</span>{t('Issues')}</button>
    <button class={['mobile-tab', active === 'sprint' && 'active']} onclick={() => app.nav.goView({ kind: 'sprint', team: null })}><span class="icon">{@html ICON.sprint}</span>{t('Sprint')}</button>
    <button class="mobile-tab" onclick={() => app.palette.open('search')}><span class="icon">{@html ICON.search}</span>{t('Search')}</button>
    <button class="mobile-tab" onclick={() => app.mobileDrawer.set(true)} data-testid="mobile-menu"><span class="icon">{@html ICON.menu}</span>{t('More')}</button>
  </nav>
  <button class="mobile-fab" aria-label={t('New issue')} data-testid="mobile-create" onclick={() => app.create.open()}><span class="icon">{@html ICON.compose}</span></button>
</div>
