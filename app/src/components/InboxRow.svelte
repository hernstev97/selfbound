<script lang="ts">
  import { ICON, statusIcon, type IssueId } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { tip } from '../lib/ui.ts';
  import TeamLogo from './TeamLogo.svelte';

  let { id, top }: { id: IssueId; top: number } = $props();
  const row = $derived(fromSlice(app.main.rows.get(id)));
  const r = $derived(row.current);
</script>

{#if r}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class={['inbox-row', r.focused && 'focused', r.selected && 'selected', !r.unread && 'seen']}
    data-testid="issue-row"
    data-id={id}
    data-key={r.key}
    data-status={r.status}
    data-priority={r.priority}
    data-unread={r.unread ? '' : undefined}
    style:top="{top}px"
    onclick={(e) => app.main.clickRow(id, { shift: e.shiftKey, mod: e.ctrlKey || e.metaKey })}
    onpointermove={(e) => e.pointerType === 'mouse' && app.main.hoverRow(id)}
    oncontextmenu={(e) => {
      e.preventDefault();
      app.menu.open(id, e.clientX, e.clientY);
    }}
  >
    <span class="inbox-avatar"><span class="icon">{@html ICON.agent}</span><TeamLogo team={r.team} size={14} /></span>
    <span class="inbox-text">
      <span class="inbox-l1">
        {#if r.unread}<span class="unseen-dot" data-testid="inbox-unread" title={t('Unread')}></span>{/if}
        <span class="key">{r.key}</span><span class="t" data-testid="row-title">{r.title}</span>
      </span>
      <span class="inbox-l2">{r.inboxText} · {r.team.name}</span>
    </span>
    <span class="inbox-meta"><span class="icon">{@html statusIcon(r.status, r.statusColor)}</span><span>{r.age}</span></span>
    <!-- Removes only the entry; the issue stays as it is. -->
    <button
      class="icon-btn plain inbox-remove"
      data-testid="inbox-remove"
      aria-label={t('Remove from inbox')}
      title={tip(t('Remove from inbox'), 'inbox.remove')}
      onclick={(e) => {
        e.stopPropagation();
        app.edit.removeFromInbox([id]);
      }}><span class="icon">{@html ICON.check}</span></button
    >
  </div>
{/if}
