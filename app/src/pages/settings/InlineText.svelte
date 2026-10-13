<script lang="ts">
  // Inline text edit: Enter or blur saves, Esc discards.
  let { value, save, placeholder = '', label, testid, mono = false, maxlength }: { value: string; save: (next: string) => void; placeholder?: string; label: string; testid?: string; mono?: boolean; maxlength?: number } = $props();
  let text = $state('');
  let editing = $state(false);
  $effect(() => {
    if (!editing) text = value;
  });
  function commit() {
    editing = false;
    const next = text.trim();
    if (next && next !== value) save(next);
    else text = value;
  }
</script>

<input
  class={['inline-text', mono && 'mono']}
  aria-label={label}
  data-testid={testid}
  {placeholder}
  {maxlength}
  bind:value={text}
  onfocus={() => (editing = true)}
  onblur={commit}
  onkeydown={(e) => {
    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
    else if (e.key === 'Escape') {
      editing = false;
      text = value;
    }
  }}
/>
