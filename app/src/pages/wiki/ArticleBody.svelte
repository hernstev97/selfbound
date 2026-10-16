<script lang="ts">
  // Body of a knowledge page, like an issue description (components/Description.svelte): view,
  // click to edit at that spot, autosave, conflict with a choice. Keyboard as there: Tab stops on the
  // view, Enter, Space or E edits.
  import { formatShortcut, shortcutOf, type ArticleView } from '@selfbound/core';
  import { t, tc } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { editorFocus, focusReturn, startKey } from '../../lib/bodyView.ts';
  import type { ImageField } from '../../lib/imageInput.ts';
  import { loadEditor } from '../../lib/richtext.ts';
  import { setCodeLang } from '../../lib/codeLang.ts';
  import { toggleTask } from '../../lib/tasks.ts';
  import ImageButton from '../../components/ImageButton.svelte';
  import Markdown from '../../components/Markdown.svelte';
  import TextEditor from '../../components/TextEditor.svelte';

  let { article: a }: { article: ArticleView } = $props();
  const editSlice = fromSlice(app.wiki.edit);
  const e = $derived(editSlice.current);
  let field = $state<ImageField | null>(null);
  let focusAt = $state<{ x: number; y: number } | 'end' | null>('end');
  const back = focusReturn();
  const hintId = $props.id();
  const hint = t('Press Enter or {key} to edit', { key: formatShortcut(shortcutOf('wiki.editBody') ?? 'e') });
  $effect(() => {
    if (!e.editing) focusAt = 'end';
  });

  async function begin(ev: MouseEvent) {
    if ((ev.target as HTMLElement).closest('a') || a.deleted) return;
    const at = { x: ev.clientX, y: ev.clientY };
    await loadEditor().catch(() => {});
    focusAt = at;
    app.wiki.startEdit();
  }

  async function beginAtEnd() {
    if (a.deleted) return;
    await loadEditor().catch(() => {});
    focusAt = 'end';
    app.wiki.startEdit();
  }

  function finish() {
    back.arm();
    void app.wiki.finishEdit();
  }

  function toggle(index: number, total: number) {
    if (a.deleted) return;
    const next = toggleTask(a.body.markdown, index, total);
    if (next !== null) void app.wiki.setText(next, a.body.version);
  }

  async function setLang(index: number, total: number, lang: string) {
    if (a.deleted) return;
    const next = await setCodeLang(a.body.markdown, index, total, lang);
    if (next === null) return app.toasts.show(t('The language can only be changed in the editor here (click into the text)'));
    if (next !== a.body.markdown) void app.wiki.setText(next, a.body.version);
  }
</script>

{#if e.editing}
  <div class="desc edit wiki-body" data-testid="article-editor-wrap" {@attach editorFocus}>
    {#if e.conflict}
      <div class="desc-conflict" data-testid="article-conflict" role="alert">
        <span class="grow">{t('{actor} just changed the page while you were typing. Your text is not lost.', { actor: e.conflict.by })}</span>
        <button class="btn small" data-testid="article-keep-mine" onclick={() => app.wiki.keepMine()}>{t('Keep mine')}</button>
        <button class="btn small ghost" data-testid="article-take-theirs" onclick={() => app.wiki.takeTheirs()}>{t('Take theirs')}</button>
      </div>
    {/if}
    <TextEditor
      class="desc-editor"
      testid="article-editor"
      placeholder={t('Write … ("/" for blocks)')}
      label={t('Page text')}
      value={e.text}
      onchange={(text) => app.wiki.input(text)}
      onblur={() => void app.wiki.save()}
      onescape={() => {
        finish();
        return true;
      }}
      upload={{ articleId: a.id }}
      {focusAt}
      bind:field
    />
    <div class="desc-tools">
      <ImageButton field={() => field} target={{ articleId: a.id }} />
      <span data-testid="article-state">{e.conflict ? t('Not saved') : e.saving ? t('Saving …') : e.dirty ? t('Unsaved') : t('Saved automatically')}</span>
      <span class="bar-spacer"></span>
      <span class="desc-hint">{t('"/" blocks · Ctrl B / I / K · images with Ctrl V · Esc done')}</span>
      <button class="btn small" data-testid="article-done" onclick={finish}>{tc('button', 'Done')}</button>
    </div>
  </div>
{:else}
  <!-- Named group instead of role="button" (it contains links and checkboxes); see Description.svelte. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="desc view wiki-body"
    data-testid="article-body"
    role="group"
    aria-label={t('Page text')}
    aria-describedby={a.deleted ? undefined : hintId}
    tabindex={a.deleted ? undefined : 0}
    onpointerdown={(ev) => !(ev.target as HTMLElement).closest('a, input') && void loadEditor().catch(() => {})}
    onclick={begin}
    onkeydown={startKey(() => void beginAtEnd())}
    {@attach back.attach}
  >
    {#if a.body.markdown.trim()}
      <Markdown markdown={a.body.markdown} keep={a.id} ontoggle={a.deleted ? undefined : toggle} onlang={a.deleted ? undefined : setLang} />
    {:else}
      <span class="desc-placeholder">{t('Write …')}</span>
    {/if}
  </div>
  <span class="sr-only" id={hintId}>{hint}</span>
{/if}
