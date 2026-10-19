<script lang="ts">
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import Sidebar from './Sidebar.svelte';
  import ListPage from '../pages/ListPage.svelte';
  import { overlaysLoaded, pages } from '../lib/pages.ts';
  import Palette from './Palette.svelte';
  import Toasts from './Toasts.svelte';
  import DetailSkeleton from './DetailSkeleton.svelte';
  import Lazy from './Lazy.svelte';

  const shellSlice = fromSlice(app.shell);
  const drawerSlice = fromSlice(app.mobileDrawer);
  const shell = $derived(shellSlice.current);
  const perfSlice = fromSlice(app.perf.state);
  const overlays = fromSlice(overlaysLoaded);
  // Keep the list mounted under the issue only after a list was visited (deep link straight to an issue: no list).
  let keepList = $state(false);
  $effect(() => {
    if (shell.page === 'view') keepList = true;
    else if (shell.page !== 'issue') keepList = false;
  });
</script>

<div class={['frame', shell.sidebarHidden && 'sidebar-hidden', drawerSlice.current && 'drawer', shell.mobile && 'mobile']} data-testid="app">
  <Sidebar />
  {#if drawerSlice.current}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="drawer-scrim" onclick={() => app.mobileDrawer.set(false)}></div>
  {/if}
  <main class="panel" data-testid="panel">
    <!-- The list stays mounted (only hidden) while an issue is open: Enter does not tear it down,
         Esc does not rebuild it, scroll position and focus simply stay. -->
    {#if shell.page === 'view' || (shell.page === 'issue' && keepList)}
      <div class={['list-page', shell.page !== 'view' && 'kept']} aria-hidden={shell.page !== 'view'} inert={shell.page !== 'view'}><ListPage /></div>
    {/if}
    {#if shell.page === 'issue'}
      <!-- Until the detail chunk is loaded (deep link, slow network): header and placeholder instead of an empty panel. -->
      <Lazy load={pages.issueHost}>{#snippet pending()}<DetailSkeleton />{/snippet}{#snippet children(m)}<m.Host><m.Page /></m.Host>{/snippet}</Lazy>
    {:else if shell.page === 'pr'}
      <Lazy load={pages.pr} />
    {:else if shell.page === 'pulls'}
      <Lazy load={pages.pulls} />
    {:else if shell.page === 'projects'}
      <Lazy load={pages.projects} />
    {:else if shell.page === 'wiki' || shell.page === 'article'}
      <Lazy load={pages.wiki} />
    {:else if shell.page === 'drafts'}
      <Lazy load={pages.drafts} />
    {:else if shell.page === 'sprints'}
      <Lazy load={pages.sprints} />
    {:else if shell.page === 'settings'}
      <Lazy load={pages.settings} />
    {/if}
  </main>
  <Palette />
  {#if overlays.current}
    {@const o = overlays.current}
    <o.ContextMenu /><o.CreateDialog /><o.NewTeamDialog />
  {/if}
  <Toasts />
  {#if perfSlice.current.enabled}
    <Lazy load={pages.perf} quiet />
  {/if}
  {#if shell.mobile}
    <Lazy load={pages.mobileBar} quiet />
  {/if}
</div>
