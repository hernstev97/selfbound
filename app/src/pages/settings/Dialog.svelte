<script lang="ts">
  // Small modal dialog (show a key, confirm a revoke). Esc and a click outside close it.
  import type { Snippet } from 'svelte';
  import { autofocus, backCloses } from '../../lib/ui.ts';
  import { leave } from '../../lib/motion.ts';
  import { modal } from '../../lib/modal.ts';

  let { title, close, children, testid }: { title: string; close: () => void; children: Snippet; testid?: string } = $props();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- Fade out also when the page tears down the dialog (|global). -->
<div
  class="overlay dialog-overlay"
  out:leave|global
  {@attach modal({ focus: false })}
  {@attach backCloses(() => close())}
  onpointerdown={(e) => {
    if (e.target === e.currentTarget) close();
  }}
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }}
>
  <div class="dialog" role="dialog" aria-modal="true" aria-label={title} data-testid={testid} tabindex="-1" {@attach autofocus}>
    <h2 class="dialog-title">{title}</h2>
    {@render children()}
  </div>
</div>
