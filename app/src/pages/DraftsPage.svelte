<script lang="ts">
  // Drafts: saved ones (Esc with content) and the open draft.
  import { ICON, relativeTime, type Draft } from '@selfbound/core';
  import { t, tc } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';

  const draftsSlice = fromSlice(app.create.drafts);
  const currentSlice = fromSlice(app.create.state);
  const current = $derived(currentSlice.current.draft);
  const all = $derived<(Draft & { open?: boolean })[]>([...(current.title.trim() || current.description.trim() ? [{ ...current, open: true }] : []), ...draftsSlice.current]);
</script>

<header class="location-bar">
  <button class="icon-btn plain mobile-only" aria-label={t('Navigation')} onclick={() => app.toggleSidebar()}><span class="icon">{@html ICON.menu}</span></button>
  <div class="crumbs"><span class="crumb"><span class="icon">{@html ICON.compose}</span><span class="crumb-title">{t('Drafts')}</span></span></div>
</header>
<div class="page" data-testid="drafts-page">
  <div class="page-content">
    {#if all.length === 0}
      <div class="empty">
        <div class="empty-icon"><span class="icon">{@html ICON.compose}</span></div>
        <div class="empty-text">{t('No drafts. If you close the create dialog with content, it ends up here.')}</div>
        <button class="btn" onclick={() => app.create.open()}>{t('Create issue')} <span class="kbd">C</span></button>
      </div>
    {:else}
      <div class="card-list">
        {#each all as draft (draft.id)}
          <div class="card-row" data-testid="draft-row">
            <span class="icon" style="color: var(--text-muted)">{@html ICON.compose}</span>
            <span class="t">{draft.title || t('Untitled')}<div class="sub">{draft.open ? t('Open draft') : t('Saved')} · {relativeTime(draft.updatedAt)}</div></span>
            <button class="btn small" onclick={() => (draft.open ? app.create.open() : app.create.openDraft(draft.id))}>{tc('verb', 'Open')}</button>
            {#if !draft.open}<button class="btn small ghost" onclick={() => app.create.deleteDraft(draft.id)}>{t('Delete')}</button>{/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
