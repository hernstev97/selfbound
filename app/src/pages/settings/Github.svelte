<script lang="ts">
  // GitHub: is XLR8 connected to GitHub, which repos can the token see, is the webhook in place
  // everywhere? The token itself lives only in the backend (GITHUB_TOKEN) and never comes here.
  import { api } from '@xlr8/backend/api';
  import { t, tn, translated } from '@xlr8/core/i18n';
  import { fullDate, relativeTime } from '@xlr8/core';
  import { app } from '../../app-instance.ts';
  import { useQuery } from '../../lib/live.svelte.ts';

  const connection = useQuery(api.githubPr.connection, {});
  const c = $derived(connection.current);
  let checking = $state(false);

  async function check() {
    checking = true;
    try {
      await app.store.act(api.githubPr.ensureWebhooks, {});
    } catch (error) {
      app.toasts.error(t('Check failed'), error);
    } finally {
      checking = false;
    }
  }

  const HOOK_LABEL: Record<string, string> = translated({ ok: 'Webhook active', created: 'Webhook created', updated: 'Webhook updated', missing: 'Webhook missing', outdated: 'Webhook outdated', error: 'Error' });
  const problems = $derived((c?.repos ?? []).filter((r) => r.hook === 'error' || r.hook === 'missing' || r.hook === 'outdated'));
</script>

<h1 class="page-title">GitHub</h1>
<p class="page-lead">{t('Pull requests from all repos the token can access appear on the linked issue: with description, checks, comments and reviews; merge and comment right in XLR8.')}</p>

{#if !c}
  <div class="card-list"><div class="card-row muted">{t('Loading …')}</div></div>
{:else}
  <div class="card-list" data-testid="github-connection">
    <div class="card-row">
      <span class={['tone', c.configured ? (c.error ? 'bad' : 'ok') : 'none']}></span>
      <span class="t"
        >{c.configured ? (c.login ? t('Connected as {login}', { login: c.login }) : t('Token configured')) : t('Not connected')}
        <div class="sub">
          {#if !c.configured}
            {t('The backend has no')} <code>GITHUB_TOKEN</code> {t('(fine-grained token, see docs/operations.md, section "GitHub webhook").')}
          {:else if c.error}
            {c.error}
          {:else if c.checkedAt}
            {t('{count} repos, checked {time} ({date}).', { count: c.repos.length, time: relativeTime(c.checkedAt), date: fullDate(c.checkedAt) })} {c.manage ? t('XLR8 checks again daily and sets up the webhook in new repos.') : t('XLR8 checks again daily.')}
          {:else}
            {t('Not checked yet.')}
          {/if}
          {#if c.local}<br />{t('Local backend: webhooks are only shown here, never created.')}
          {:else if c.configured && !c.manage}<br />{t('Webhooks are only checked, not created')} (<code>GITHUB_MANAGE_WEBHOOKS=1</code> {t('turns this on')}).{/if}
        </div></span
      >
      {#if c.configured}
        <button class="btn small" disabled={checking} data-testid="github-check" onclick={() => void check()}>{checking ? t('Checking …') : t('Check now')}</button>
      {/if}
    </div>
  </div>

  {#if c.repos.length}
    <h2 class="section-title">{t('Repos')} {#if problems.length}<span class="muted">{tn(problems.length, '{count} with a problem', '{count} with problems')}</span>{/if}</h2>
    <div class="card-list" data-testid="github-repos">
      {#each c.repos as r (r.repo)}
        <div class="card-row">
          <span class={['tone', r.hook === 'error' ? 'bad' : r.hook === 'missing' || r.hook === 'outdated' ? 'warn' : 'ok']}></span>
          <span class="t">{r.repo}{#if r.error}<div class="sub">{r.error}</div>{/if}</span>
          <span class="num">{HOOK_LABEL[r.hook] ?? r.hook}</span>
        </div>
      {/each}
    </div>
  {/if}
{/if}
