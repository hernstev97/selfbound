<script lang="ts">
  // Activity: history and comments in chronological order, with the source as a small icon:
  // the owner, an agent (with its name), GitHub, import, system.
  import { ICON, type ActivityItem, type DetailState } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { OWNER_KIND } from '@selfbound/core/types';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import type { ImageField } from '../lib/imageInput.ts';
  import { uploadNote } from '../lib/uploadNote.ts';
  import { loadEditor } from '../lib/richtext.ts';
  import { setCodeLang } from '../lib/codeLang.ts';
  import { toggleTask } from '../lib/tasks.ts';
  import Avatar from './Avatar.svelte';
  import ImageButton from './ImageButton.svelte';
  import Markdown from './Markdown.svelte';
  import TextEditor from './TextEditor.svelte';

  let { detail: d }: { detail: DetailState } = $props();

  // Comment draft per issue (localStorage through the core); moving to the next issue shows that
  // issue's own draft, not the previous one.
  let draft = $state('');
  let draftFor: string | null = null;
  $effect.pre(() => {
    const id = d.id;
    if (id === draftFor) return;
    draftFor = id;
    draft = app.detail.commentDraft(id);
  });
  let sending = $state(false);
  let editing = $state<string | null>(null);
  let editText = $state('');
  let confirmDelete = $state<string | null>(null);
  let input = $state<ImageField | null>(null);
  let editInput = $state<ImageField | null>(null);
  /** An image still uploading (placeholder from upload.ts): send only once it is done. */
  const uploading = (text: string) => [...text.matchAll(/!\[([^\]\n]*)\]\(#upload-/g)].some((m) => !uploadNote(m[1]).failed);

  // The owner shows as <Avatar> (profile picture, initials, or a person glyph without a profile).
  const metaSlice = fromSlice(app.store.meta);
  const owner = $derived(metaSlice.current?.owner);
  const SOURCE_ICON: Record<Exclude<ActivityItem['actor'], typeof OWNER_KIND>, string> = {
    agent: ICON.agent,
    github: ICON.github,
    import: ICON.import,
    system: ICON.system,
  };

  async function send() {
    const text = draft.trim();
    if (!text || sending || uploading(text)) return;
    sending = true;
    draft = '';
    const ok = await app.detail.addComment(text);
    // Success: the core has deleted the saved draft.
    if (!ok) draft = text;
    sending = false;
  }

  function saveEdit(id: string) {
    if (editText.trim()) void app.detail.editComment(id, editText);
    editing = null;
  }

  async function startEditing(id: string, body: string) {
    await loadEditor().catch(() => {});
    editText = body;
    editing = id;
  }

  /** Checks a task in one of your own comments. */
  function toggle(id: string, body: string, index: number, total: number) {
    const next = toggleTask(body, index, total);
    if (next !== null) void app.detail.editComment(id, next);
  }

  /** Chooses a code block's language in one of your own comments. */
  async function setLang(id: string, body: string, index: number, total: number, lang: string) {
    const next = await setCodeLang(body, index, total, lang);
    if (next === null) app.toasts.show(t('The language can only be changed in the editor here (Edit)'));
    else if (next !== body) void app.detail.editComment(id, next);
  }
</script>

<div class="section-title">{t('Activity')}</div>
<div class="activity" data-testid="activity">
  {#if d.activity === null}
    <div class="skeleton-bar" style="width: 50%; margin: 10px 0"></div>
  {:else}
    {#if d.activity.length > 0}<div class="act-line"></div>{/if}
    {#if d.olderComments}
      <button class="btn ghost small act-older" data-testid="comments-older" disabled={d.olderComments === 'loading'} onclick={() => void app.detail.loadOlderComments()}>
        {d.olderComments === 'loading' ? t('Loading …') : t('Load older comments')}
      </button>
    {/if}
    {#each d.activity as item (item.id)}
      {#if item.kind === 'event'}
        <div class="act-event" data-testid="activity-event" data-source={item.actor}>
          <span class={['act-avatar', item.actor]} title={item.actorName}>
            {#if item.actor === OWNER_KIND}
              <Avatar name={owner?.name} url={owner?.avatarUrl} size={18} />
            {:else}
              <span class="icon">{@html SOURCE_ICON[item.actor]}</span>
            {/if}
          </span>
          <span><span class="who">{item.actorName}</span> {item.text}</span>
          <span class="when" title={item.full}>· {item.ago}</span>
          {#if item.revert}
            {@const r = item.revert}
            <button class="btn ghost small act-revert" data-testid="activity-revert" title={t('Revert this change (only if the value has not changed since)')} onclick={() => app.edit.revertChange(d.id, r.field, r.from, r.to)}>{t('Undo')}</button>
          {/if}
        </div>
      {:else}
        <div class={['comment', item.pending && 'pending']} data-testid="comment" data-source={item.actor} data-id={item.id}>
          <div class="comment-head">
            <span class={['act-avatar', item.actor]} style="box-shadow: none">
              {#if item.actor === OWNER_KIND}
                <Avatar name={owner?.name} url={owner?.avatarUrl} size={18} />
              {:else}
                <span class="icon">{@html SOURCE_ICON[item.actor]}</span>
              {/if}
            </span>
            <span class="who">{item.actorName}</span>
            <span title={item.full}>{item.ago}{item.edited ? ` · ${t('edited')}` : ''}</span>
            {#if item.mine && !item.pending}
              <span class="tools">
                <button class="btn ghost small" data-testid="comment-edit" onclick={() => void startEditing(item.id, item.body ?? '')}>{t('Edit')}</button>
                {#if confirmDelete === item.id}
                  <button class="btn ghost small danger" data-testid="comment-delete-confirm" onclick={() => ((confirmDelete = null), void app.detail.removeComment(item.id))}>{t('Really delete')}</button>
                {:else}
                  <button class="btn ghost small" data-testid="comment-delete" onclick={() => (confirmDelete = item.id)}>{t('Delete')}</button>
                {/if}
              </span>
            {/if}
          </div>
          {#if editing === item.id}
            <TextEditor
              class="comment-input"
              testid="comment-edit-input"
              label={t('Edit comment')}
              value={editText}
              onchange={(text) => (editText = text)}
              onsubmit={() => {
                saveEdit(item.id);
                return true;
              }}
              onescape={() => {
                editing = null;
                return true;
              }}
              upload={{ issueId: d.id }}
              focusAt="end"
              bind:field={editInput}
            />
            <div class="comment-box-foot">
              <ImageButton field={() => editInput} target={{ issueId: d.id }} />
              <button class="btn ghost small" onclick={() => (editing = null)}>{t('Cancel')}</button>
              <button class="btn small primary" onclick={() => saveEdit(item.id)}>{t('Save')}</button>
            </div>
          {:else}
            {@const body = item.body ?? ''}
            <div class="comment-body" data-testid="comment-body"><Markdown markdown={body} ontoggle={item.mine && !item.pending ? (i, total) => toggle(item.id, body, i, total) : undefined} onlang={item.mine && !item.pending ? (i, total, lang) => setLang(item.id, body, i, total, lang) : undefined} /></div>
          {/if}
        </div>
      {/if}
    {/each}
  {/if}
  {#if !d.deleted && !d.pending}
    <div class="comment-box">
      <TextEditor
        class="comment-input"
        testid="comment-input"
        placeholder={t('Write a comment …')}
        value={draft}
        onchange={(text) => {
          draft = text;
          app.detail.setCommentDraft(d.id, text);
        }}
        onsubmit={() => {
          void send();
          return true;
        }}
        upload={{ issueId: d.id }}
        bind:field={input}
      />
      <div class="comment-box-foot">
        <ImageButton field={() => input} target={{ issueId: d.id }} />
        <span>{uploading(draft) ? t('Uploading image …') : t('Ctrl Enter to send')}</span>
        <button class="btn small primary" data-testid="comment-send" disabled={!draft.trim() || uploading(draft)} onclick={() => void send()}>{t('Comment')}</button>
      </div>
    </div>
  {/if}
</div>
