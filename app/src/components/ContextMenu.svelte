<script lang="ts">
  import { ICON } from '@xlr8/core';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { keepInView } from '../lib/ui.ts';
  import { leave } from '../lib/motion.ts';
  import TeamLogo from './TeamLogo.svelte';

  const menuSlice = fromSlice(app.menu.state);
  const m = $derived(menuSlice.current);
  let menuEl = $state<HTMLDivElement | null>(null);
  const subLeft = $derived.by(() => {
    if (!m?.sub || !menuEl) return 0;
    const r = menuEl.getBoundingClientRect();
    return r.right + 220 > innerWidth ? Math.max(8, r.left - 222) : r.right + 2;
  });
</script>

{#if m}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="overlay"
    data-testid="context-overlay"
    out:leave
    onpointerdown={(e) => {
      if (e.target === e.currentTarget) app.menu.close();
    }}
    oncontextmenu={(e) => {
      e.preventDefault();
      app.menu.close();
    }}
  >
    <div class="context-menu" data-testid="context-menu" role="menu" style:left="{m.x}px" style:top="{m.y}px" bind:this={menuEl} {@attach keepInView}>
      <div class="menu-head">{m.targetLabel}</div>
      {#each m.items as item, i (item.id)}
        {#if i > 0 && item.section !== m.items[i - 1].section}<div class="menu-sep"></div>{/if}
        <button
          class={['menu-item', i === m.active && 'active', item.danger && 'danger']}
          role="menuitem"
          data-testid="context-item"
          data-id={item.id}
          onpointermove={(e) => app.menu.hover(i, (e.currentTarget as HTMLElement).getBoundingClientRect().top - 4)}
          onclick={(e) => (item.submenu ? app.menu.hover(i, (e.currentTarget as HTMLElement).getBoundingClientRect().top - 4) : app.menu.choose(i))}
        >
          {#if item.icon}<span class="icon">{@html item.icon}</span>{/if}
          <span class="label">{item.label}</span>
          <span class="grow"></span>
          {#if item.shortcut}<span class="shortcut">{item.shortcut}</span>{/if}
          {#if item.submenu}<span class="icon arrow">{@html ICON.caretRight}</span>{/if}
        </button>
      {/each}
    </div>
    {#if m.sub}
      <div class="submenu" data-testid="context-submenu" role="menu" style:left="{subLeft}px" style:top="{m.sub.y}px" {@attach keepInView}>
        {#each m.sub.items as item, i (item.id)}
          <button class={['menu-item', i === m.sub.active && 'active']} role="menuitemcheckbox" aria-checked={!!item.checked} data-testid="context-subitem" data-id={item.id} onpointermove={() => app.menu.hoverSub(i)} onclick={() => app.menu.chooseSub(i)}>
            {#if item.checkbox}
              <span class={['box', item.checked && 'on']}>{#if item.checked}{@html ICON.check}{/if}</span>
            {:else}
              <span class="check">{#if item.checked}{@html ICON.check}{/if}</span>
            {/if}
            {#if item.team}<TeamLogo team={item.team} />{:else if item.icon}<span class="icon">{@html item.icon}</span>{:else if item.dot !== undefined}<span class="icon"><span class="label-dot" style:--hue={item.dot}></span></span>{/if}
            <span class="label">{item.label}</span>
            {#if item.detail}<span class="detail">{item.detail}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
