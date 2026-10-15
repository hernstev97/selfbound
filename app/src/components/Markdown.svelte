<script lang="ts">
  // Rendered Markdown (marked + DOMPurify, loaded on demand). Plain text until the library is loaded.
  // Code blocks with a language get highlighted a moment later (own chunks); every block gets a
  // "Copy" button and the language at the top right. With `ontoggle` tasks can be clicked, with
  // `onlang` the language chosen (description, your own comments); the change happens in the source
  // text (lib/tasks.ts, lib/codeLang.ts), not here.
  import type { Attachment } from 'svelte/attachments';
  import { parsePath } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { languageLabel } from '../lib/languages.ts';
  import { highlightReady, loadHighlight, needsHighlight } from '../lib/highlightLoad.ts';
  import { cardEmbeds, driveEmbeds, highlightVersion, onHighlightChange, onMarkdownReady, renderMarkdown } from '../lib/markdown.ts';
  import LangPicker from './LangPicker.svelte';
  import { app } from '../app-instance.ts';

  interface Props {
    markdown: string;
    class?: string;
    ontoggle?: (index: number, total: number) => void;
    onlang?: (index: number, total: number, lang: string) => void;
  }

  let { markdown, class: cls = '', ontoggle, onlang }: Props = $props();
  let ready = $state(false);
  let colors = $state(highlightVersion());
  onMarkdownReady(() => (ready = true));
  $effect(() => {
    colors = highlightVersion(); // a change between init and now
    return onHighlightChange(() => (colors = highlightVersion()));
  });
  const html = $derived.by(() => {
    void colors; // render again once highlighting is loaded or the theme changed
    return ready ? renderMarkdown(markdown) : null;
  });

  $effect(() => {
    if (ready && needsHighlight(markdown) && !highlightReady(markdown)) loadHighlight(markdown).catch(() => {}); // if loading fails, the block stays plain
  });

  let root = $state<HTMLElement>();

  // After every new HTML (reads `html`, so it runs again afterwards): insert Drive players and
  // YouTube/X cards once they become visible.
  const embeds: Attachment<HTMLElement> = (el) => {
    void html;
    const stopDrive = driveEmbeds(el);
    const stopCards = cardEmbeds(el);
    return () => {
      stopDrive?.();
      stopCards?.();
    };
  };

  // Issue mentions get their live status icon and title.
  const mentions: Attachment<HTMLElement> = (el) => {
    void html;
    if (!el.querySelector('a.xlink-issue')) return;
    let stop: (() => void) | undefined;
    let gone = false;
    import('../lib/mentions.ts').then(({ decorateMentions }) => {
      if (!gone) stop = decorateMentions(el, app.store);
    }, () => {}); // if loading fails, the links stay plain
    return () => {
      gone = true;
      stop?.();
    };
  };

  // Visual blocks (```mermaid …): drawn once visible; the module loads only if the text has one.
  const blocks: Attachment<HTMLElement> = (el) => {
    void html;
    if (!el.querySelector('.vblock[data-block]')) return;
    let stop: (() => void) | undefined;
    let gone = false;
    import('../lib/blocks/mount.ts').then(({ mountBlocks }) => {
      if (!gone) stop = mountBlocks(el);
    }, () => {}); // if loading fails, the source block stays
    return () => {
      gone = true;
      stop?.();
    };
  };

  // Buttons are added after sanitizing (DOMPurify deliberately drops <button>).
  // Language: selectable where editing is allowed, otherwise only its name (and only if set).
  $effect(() => {
    html;
    const editable = !!onlang;
    if (!root) return;
    const copyText = t('Copy');
    const chooseText = t('Choose language');
    for (const block of root.querySelectorAll<HTMLElement>('.codeblock')) {
      block.querySelector('.codebar')?.remove();
      const bar = document.createElement('div');
      bar.className = 'codebar';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'codecopy';
      button.dataset.testid = 'code-copy';
      button.textContent = copyText;
      bar.append(button);
      const lang = block.dataset.lang ?? '';
      if (editable || lang) {
        const label = document.createElement(editable ? 'button' : 'span');
        label.className = lang ? 'codelang' : 'codelang empty';
        label.dataset.testid = 'code-lang';
        label.textContent = languageLabel(lang);
        if (label instanceof HTMLButtonElement) {
          label.type = 'button';
          label.title = chooseText;
          label.setAttribute('aria-haspopup', 'listbox');
        }
        bar.append(label);
      }
      block.append(bar);
    }
  });

  let picker = $state<{ index: number; total: number; current: string; anchor: DOMRect } | null>(null);

  function pickLang(lang: string) {
    const p = picker;
    picker = null;
    if (p && onlang) onlang(p.index, p.total, lang);
  }

  // Make tasks clickable (DOMPurify sets them to `disabled`).
  $effect(() => {
    html;
    if (!root || !ontoggle) return;
    root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box, i) => {
      box.disabled = false;
      box.dataset.task = String(i);
      box.dataset.testid = 'task-box';
      box.setAttribute('aria-label', box.checked ? t('Mark as open') : t('Mark as done'));
    });
  });

  async function onclick(event: MouseEvent) {
    // Using a chart (table toggle, hovering and clicking in the plot) does not start editing the text.
    if ((event.target as Element).closest('.vchart-toggle, .vchart-svg, .vchart-table')) {
      event.stopPropagation();
      return;
    }
    const box = (event.target as Element).closest<HTMLInputElement>('input[data-task]');
    if (box && ontoggle) {
      // The check mark comes with the saved text (optimistically), not from the browser.
      event.preventDefault();
      event.stopPropagation();
      ontoggle(Number(box.dataset.task), root?.querySelectorAll('input[data-task]').length ?? 0);
      return;
    }
    const langButton = (event.target as Element).closest<HTMLButtonElement>('button.codelang');
    if (langButton && onlang && root) {
      event.stopPropagation();
      const blocks = [...root.querySelectorAll<HTMLElement>('.codeblock')];
      const block = langButton.closest<HTMLElement>('.codeblock')!;
      picker = { index: blocks.indexOf(block), total: blocks.length, current: block.dataset.lang ?? '', anchor: langButton.getBoundingClientRect() };
      return;
    }
    // Links into the app (knowledge page, issue): without a modifier key, open in the app instead of reloading.
    const nav = (event.target as Element).closest<HTMLAnchorElement>('a[data-nav]');
    if (nav) {
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      const page = parsePath(nav.getAttribute('href') ?? '');
      if (page.name === 'issue' || page.name === 'article') app.nav.go(page);
      return;
    }
    const button = (event.target as Element).closest<HTMLButtonElement>('.codecopy');
    if (!button) return;
    event.stopPropagation();
    const code = button.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = t('Copied');
    } catch {
      button.textContent = t('Not possible');
    }
    setTimeout(() => (button.textContent = t('Copy')), 1500);
  }
</script>

{#if html !== null}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class={['md', cls]} bind:this={root} {onclick} {@attach embeds} {@attach blocks} {@attach mentions}>{@html html}</div>
{:else}
  <div class={['md', cls]} style="white-space: pre-wrap">{markdown}</div>
{/if}

{#if picker && onlang}
  <LangPicker current={picker.current} anchor={picker.anchor} onpick={pickLang} onclose={() => (picker = null)} />
{/if}

<style>
  .md :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    vertical-align: top;
  }
  .md :global(a.md-img) {
    display: inline-block;
    max-width: 100%;
    border-radius: 6px;
    outline-offset: 2px;
  }
  .md :global(a.md-img img) {
    display: block;
    /* Light images in the dark theme (and vice versa) need an edge. */
    box-shadow: 0 0 0 1px var(--border);
  }
  .md :global(.upload-note) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px dashed var(--border-strong);
    color: var(--text-muted);
    font-size: 0.92em;
  }
  .md :global(.upload-note.failed) {
    color: var(--danger-text);
    border-color: color-mix(in oklch, var(--danger) 50%, transparent);
  }
  .md :global(.drive-embed) {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 640px;
    margin: 0.5em 0;
  }
  .md :global(.drive-embed iframe) {
    width: 100%;
    aspect-ratio: 16 / 9;
    border: 0;
    border-radius: 8px;
    background: var(--bg-raised);
    box-shadow: 0 0 0 1px var(--border);
  }
  .md :global(.drive-open) {
    font-size: 0.86em;
    color: var(--text-muted);
  }
</style>
