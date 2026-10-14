<script lang="ts">
  import { ICON } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { flip } from 'svelte/animate';
  import { DUR, reduced } from '../lib/motion.ts';

  const toastsSlice = fromSlice(app.toasts.list);
  // "Offline" or "n pending" on the phone: on desktop it is in the sidebar, which on the phone sits in
  // the drawer. Below the toasts so nothing overlaps.
  const syncSlice = fromSlice(app.store.sync);

  // Leaving: slides to the right and fades, the others move up smoothly. For tests and clicks the
  // element is gone at once (like lib/motion.ts `leave`).
  function out(node: Element) {
    node.removeAttribute('data-testid');
    for (const el of node.querySelectorAll('[data-testid]')) el.removeAttribute('data-testid');
    (node as HTMLElement).inert = true;
    const rm = reduced();
    return { duration: rm ? DUR[1] : DUR[3], easing: (x: number) => x, css: (x: number, u: number) => `opacity: ${x}${rm ? '' : `; translate: ${u * 12}px 0`}` };
  }
</script>

<div class="toasts" data-testid="toasts" aria-live="polite">
  {#each toastsSlice.current as toast (toast.id)}
    <div class={['toast', toast.kind === 'error' && 'error']} data-testid="toast" data-kind={toast.kind} role={toast.kind === 'error' ? 'alert' : 'status'} out:out animate:flip={{ duration: reduced() ? 0 : DUR[3], easing: (x) => 1 - Math.pow(1 - x, 3) }}>
      <div class="toast-body">
        <span>{toast.text}</span>
        {#if toast.detail}<span class="toast-detail" data-testid="toast-detail">{toast.detail}</span>{/if}
      </div>
      {#if toast.action}
        {@const action = toast.action}
        <button class="toast-action" data-testid="toast-action" onclick={() => action.run()}>{action.label}</button>
      {/if}
      <button class="toast-close" aria-label={t('Close')} onclick={() => app.toasts.dismiss(toast.id)}><span class="icon">{@html ICON.close}</span></button>
    </div>
  {/each}
  {#if syncSlice.current.visible}
    <div class="mobile-sync" role="status" data-testid="mobile-sync-state"><span class="pulse"></span>{syncSlice.current.text}</div>
  {/if}
</div>
