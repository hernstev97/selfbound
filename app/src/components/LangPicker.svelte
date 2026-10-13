<script lang="ts">
  // Language picker on a code block: list with search, arrow keys, Enter, Esc.
  // The same picker in the view (description, your own comments) and in the editor.
  import { t } from '@xlr8/core/i18n';
  import { LANGUAGES, langWord, languageFor, plainLabel } from '../lib/languages.ts';

  interface Action {
    id: string;
    label: string;
    run: () => void;
  }

  interface Props {
    /** Current info string of the block ("ts", "" …) */
    current: string;
    /** Anchor rectangle (viewport coordinates) */
    anchor: { left: number; right: number; top: number; bottom: number };
    onpick: (lang: string) => void;
    onclose: () => void;
    /** More entries below the list (editor: "Convert to text") */
    actions?: Action[];
  }

  let { current, anchor, onpick, onclose, actions = [] }: Props = $props();

  interface Entry {
    id: string;
    label: string;
    run: () => void;
    action?: boolean;
  }

  let query = $state('');
  let active = $state(0);
  // svelte-ignore state_referenced_locally
  const currentId = languageFor(current)?.id ?? langWord(current);

  const entries = $derived.by((): Entry[] => {
    const q = query.trim().toLowerCase();
    const langs: Entry[] = [{ id: '', label: plainLabel(), run: () => onpick('') }];
    for (const l of LANGUAGES) langs.push({ id: l.id, label: l.label, run: () => onpick(l.id) });
    // An unknown info string on the block stays selectable (otherwise the next click would lose it).
    if (currentId && !languageFor(currentId)) langs.push({ id: currentId, label: currentId, run: () => onpick(currentId) });
    const hits = q
      ? langs.filter((e) => e.label.toLowerCase().includes(q) || e.id.includes(q) || LANGUAGES.find((l) => l.id === e.id)?.aliases.includes(q))
      : langs;
    // A language nobody knows: take it as typed
    if (q && /^[\w#+.-]{1,24}$/.test(q) && !hits.some((e) => e.id === q || e.label.toLowerCase() === q)) hits.push({ id: q, label: t('Use "{lang}"', { lang: q }), run: () => onpick(q) });
    return [...hits, ...actions.map((a) => ({ ...a, action: true }))];
  });

  // Without a query the highlight is on the current language, otherwise on the first hit.
  $effect(() => {
    active = query.trim() ? 0 : Math.max(0, entries.findIndex((e) => !e.action && e.id === currentId));
  });

  const width = 220;
  const maxHeight = 300;
  const below = $derived(anchor.bottom + maxHeight + 8 < innerHeight);
  const left = $derived(Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8)));
  const top = $derived(below ? anchor.bottom + 4 : anchor.top - 4);

  let list = $state<HTMLElement>();
  let search = $state<HTMLInputElement>();

  // `autofocus` does not work reliably on elements inserted later.
  $effect(() => {
    search?.focus();
  });

  function keydown(event: KeyboardEvent) {
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === 'ArrowDown') {
      active = (active + 1) % Math.max(1, entries.length);
      stop();
    } else if (event.key === 'ArrowUp') {
      active = (active - 1 + entries.length) % Math.max(1, entries.length);
      stop();
    } else if (event.key === 'Enter') {
      entries[active]?.run();
      stop();
    } else if (event.key === 'Escape') {
      onclose();
      stop();
    } else if (event.key === 'Tab') {
      stop();
    }
  }

  $effect(() => {
    void active;
    list?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  class="lang-picker"
  class:above={!below}
  style:left="{left}px"
  style:top="{top}px"
  style:width="{width}px"
  data-testid="lang-picker"
  onmousedown={(e) => e.stopPropagation()}
  onclick={(e) => e.stopPropagation()}
  onfocusout={(e) => !e.currentTarget.contains(e.relatedTarget as HTMLElement | null) && onclose()}
>
  <input
    bind:this={search}
    class="lang-search"
    placeholder={t('Search language …')}
    aria-label={t('Search language')}
    data-testid="lang-search"
    spellcheck="false"
    autocomplete="off"
    bind:value={query}
    onkeydown={keydown}
  />
  <div class="lang-list" role="listbox" aria-label={t('Language')} bind:this={list}>
    {#each entries as entry, i (entry.action ? `action:${entry.id}` : entry.id)}
      {#if entry.action && (i === 0 || !entries[i - 1]!.action)}<div class="lang-sep"></div>{/if}
      <button
        type="button"
        class={['lang-item', i === active && 'active', entry.action && 'action']}
        role="option"
        aria-selected={i === active}
        data-testid="lang-item"
        data-id={entry.id}
        tabindex="-1"
        onmousedown={(e) => e.preventDefault()}
        onmouseenter={() => (active = i)}
        onclick={() => entry.run()}
      >
        <span>{entry.label}</span>
        {#if !entry.action && entry.id === currentId}<span class="lang-check" aria-label={t('selected')}>✓</span>{/if}
      </button>
    {/each}
  </div>
</div>

<style>
  .lang-picker {
    position: fixed;
    z-index: 70;
    display: flex;
    flex-direction: column;
    max-height: 300px;
    padding: 4px;
    border-radius: 10px;
    background: var(--bg-popover);
    box-shadow: var(--shadow-popover);
    font-family: var(--font);
    font-size: var(--fs-small);
    white-space: normal;
  }
  .lang-picker.above {
    transform: translateY(-100%);
  }
  .lang-search {
    flex: none;
    height: 30px;
    margin: 0 0 4px;
    padding: 0 8px;
    border: 0;
    border-bottom: 1px solid var(--border);
    border-radius: 0;
    outline: none;
    background: none;
    color: var(--text);
    font: inherit;
  }
  .lang-search::placeholder {
    color: var(--text-subtle);
  }
  .lang-list {
    overflow-y: auto;
    min-height: 0;
  }
  .lang-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    height: 30px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .lang-item.active {
    background: var(--bg-row-hover);
    color: var(--text-strong);
  }
  .lang-item.action {
    color: var(--text-muted);
  }
  .lang-check {
    color: var(--text-muted);
    font-size: 12px;
  }
  .lang-sep {
    height: 1px;
    margin: 4px 0;
    background: var(--border);
  }
  @media (max-width: 768px) {
    .lang-search {
      font-size: 16px;
      height: 36px;
    }
    .lang-item {
      height: 40px;
      font-size: 15px;
    }
  }
</style>
