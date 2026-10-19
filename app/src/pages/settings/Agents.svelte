<script lang="ts">
  // Agents: API keys (Claude Code, Codex, other MCP clients) and connectors (claude.ai, ChatGPT via
  // OAuth). List with key prefix or app, created, last used, calls today, revoked.
  // A new key is shown exactly once here (with a ready-made command for Claude Code), afterwards
  // only its prefix. Connectors are added through "Connect connector" (armed for 15 minutes) and
  // the consent page. Revoking is final and needs a confirmation.
  import { ICON, relativeTime, fullDate } from '@selfbound/core';
  import { t, tc, translated } from '@selfbound/core/i18n';
  import { api } from '@selfbound/backend/api';
  import type { Id } from '@selfbound/backend/dataModel';
  import { mcpCommand, siteUrl } from '@selfbound/core/app/admin';
  import { app } from '../../app-instance.ts';
  import { useQuery } from '../../lib/live.svelte.ts';
  import { DOCS } from '../../lib/docs.ts';
  import Dialog from './Dialog.svelte';
  import { CONVEX_URL, SITE_URL_ENV, admin } from './admin.ts';

  const status = useQuery(api.ops.status, {});
  const agents = $derived([...(status.current?.agents ?? [])].sort((a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null) || b.createdAt - a.createdAt));
  const site = siteUrl(CONVEX_URL, SITE_URL_ENV);
  const connectors = $derived(status.current?.connectors);
  let now = $state(Date.now());
  $effect(() => {
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });
  const armedLeft = $derived(Math.max(0, (status.current?.connectorsArmedUntil ?? 0) - now));
  const APP_LABEL = { claude: 'claude.ai', chatgpt: 'ChatGPT' } as const;
  const REASON = translated({ owner: 'Revoked by you', code_reuse: 'Code used twice', refresh_reuse: 'Refresh token used twice', client: 'Disconnected by the app' });
  const countdown = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

  let creating = $state(false);
  let name = $state('');
  let busy = $state(false);
  let created = $state<{ name: string; key: string; keyPrefix: string } | null>(null);
  let revoking = $state<{ _id: Id<'agents'>; name: string; keyPrefix: string | null; connector: { app: 'claude' | 'chatgpt' } | null } | null>(null);

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    busy = true;
    const result = await admin.createAgent(name.trim());
    busy = false;
    if (result) {
      created = { name: name.trim(), key: result.key, keyPrefix: result.keyPrefix };
      name = '';
      creating = false;
    }
  }

  async function revoke() {
    if (!revoking) return;
    const r = revoking;
    revoking = null;
    if (await admin.revokeAgent(r._id)) app.toasts.show(r.connector ? t('Connector {name} revoked', { name: r.name }) : t('Key of {name} revoked', { name: r.name }));
  }
</script>

<div class="title-row">
  <h1 class="page-title">{t('Agents')}</h1>
  <button class="btn small" data-testid="agent-add" onclick={() => (creating = !creating)}><span class="icon">{@html ICON.plus}</span>{t('Create key')}</button>
</div>
<p class="page-lead">{t('Each agent (Claude Code, Codex, other MCP clients) gets its own key for MCP access at')} <span class="mono">{site}/mcp</span>. {t('Claude and ChatGPT connect as a connector by signing in. Changes appear in the history with the agent name.')}</p>

<div class="card-list connectors" data-testid="connector-card">
  <div class="card-row col">
    <span class="t">{t('Connector for claude.ai or ChatGPT')}</span>
    {#if connectors === undefined}
      <span class="sub">{t('Loading …')}</span>
    {:else if !connectors.enabled || !connectors.url}
      <span class="sub" data-testid="connector-off">{t('Not enabled on this backend (SELFBOUND_APP_URL is missing).')} <a href={DOCS.connectors} target="_blank" rel="noopener noreferrer">{t('How to set it up')}</a></span>
    {:else}
      <ol class="steps sub">
        <li>{t('Press "Connect connector". Selfbound then accepts new connections for 15 minutes.')}</li>
        <li>{t('claude.ai: Settings → Connectors → Add custom connector. ChatGPT: Settings → Apps → add your own MCP server. Enter this URL as the address:')}</li>
      </ol>
      <div class="copy-field">
        <code data-testid="connector-url">{connectors.url}</code>
        <button class="btn small" data-testid="connector-url-copy" onclick={() => void app.edit.copy(connectors.url!, t('Address'))}><span class="icon">{@html ICON.copy}</span>{t('Copy')}</button>
      </div>
      <ol class="steps sub" start="3">
        <li>{t('Sign in and allow access on the Selfbound consent page. The connector then appears in the list below.')}</li>
      </ol>
      <div class="arm-row">
        {#if armedLeft > 0}
          <span class="sub" data-testid="connector-armed">{t('Accepting new connectors, {time} min left', { time: countdown(armedLeft) })}</span>
          <button class="btn ghost small" data-testid="connector-disarm" onclick={() => void admin.armConnectors(false)}>{t('Stop')}</button>
        {:else}
          <button class="btn primary small" data-testid="connector-arm" onclick={() => void admin.armConnectors(true)}>{t('Connect connector')}</button>
        {/if}
      </div>
    {/if}
  </div>
</div>

{#if creating}
  <form class="card-list form" onsubmit={create} data-testid="agent-form">
    <label class="card-row"><span class="t">{t('Agent name')}</span><input class="input" data-testid="agent-name" placeholder={t('e.g. {example}', { example: 'Claude Code' })} bind:value={name} {@attach (n) => n.focus()} /></label>
    <div class="card-row end"><button class="btn ghost small" type="button" onclick={() => (creating = false)}>{t('Cancel')}</button><button class="btn primary small" type="submit" data-testid="agent-create" disabled={busy}>{t('Generate')}</button></div>
  </form>
{/if}

<div class="card-list" data-testid="agent-list">
  {#if status.current === undefined}
    <div class="card-row muted">{t('Loading …')}</div>
  {:else if agents.length === 0}
    <div class="card-row muted">{t('No agents yet.')}</div>
  {/if}
  {#each agents as a (a._id)}
    <div class={['card-row', a.revokedAt !== null && 'archived']} data-testid="agent-row" data-name={a.name} data-connector={a.connector?.app}>
      <span class="icon" style="color: var(--text-muted)">{@html ICON.agent}</span>
      <span class="t">{a.name}
        <div class="sub">{#if a.connector}<span class="state-badge" data-testid="agent-connector">Connector · {APP_LABEL[a.connector.app]}</span>{:else}<span class="mono">{a.keyPrefix}…</span>{/if} · {t('created {time}', { time: relativeTime(a.createdAt) })} · {a.lastUsedAt ? t('last used {time}', { time: relativeTime(a.lastUsedAt) }) : t('never used')}</div>
      </span>
      <span class="sub num" title={t('Calls today')}>{t('{count} today', { count: a.callsToday })}</span>
      {#if a.revokedAt !== null}
        <span class="state-badge revoked" data-testid="agent-revoked" title={`${fullDate(a.revokedAt)}${a.revokedReason && a.revokedReason !== 'owner' ? ` · ${REASON[a.revokedReason]}` : ''}`}>{a.revokedReason && a.revokedReason !== 'owner' ? `${t('revoked')} · ${REASON[a.revokedReason]}` : t('revoked')}</span>
      {:else}
        <button class="btn ghost small danger" data-testid="agent-revoke" onclick={() => (revoking = a)}>{t('Revoke')}</button>
      {/if}
    </div>
  {/each}
</div>

{#if created}
  {@const command = mcpCommand(site, created.key)}
  <Dialog title={t('Key for {name}', { name: created.name })} close={() => (created = null)} testid="agent-key-dialog">
    <p class="dialog-text">{t('The key is shown only now. Copy it before you close this window.')}</p>
    <div class="copy-field">
      <code data-testid="agent-key">{created.key}</code>
      <button class="btn small" data-testid="agent-key-copy" onclick={() => void app.edit.copy(created!.key, t('API key'))}><span class="icon">{@html ICON.copy}</span>{t('Copy')}</button>
    </div>
    <p class="dialog-text">{t('For Claude Code:')}</p>
    <div class="copy-field">
      <code data-testid="agent-command">{command}</code>
      <button class="btn small" data-testid="agent-command-copy" onclick={() => void app.edit.copy(command, t('Command'))}><span class="icon">{@html ICON.copy}</span>{t('Copy')}</button>
    </div>
    <div class="dialog-foot"><button class="btn primary" data-testid="agent-key-done" onclick={() => (created = null)}>{tc('button', 'Done')}</button></div>
  </Dialog>
{/if}

{#if revoking}
  <Dialog title={t('Revoke {name}?', { name: revoking.name })} close={() => (revoking = null)} testid="agent-revoke-dialog">
    {#if revoking.connector}
      <p class="dialog-text">{t('{app} loses access immediately. This cannot be undone; for new access, reconnect the connector in the app.', { app: APP_LABEL[revoking.connector.app] })}</p>
    {:else}
      <p class="dialog-text">{t('The key {prefix} stops working. This cannot be undone; the agent will then need a new key.', { prefix: `${revoking.keyPrefix}…` })}</p>
    {/if}
    <div class="dialog-foot">
      <button class="btn ghost" onclick={() => (revoking = null)}>{t('Cancel')}</button>
      <button class="btn danger-fill" data-testid="agent-revoke-confirm" onclick={() => void revoke()}>{t('Revoke for good')}</button>
    </div>
  </Dialog>
{/if}

<style>
  .connectors {
    margin-bottom: 20px;
  }
  .steps {
    margin: 4px 0 0;
    padding-left: 18px;
    display: grid;
    gap: 4px;
  }
  .arm-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
  }
  .connectors .copy-field {
    margin: 8px 0 4px;
  }
</style>
