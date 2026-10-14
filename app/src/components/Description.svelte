<script lang="ts">
  // Description: shown rendered; a click edits it right in the formatted text (the editor loads on
  // demand, the cursor lands where you clicked). Saves automatically. If an agent changes it at the
  // same time, a notice offers a choice. Tasks can be checked and a code block's language chosen
  // without the editor.
  // Keyboard: Tab stops on the view, Enter, space or E edits (cursor at the end).
  import { formatShortcut, shortcutOf, type DetailState, type IssueId } from '@selfbound/core';
  import { t, tc } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { editorFocus, focusReturn, startKey } from '../lib/bodyView.ts';
  import type { ImageField } from '../lib/imageInput.ts';
  import { loadEditor } from '../lib/richtext.ts';
  import { setCodeLang } from '../lib/codeLang.ts';
  import { toggleTask } from '../lib/tasks.ts';
  import ImageButton from './ImageButton.svelte';
  import Markdown from './Markdown.svelte';
  import TextEditor from './TextEditor.svelte';

  let { detail: d }: { detail: DetailState } = $props();
  const descSlice = fromSlice(app.detail.desc);
  const e = $derived(descSlice.current);
  const syncSlice = fromSlice(app.store.sync);
  let field = $state<ImageField | null>(null);
  let focusAt = $state<{ x: number; y: number } | 'end' | null>('end');
  const back = focusReturn();
  const hintId = $props.id();
  // In the split inbox E means "remove", so only Enter is mentioned there.
  const shellSlice = fromSlice(app.shell);
  const hint = $derived(shellSlice.current.split ? t('Press Enter to edit') : t('Press Enter or {key} to edit', { key: formatShortcut(shortcutOf('issue.editDescription') ?? 'e') }));
  // Back to "end" after editing: E and Enter set no position, a click does.
  $effect(() => {
    if (!e.editing) focusAt = 'end';
  });

  async function begin(ev: MouseEvent) {
    if ((ev.target as HTMLElement).closest('a') || d.deleted) return;
    const at = { x: ev.clientX, y: ev.clientY };
    // Load the editor while the view is still shown (no jump through a textarea).
    await loadEditor().catch(() => {});
    focusAt = at;
    app.detail.startEdit();
  }

  async function beginAtEnd() {
    if (d.deleted || d.body === null) return;
    await loadEditor().catch(() => {});
    focusAt = 'end';
    app.detail.startEdit();
  }

  function finish() {
    back.arm();
    void app.detail.finishEdit();
  }

  async function toggle(index: number, total: number) {
    const body = d.body;
    if (!body || d.deleted) return;
    const next = toggleTask(body.markdown, index, total);
    if (next === null) return;
    try {
      await app.store.setDescription(d.id as IssueId, next, body.version);
    } catch (error) {
      app.toasts.error(t('Task not saved'), error);
    }
  }

  async function setLang(index: number, total: number, lang: string) {
    const body = d.body;
    if (!body || d.deleted) return;
    const next = await setCodeLang(body.markdown, index, total, lang);
    if (next === null) return app.toasts.show(t('The language can only be changed in the editor here (click into the description)'));
    if (next === body.markdown) return;
    try {
      await app.store.setDescription(d.id as IssueId, next, body.version);
    } catch (error) {
      app.toasts.error(t('Language not saved'), error);
    }
  }
</script>

{#if e.editing}
  <div class="desc edit" data-testid="desc-editor-wrap" {@attach editorFocus}>
    {#if e.conflict}
      <div class="desc-conflict" data-testid="desc-conflict" role="alert">
        <span class="grow">{t('{actor} just changed the description while you were typing. Your text is not lost.', { actor: e.conflict.by })}</span>
        <button class="btn small" data-testid="desc-keep-mine" onclick={() => app.detail.keepMine()}>{t('Keep mine')}</button>
        <button class="btn small ghost" data-testid="desc-take-theirs" onclick={() => app.detail.takeTheirs()}>{t('Take theirs')}</button>
      </div>
    {/if}
    <TextEditor
      class="desc-editor"
      testid="desc-editor"
      placeholder={t('Add description … ("/" for blocks)')}
      label={t('Description')}
      value={e.text}
      onchange={(text) => app.detail.input(text)}
      onblur={() => void app.detail.saveDescription()}
      onescape={() => {
        finish();
        return true;
      }}
      upload={{ issueId: d.id }}
      {focusAt}
      bind:field
    />
    <div class="desc-tools">
      <ImageButton field={() => field} target={{ issueId: d.id }} />
      <span data-testid="desc-state">{e.conflict ? t('Not saved') : e.saving ? t('Saving …') : e.dirty ? t('Unsaved') : t('Saved automatically')}</span>
      <span class="bar-spacer"></span>
      <span class="desc-hint">{t('"/" blocks · Ctrl B / I / K · images with Ctrl V · Esc done')}</span>
      <button class="btn small" data-testid="desc-done" onclick={finish}>{tc('button', 'Done')}</button>
    </div>
  </div>
{:else}
  <!-- No role="button": the view contains links, task checkboxes and language buttons that would be
       unreachable inside a button. Instead a named group with a tab stop and a hint; Enter and space
       act only on the group itself (startKey). The mouse click stays. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="desc view"
    data-testid="detail-description"
    role="group"
    aria-label={t('Description')}
    aria-describedby={d.deleted || d.body === null ? undefined : hintId}
    tabindex={d.deleted || d.body === null ? undefined : 0}
    onpointerdown={(ev) => !(ev.target as HTMLElement).closest('a, input') && void loadEditor().catch(() => {})}
    onclick={begin}
    onkeydown={startKey(() => void beginAtEnd())}
    {@attach back.attach}
  >
    {#if d.body === null}
      <div data-testid="detail-loading">
        <div class="skeleton-bar" style="width: 82%; margin: 8px 0"></div>
        <div class="skeleton-bar" style="width: 64%; margin: 8px 0"></div>
        <div class="skeleton-bar" style="width: 74%; margin: 8px 0"></div>
        <!-- Descriptions are not cached: when offline, say why it is missing. -->
        {#if syncSlice.current.offline}<p class="desc-offline" role="status" data-testid="desc-offline">{t('Offline: the description loads once the network is back.')}</p>{/if}
      </div>
    {:else if d.body.markdown.trim()}
      <Markdown markdown={d.body.markdown} ontoggle={d.deleted ? undefined : toggle} onlang={d.deleted ? undefined : setLang} />
    {:else}
      <span class="desc-placeholder">{t('Add description …')}</span>
    {/if}
  </div>
  <span class="sr-only" id={hintId}>{hint}</span>
{/if}
