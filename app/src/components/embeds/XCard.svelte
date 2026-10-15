<script lang="ts">
  // X post: author, text and date from our backend's cache (X's official oEmbed, which has no
  // pictures); nothing loads from X. The text is plain text, never HTML.
  import { intlLocale, t } from '@selfbound/core/i18n';
  import type { EmbedView } from '@selfbound/backend/shared/embeds';

  let { view }: { view: EmbedView } = $props();
  const postUrl = $derived(`https://x.com/${view.handle ?? 'i'}/status/${view.id}`);
  const profileUrl = $derived(view.handle ? `https://x.com/${view.handle}` : postUrl);
  const when = $derived(
    view.createdAt ? new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(view.createdAt) : '',
  );
  const name = $derived(view.author ?? (view.handle ? `@${view.handle}` : 'X'));
</script>

<article class="emb-card" data-testid="embed-x" aria-label={t('Post by {name}', { name })}>
  <header>
    <a class="emb-who" href={profileUrl} target="_blank" rel="noopener noreferrer">
      <span class="emb-name">{name}</span>
      {#if view.handle}<span class="emb-handle">@{view.handle}</span>{/if}
    </a>
    <svg class="emb-logo" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
  </header>
  {#if view.text}<p class="emb-text">{view.text}</p>{/if}
  <footer>
    {#if when}<a href={postUrl} target="_blank" rel="noopener noreferrer">{when}</a>{/if}
    <a href={postUrl} target="_blank" rel="noopener noreferrer">{t('Open on X')}</a>
  </footer>
</article>

<style>
  .emb-card {
    padding: 12px 14px;
    border-radius: 10px;
    background: var(--bg-raised);
    box-shadow: 0 0 0 1px var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .emb-who {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
    line-height: 1.25;
    text-decoration: none;
  }
  .emb-name {
    color: var(--text);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .emb-handle {
    color: var(--text-muted);
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .emb-who:hover .emb-name {
    text-decoration: underline;
  }
  .emb-logo {
    flex: none;
    color: var(--text-muted);
  }
  .emb-text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.45;
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 14px;
    font-size: 0.86em;
  }
  footer a {
    color: var(--text-muted);
    text-decoration: none;
  }
  footer a:hover {
    color: var(--text);
    text-decoration: underline;
  }
</style>
