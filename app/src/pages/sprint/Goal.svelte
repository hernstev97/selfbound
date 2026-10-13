<script lang="ts">
  // Inline sprint goal (1–3 sentences): Enter saves, Shift Enter adds a line, Esc discards.
  import type { SprintId } from '@xlr8/core';
  import { t } from '@xlr8/core/i18n';
  import { app } from '../../app-instance.ts';

  let { sprintId, goal, placeholder = t('Add a sprint goal: what should be achieved by the end?') }: { sprintId: SprintId; goal: string; placeholder?: string } = $props();
  let text = $state('');
  let editing = $state(false);
  $effect(() => {
    if (!editing) text = goal;
  });

  function save() {
    editing = false;
    const next = text.trim();
    if (next !== goal) app.sprints.update(sprintId, { goal: next });
  }
</script>

<textarea
  class="sprint-goal"
  data-testid="sprint-goal"
  rows="1"
  {placeholder}
  aria-label={t('Sprint goal')}
  bind:value={text}
  onfocus={() => (editing = true)}
  onblur={save}
  onkeydown={(e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      (e.currentTarget as HTMLTextAreaElement).blur();
    } else if (e.key === 'Escape') {
      text = goal;
      editing = false;
    }
  }}
></textarea>
