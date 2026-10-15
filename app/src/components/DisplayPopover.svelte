<script lang="ts">
  // Display options (Shift V): grouping, ordering, completed issues, visible properties.
  // Saved per view.
  import { DISPLAY_PROPS, GROUPING_LABEL, GROUP_ORDER_LABEL, ICON, ORDERING_LABEL, PROP_LABEL, VIEWS, subGroupings, type GroupOrder, type Grouping, type Ordering } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { leave } from '../lib/motion.ts';

  const viewSlice = fromSlice(app.main.view);
  const v = $derived(viewSlice.current);
  const def = $derived(VIEWS[v.route.kind]);
  const subs = $derived(subGroupings(def, v.display.grouping));

  function outside(node: HTMLElement) {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element;
      if (!node.contains(target) && !target.closest('[data-testid="display-button"]')) app.displayOpen.set(false);
    };
    setTimeout(() => window.addEventListener('pointerdown', onDown));
    return () => window.removeEventListener('pointerdown', onDown);
  }
</script>

<!-- Animate out also when ListPage removes the block (|global). -->
<div class="display-pop" data-testid="display-popover" role="dialog" aria-label={t('Display options')} {@attach outside} out:leave|global>
  <div class="dp-row">
    <span>{t('Grouping')}</span>
    <span class="dp-select">
      <select data-testid="display-grouping" value={v.display.grouping} onchange={(e) => app.main.setDisplay({ grouping: e.currentTarget.value as Grouping })}>
        {#each def.groupings as g (g)}<option value={g}>{GROUPING_LABEL[g]}</option>{/each}
      </select>
      <span class="icon">{@html ICON.chevronDown}</span>
    </span>
  </div>
  {#if v.display.layout === 'board'}
    <div class="dp-row">
      <span>{t('Board columns')}</span>
      <span class="dp-select">
        <select data-testid="display-boardcolumns" value={v.display.boardColumns ?? 'status'} onchange={(e) => app.main.setDisplay({ boardColumns: e.currentTarget.value === 'priority' ? 'priority' : undefined })}>
          <option value="status">{GROUPING_LABEL.status}</option>
          <option value="priority">{GROUPING_LABEL.priority}</option>
        </select>
        <span class="icon">{@html ICON.chevronDown}</span>
      </span>
    </div>
  {/if}
  {#if v.display.grouping !== 'none'}
    {#if subs.length > 0}
      <div class="dp-row">
        <span>{t('Then group by')}</span>
        <span class="dp-select">
          <select data-testid="display-subgrouping" value={v.display.subGrouping ?? 'none'} onchange={(e) => app.main.setDisplay({ subGrouping: e.currentTarget.value as Grouping })}>
            <option value="none">{GROUPING_LABEL.none}</option>
            {#each subs as g (g)}<option value={g}>{GROUPING_LABEL[g]}</option>{/each}
          </select>
          <span class="icon">{@html ICON.chevronDown}</span>
        </span>
      </div>
    {/if}
    <div class="dp-row">
      <span>{t('Group order')}</span>
      <span class="dp-select">
        <select data-testid="display-grouporder" value={v.display.groupOrder ?? 'asc'} onchange={(e) => app.main.setDisplay({ groupOrder: e.currentTarget.value as GroupOrder })}>
          {#each Object.keys(GROUP_ORDER_LABEL) as o (o)}<option value={o}>{GROUP_ORDER_LABEL[o as GroupOrder]}</option>{/each}
        </select>
        <span class="icon">{@html ICON.chevronDown}</span>
      </span>
    </div>
    <div class="dp-row">
      <span>{t('Show empty groups')}</span>
      <button class={['toggle', v.display.emptyGroups && 'on']} role="switch" aria-checked={!!v.display.emptyGroups} aria-label={t('Show empty groups')} data-testid="display-emptygroups" onclick={() => app.main.setDisplay({ emptyGroups: !v.display.emptyGroups })}></button>
    </div>
  {/if}
  <div class="dp-row">
    <span>{t('Ordering')}</span>
    <span class="dp-select">
      <select data-testid="display-ordering" value={v.display.ordering} onchange={(e) => app.main.setDisplay({ ordering: e.currentTarget.value as Ordering })}>
        {#each def.orderings as o (o)}<option value={o}>{def.orderingLabels?.[o] ?? ORDERING_LABEL[o]}</option>{/each}
      </select>
      <span class="icon">{@html ICON.chevronDown}</span>
    </span>
  </div>
  {#if def.closedOption}
    <div class="dp-sep"></div>
    <div class="dp-row">
      <span>{t('Show completed')}</span>
      <button class={['toggle', v.display.showClosed && 'on']} role="switch" aria-checked={v.display.showClosed} aria-label={t('Show completed')} data-testid="display-closed" onclick={() => app.main.setDisplay({ showClosed: !v.display.showClosed })}></button>
    </div>
  {/if}
  <div class="dp-sep"></div>
  <div class="dp-row" style="min-height: 24px">{t('Properties')}</div>
  <div class="dp-props">
    {#each DISPLAY_PROPS as prop (prop)}
      <button class={['dp-chip', v.display.props.includes(prop) && 'on']} onclick={() => app.main.toggleProp(prop)}>{PROP_LABEL[prop]}</button>
    {/each}
  </div>
  <div class="dp-foot"><button class="btn ghost small" onclick={() => app.main.resetDisplay()}>{t('Restore defaults')}</button></div>
</div>
