<script lang="ts">
  // "Roadmap" card on the issue (SELF-113): whether the issue is public (only public issues reach the
  // image export) and its public card: a title and a short summary for players, and a cover image
  // picked from the images of the issue or uploaded. The texts save on leaving the field; the switch
  // goes through app.edit (undo, history). Shown when the team's roadmap is on or the issue is public.
  import '../styles/forms.css';
  import { api } from '@selfbound/backend/api';
  import { ROADMAP_LIMITS } from '@selfbound/backend/shared/roadmap';
  import { ICON, type DetailState, type IssueId } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { tip } from '../lib/ui.ts';

  let { detail: d }: { detail: DetailState } = $props();
  const versionSlice = fromSlice(app.store.version);
  const metaSlice = fromSlice(app.store.meta);
  const issue = $derived.by(() => {
    void versionSlice.current;
    return app.store.get(d.id);
  });
  const isPublic = $derived(issue?.public === true);
  const roadmapOn = $derived(metaSlice.current?.teams.find((x) => x._id === d.team.id)?.roadmap?.on === true);
  // The detail subscription is running (the issue is open); its card and texts.
  const doc = $derived.by(() => {
    void d;
    return app.store.detail(d.id);
  });
  const card = $derived(doc?.publicCard ?? null);

  let title = $state('');
  let summary = $state('');
  let editing = $state<'title' | 'summary' | null>(null);
  $effect(() => {
    if (editing !== 'title') title = card?.title ?? '';
    if (editing !== 'summary') summary = card?.summary ?? '';
  });

  async function save(patch: { title?: string | null; summary?: string | null; image?: string | null }) {
    try {
      await app.store.call(api.roadmap.setCard, { id: d.id as IssueId, ...patch });
    } catch (e) {
      app.toasts.error(t('Public card not saved'), e);
    }
  }

  function leave(field: 'title' | 'summary') {
    editing = null;
    const value = (field === 'title' ? title : summary).trim();
    if (value === (card?.[field] ?? '')) return;
    void save({ [field]: value || null });
  }

  /** Images in the description and the comments: candidates for the cover. */
  const images = $derived.by(() => {
    if (!doc) return [];
    const texts = [doc.body.markdown, ...doc.comments.map((c) => c.body)];
    const found = new Set<string>();
    for (const text of texts) for (const m of text.matchAll(/!\[[^\]]*\]\((\S+\/img\/[A-Za-z0-9_-]{43})\)/g)) found.add(m[1]!);
    return [...found].slice(0, 12);
  });

  let uploading = $state(false);
  async function upload(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    uploading = true;
    try {
      const { uploadImage } = await import('../lib/upload.ts');
      await save({ image: await uploadImage(file) });
    } catch (e) {
      app.toasts.error(t('Image not uploaded'), e);
    } finally {
      uploading = false;
    }
  }

  function togglePublic() {
    app.edit.patch([d.id as IssueId], { public: !isPublic }, { label: isPublic ? t('Made private') : t('Made public') });
  }
</script>

{#if roadmapOn || isPublic || card}
  <div class="props-card pub-card" data-testid="detail-public">
    <div class="props-title">{t('Roadmap')}</div>
    <div class="pub-row">
      <span class="pub-label">
        <span class="icon" style="color: var(--text-muted)">{@html ICON.eye}</span>
        <span>{t('Public')}<span class="sub">{isPublic ? t('Appears in the image export') : t('Only you see it')}</span></span>
      </span>
      <button class={['toggle', isPublic && 'on']} role="switch" aria-checked={isPublic} aria-label={t('Public on the roadmap')} title={tip(t('Public on the roadmap'), 'issue.public')} data-testid="detail-public-toggle" disabled={d.deleted} onclick={togglePublic}></button>
    </div>
    {#if isPublic || card}
      <label class="pub-field">
        <span class="pub-field-label">{t('Public title')}</span>
        <input class="input" bind:value={title} maxlength={ROADMAP_LIMITS.publicTitleMax} placeholder={d.title} data-testid="detail-public-title" onfocus={() => (editing = 'title')} onblur={() => leave('title')} onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />
      </label>
      <label class="pub-field">
        <span class="pub-field-label">{t('Summary for players')}<span class="pub-count">{summary.length}/{ROADMAP_LIMITS.publicSummaryMax}</span></span>
        <textarea class="input" rows="3" bind:value={summary} maxlength={ROADMAP_LIMITS.publicSummaryMax} placeholder={t('Two or three sentences, no internal details.')} data-testid="detail-public-summary" onfocus={() => (editing = 'summary')} onblur={() => leave('summary')}></textarea>
      </label>
      <div class="pub-field">
        <span class="pub-field-label">{t('Cover image')}</span>
        {#if card?.image}
          <div class="pub-cover">
            <img src={card.image} alt={t('Cover image')} referrerpolicy="no-referrer" data-testid="detail-public-image" />
            <button class="btn ghost small" data-testid="detail-public-image-remove" onclick={() => void save({ image: null })}>{t('Remove')}</button>
          </div>
        {/if}
        {#if images.length}
          <div class="pub-thumbs" role="group" aria-label={t('Images of the issue')}>
            {#each images as src (src)}
              <button class={['pub-thumb', card?.image === src && 'on']} aria-pressed={card?.image === src} title={t('Use as cover image')} onclick={() => void save({ image: card?.image === src ? null : src })}>
                <img {src} alt="" loading="lazy" referrerpolicy="no-referrer" />
              </button>
            {/each}
          </div>
        {/if}
        <label class={['btn', 'small', 'pub-upload', uploading && 'busy']}>
          <span class="icon">{@html ICON.image}</span>{uploading ? t('Uploading …') : t('Upload image')}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="pub-file" data-testid="detail-public-upload" disabled={uploading} onchange={(e) => void upload(e.currentTarget)} />
        </label>
      </div>
    {/if}
  </div>
{/if}

<style>
  .pub-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
  }
  .pub-label {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .pub-label .sub {
    display: block;
    font-size: var(--fs-mini);
    color: var(--text-muted);
  }
  .pub-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 8px;
  }
  .pub-field-label {
    display: flex;
    font-size: var(--fs-mini);
    font-weight: 590;
    color: var(--text-muted);
  }
  .pub-count {
    margin-left: auto;
    font-weight: 450;
    font-variant-numeric: tabular-nums;
  }
  .pub-field textarea {
    resize: vertical;
    min-height: 64px;
    font: inherit;
  }
  .pub-cover {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .pub-file {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .pub-cover img {
    width: 100%;
    max-height: 180px;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: var(--radius-md);
    border: 1px solid var(--line);
  }
  .pub-upload {
    position: relative;
    align-self: flex-start;
  }
  .pub-thumbs {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
  }
  .pub-thumb {
    aspect-ratio: 1;
    border-radius: var(--radius-sm);
    overflow: hidden;
    border: 2px solid transparent;
    padding: 0;
  }
  .pub-thumb.on {
    border-color: var(--accent);
  }
  .pub-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
</style>
