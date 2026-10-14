<script lang="ts">
  // Project and topics of a knowledge page: a project of the team (project docs), topics as chips
  // with a picker; a new topic is created straight from the input.
  import { ICON, type ArticleView, type WikiState } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';
  import { backCloses } from '../../lib/ui.ts';

  let { article: a, state: s }: { article: ArticleView; state: WikiState } = $props();
  let open = $state(false);
  let query = $state('');
  let box = $state<HTMLElement>();

  const chosen = $derived(s.topics.filter((x) => a.topicIds.includes(x.id)));
  const matches = $derived(s.topics.filter((x) => (!x.archived || a.topicIds.includes(x.id)) && x.name.toLowerCase().includes(query.trim().toLowerCase())));
  const exact = $derived(s.topics.some((x) => x.name.toLowerCase() === query.trim().toLowerCase()));

  function toggle(id: string) {
    const next = a.topicIds.includes(id) ? a.topicIds.filter((x) => x !== id) : [...a.topicIds, id];
    void app.wiki.setTopics(a.id, next);
  }

  async function create() {
    const name = query.trim();
    if (!name || exact) return;
    const id = await app.wiki.createTopic(name);
    query = '';
    if (id) void app.wiki.setTopics(a.id, [...a.topicIds, id]);
  }

  $effect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (box && !box.contains(e.target as Node)) open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  });
</script>

<div class="wiki-props" data-testid="article-props">
  <label class="chip wiki-project">
    <span class="icon">{@html ICON.projects}</span>
    <select
      aria-label={t('Project')}
      data-testid="article-project"
      disabled={a.deleted}
      value={a.projectId ?? ''}
      onchange={(e) => void app.wiki.setProject(a.id, (e.currentTarget as HTMLSelectElement).value || null)}
    >
      <option value="">{t('No project')}</option>
      {#each s.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
    </select>
  </label>
  {#each chosen as topic (topic.id)}
    <span class="chip wiki-topic" style:--hue={topic.hue} data-testid="article-topic">{topic.name}</span>
  {/each}
  <span class="wiki-topic-picker" bind:this={box}>
    <button class="chip unset" data-testid="article-topics" disabled={a.deleted} onclick={() => (open = !open)}><span class="icon">{@html ICON.label}</span>{chosen.length ? t('Topics') : t('Topic')}</button>
    {#if open}
      <div class="wiki-menu" role="listbox" aria-label={t('Topics')} data-testid="topic-menu" {@attach backCloses(() => (open = false))}>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="input"
          placeholder={t('Search or create a topic …')}
          bind:value={query}
          autofocus
          data-testid="topic-input"
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              // This exact topic exists: toggle it; otherwise create and set it.
              const hit = s.topics.find((x) => x.name.toLowerCase() === query.trim().toLowerCase());
              if (hit) toggle(hit.id);
              else void create();
            } else if (e.key === 'Escape') open = false;
          }}
        />
        {#each matches as topic (topic.id)}
          <label class="wiki-menu-row">
            <input type="checkbox" checked={a.topicIds.includes(topic.id)} onchange={() => toggle(topic.id)} />
            <span class="wiki-dot" style:--hue={topic.hue}></span>{topic.name}{#if topic.archived}<span class="muted"> · {t('archived')}</span>{/if}
          </label>
        {/each}
        {#if query.trim() && !exact}
          <button class="wiki-menu-row" data-testid="topic-create" onclick={() => void create()}><span class="icon">{@html ICON.plus}</span>{t('Create topic "{name}"', { name: query.trim() })}</button>
        {/if}
      </div>
    {/if}
  </span>
</div>
