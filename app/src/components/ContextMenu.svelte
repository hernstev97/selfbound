<script lang="ts">
  import { ICON } from '@selfbound/core';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { leave } from '../lib/motion.ts';
  import { logoClass } from '../lib/providerLogo.ts';
  import TeamLogo from './TeamLogo.svelte';

  const menuSlice = fromSlice(app.menu.state);
  const m = $derived(menuSlice.current);
  let menuEl = $state<HTMLDivElement | null>(null);

  /** Keep the menu inside the window: slide it up or left just as far as needed (it scrolls when it is taller than the window). */
  function place(node: HTMLElement) {
    const r = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(r.left, innerWidth - node.offsetWidth - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(r.top, innerHeight - node.offsetHeight - 8))}px`;
  }

  /** Submenu beside its entry, measured: right of the menu, or left of it when the window ends there. */
  function placeSub(node: HTMLElement) {
    const menu = menuEl?.getBoundingClientRect();
    const row = menuEl?.querySelector(`[data-id="${m?.sub?.parent}"]`)?.getBoundingClientRect();
    if (!menu || !row) return;
    const width = node.offsetWidth;
    node.style.left = `${menu.right + 2 + width > innerWidth - 8 ? Math.max(8, menu.left - width - 2) : menu.right + 2}px`;
    node.style.top = `${Math.max(8, Math.min(row.top - 4, innerHeight - node.offsetHeight - 8))}px`;
  }

  // Moving the pointer to a submenu crosses the entries in between: another entry takes over only
  // after the pointer rested on it, so the submenu is not lost on the way.
  let pending: { index: number; timer: ReturnType<typeof setTimeout> } | null = null;
  function settle() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }
  function hover(index: number, top: number) {
    const s = app.menu.state.get();
    if (!s?.sub || s.items[index]?.id === s.sub.parent) {
      settle();
      return app.menu.hover(index, top);
    }
    if (pending?.index === index) return;
    settle();
    pending = { index, timer: setTimeout(() => (settle(), app.menu.hover(index, top)), 120) };
  }
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
    <div class="context-menu" data-testid="context-menu" role="menu" style:left="{m.x}px" style:top="{m.y}px" bind:this={menuEl} {@attach place}>
      <div class="menu-head">{m.targetLabel}</div>
      {#each m.items as item, i (item.id)}
        {#if i > 0 && item.section !== m.items[i - 1].section}<div class="menu-sep"></div>{/if}
        <button
          class={['menu-item', i === m.active && 'active', item.danger && 'danger']}
          role="menuitem"
          data-testid="context-item"
          data-id={item.id}
          onpointermove={(e) => hover(i, (e.currentTarget as HTMLElement).getBoundingClientRect().top - 4)}
          onclick={(e) => (settle(), item.submenu ? app.menu.hover(i, (e.currentTarget as HTMLElement).getBoundingClientRect().top - 4) : app.menu.choose(i))}
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
      <!-- One element per parent entry, so each submenu is placed for its own size. -->
      {#key m.sub.parent}
      <div class="submenu" data-testid="context-submenu" role="menu" style:top="{m.sub.y}px" {@attach placeSub}>
        {#each m.sub.items as item, i (item.id)}
          <button class={['menu-item', i === m.sub.active && 'active']} role={m.sub.plain ? 'menuitem' : 'menuitemcheckbox'} aria-checked={m.sub.plain ? undefined : !!item.checked} data-testid="context-subitem" data-id={item.id} onpointermove={() => (settle(), app.menu.hoverSub(i))} onclick={() => app.menu.chooseSub(i)}>
            {#if item.checkbox}
              <span class={['box', item.checked && 'on']}>{#if item.checked}{@html ICON.check}{/if}</span>
            {:else if !m.sub.plain}
              <span class="check">{#if item.checked}{@html ICON.check}{/if}</span>
            {/if}
            {#if item.logo}<span class={['icon mi', logoClass(item.logo)]}></span>{:else if item.team}<TeamLogo team={item.team} />{:else if item.icon}<span class="icon">{@html item.icon}</span>{:else if item.dot !== undefined}<span class="icon"><span class="label-dot" style:--hue={item.dot}></span></span>{/if}
            <span class="label">{item.label}</span>
            {#if item.detail}<span class="detail">{item.detail}</span>{/if}
            {#if item.shortcut}<span class="grow"></span><span class="shortcut">{item.shortcut}</span>{/if}
          </button>
        {/each}
      </div>
      {/key}
    {/if}
  </div>
{/if}

<style>
  /* 25 entries are taller than a laptop window: the menu scrolls instead of losing its last entries. */
  .context-menu {
    max-height: calc(100dvh - 16px);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  @media (hover: none) {
    .submenu :global(.shortcut) {
      display: none;
    }
  }
  /* Submenu rows as tall as the menu's own (the phone keeps its larger rows). */
  @media (min-width: 769px) {
    .submenu :global(.menu-item) {
      height: 32px;
      margin: 0;
      gap: 10px;
      padding: 0 8px;
      border-radius: var(--radius-md);
    }
  }
</style>
