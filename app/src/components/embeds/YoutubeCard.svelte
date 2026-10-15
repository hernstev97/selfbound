<script lang="ts">
  // YouTube: thumbnail and title come from our backend; the player (youtube-nocookie.com) loads
  // only after a click on the thumbnail.
  import { t } from '@selfbound/core/i18n';
  import type { EmbedView } from '@selfbound/backend/shared/embeds';

  let { view, id, start }: { view: EmbedView; id: string; start?: number } = $props();
  let playing = $state(false);
  const title = $derived(view.title ?? t('YouTube video'));
  const watchUrl = $derived(`https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ''}`);
  const playerUrl = $derived(`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1${start ? `&start=${start}` : ''}`);
</script>

<div class="emb-card" data-testid="embed-youtube">
  <div class="emb-stage">
    {#if playing}
      <iframe
        src={playerUrl}
        {title}
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowfullscreen
        referrerpolicy="strict-origin-when-cross-origin"
      ></iframe>
    {:else}
      <button type="button" class="emb-play" data-testid="embed-play" aria-label={t('Play video: {title}', { title })} onclick={() => (playing = true)}>
        {#if view.thumbnail}<img src={view.thumbnail} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />{/if}
        <span class="emb-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" /></svg>
        </span>
      </button>
    {/if}
  </div>
  <div class="emb-meta">
    <a class="emb-title" href={watchUrl} target="_blank" rel="noopener noreferrer">{title}</a>
    <div class="emb-sub">
      {#if view.author}<span>{view.author}</span>{/if}
      <span class="emb-note">{playing ? t('Open on YouTube') : t('The player loads from YouTube when you play.')}</span>
    </div>
  </div>
</div>

<style>
  .emb-card {
    border-radius: 10px;
    background: var(--bg-raised);
    box-shadow: 0 0 0 1px var(--border);
    overflow: hidden;
  }
  .emb-stage {
    aspect-ratio: 16 / 9;
    background: #000;
  }
  iframe,
  .emb-play {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
  }
  .emb-play {
    position: relative;
    padding: 0;
    cursor: pointer;
    background: linear-gradient(135deg, #2a2a2e, #141416);
    color: #fff;
    overflow: hidden;
  }
  .emb-play img {
    width: 100%;
    height: 100%;
    object-fit: cover; /* hqdefault is 4:3 with bars above and below; the middle is exactly 16:9 */
  }
  .emb-icon {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 56px;
    height: 40px;
    display: grid;
    place-items: center;
    border-radius: 12px;
    background: rgb(0 0 0 / 0.72);
    transition: background 0.12s;
  }
  .emb-play:hover .emb-icon,
  .emb-play:focus-visible .emb-icon {
    background: rgb(204 0 0 / 0.95);
  }
  .emb-play:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: -2px;
  }
  .emb-meta {
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .emb-title {
    color: var(--text);
    font-weight: 560;
    line-height: 1.3;
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  .emb-title:hover {
    text-decoration: underline;
  }
  .emb-sub {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    font-size: 0.86em;
    color: var(--text-muted);
  }
  .emb-note {
    opacity: 0.85;
  }
  @media (prefers-reduced-motion: reduce) {
    .emb-icon {
      transition: none;
    }
  }
</style>
