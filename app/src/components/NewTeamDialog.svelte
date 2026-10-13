<script lang="ts">
  // Add team (sidebar "Teams" +, O N, command menu): name, key, optionally a logo.
  // The UI checks the key first (instant feedback); the server (teams.create) has the final say.
  // Afterwards the new team is the current team.
  import { untrack } from 'svelte';
  import { ICON, type TeamBadge } from '@xlr8/core';
  import { t } from '@xlr8/core/i18n';
  import { leave } from '../lib/motion.ts';
  import { modal } from '../lib/modal.ts';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import TeamLogo from './TeamLogo.svelte';

  const openSlice = fromSlice(app.newTeamOpen);
  const metaSlice = fromSlice(app.store.meta);
  const teams = $derived(metaSlice.current?.teams ?? []);

  const KEY_RE = /^[A-Z][A-Z0-9]{1,5}$/;
  let name = $state('');
  let key = $state('');
  let keyTouched = $state(false);
  let logo = $state<File | null>(null);
  /** Knowledge area: none, next to the issues, or knowledge only */
  let wiki = $state<'' | 'on' | 'only'>('');
  const WIKI_MODES = [
    ['', t('Issues')],
    ['on', t('Issues and knowledge')],
    ['only', t('Knowledge only')],
  ] as const;
  let logoUrl = $state<string | null>(null);
  let logoError = $state<string | null>(null);
  let serverError = $state<string | null>(null);
  let busy = $state(false);

  // Start empty on open.
  $effect(() => {
    if (!openSlice.current) return;
    untrack(() => {
      name = '';
      key = '';
      wiki = '';
      keyTouched = false;
      setLogo(null);
      logoError = null;
      serverError = null;
      busy = false;
    });
  });
  $effect(() => {
    if (!keyTouched) key = name.replace(/[^A-Za-z0-9]/g, '').replace(/^[0-9]+/, '').slice(0, 4).toUpperCase();
  });

  const normalized = $derived(key.trim().toUpperCase());
  const keyError = $derived.by(() => {
    // Not while creating: once the new team is in the metadata, its key would count as taken.
    if (!normalized || busy) return null;
    if (!KEY_RE.test(normalized)) return t('The key needs 2 to 6 characters: capital letters and digits, starting with a letter.');
    if (teams.some((team) => team.key === normalized)) return t('The key {key} is already taken.', { key: normalized });
    return null;
  });
  const ready = $derived(name.trim() !== '' && normalized !== '' && !keyError && !busy);
  const preview = $derived<TeamBadge>({ id: 'new', key: normalized || name.trim().slice(0, 1).toUpperCase() || '?', name: name.trim(), hue: 220, logo: logoUrl });

  function setLogo(file: File | null) {
    if (logoUrl) URL.revokeObjectURL(logoUrl);
    logo = file;
    logoUrl = file ? URL.createObjectURL(file) : null;
  }

  async function pickLogo(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const { precheckLogo } = await import('@xlr8/core/app/admin');
    logoError = precheckLogo(file);
    setLogo(logoError ? null : file);
  }

  const close = () => app.newTeamOpen.set(false);

  /** Waits until the new team is in the metadata so the sidebar knows it right away. */
  function known(teamKey: string) {
    if (app.store.meta.get()?.teams.some((team) => team.key === teamKey)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, 3000);
      const stop = app.store.meta.subscribe(() => {
        if (app.store.meta.get()?.teams.some((team) => team.key === teamKey)) done();
      });
      function done() {
        clearTimeout(timer);
        stop();
        resolve();
      }
    });
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!ready) return;
    busy = true;
    serverError = null;
    let admin: typeof import('../pages/settings/admin.ts').admin;
    let HUES: number[];
    try {
      [{ admin }, { HUES }] = await Promise.all([import('../pages/settings/admin.ts'), import('@xlr8/core/app/admin')]);
    } catch {
      serverError = t('The dialog could not be loaded completely. Please try again.');
      busy = false;
      return;
    }
    const result = await admin.createTeamChecked({ key: normalized, name: name.trim(), hue: HUES[teams.length % HUES.length], ...(wiki ? { wiki } : {}) });
    if ('error' in result) {
      serverError = result.error;
      busy = false;
      return;
    }
    // The team exists. A logo the server rejects does not stop the creation.
    if (logo) {
      const error = await admin.uploadLogo(result.teamId as never, logo, 'light');
      if (error) app.toasts.show(t('Team {key} created, but the logo is missing: {error}', { key: result.key, error }));
    }
    await known(result.key);
    // If the user closed the dialog meanwhile (Esc), the team stays created but the page does not change.
    const stillOpen = app.newTeamOpen.get();
    close();
    app.toasts.show(t('Team {key} created', { key: result.key }));
    if (stillOpen) app.switchTeam(result.key);
  }
</script>

{#if openSlice.current}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="overlay team-dialog-overlay"
    out:leave
    {@attach modal()}
    data-testid="new-team-overlay"
    onpointerdown={(e) => {
      if (e.target === e.currentTarget && !busy) close();
    }}
  >
    <div class="team-dialog" role="dialog" aria-modal="true" aria-label={t('Add team')} data-testid="new-team-dialog">
    <form onsubmit={submit}>
      <h2 class="team-dialog-title">{t('Add team')}</h2>
      <div class="team-dialog-logo">
        <TeamLogo team={preview} size={40} />
        <div class="team-dialog-logo-text">
          <span>{t('Logo')} <span class="muted">{t('(optional)')}</span></span>
          <span class="muted">{t('SVG or PNG, square, at most 256 KB.')}</span>
        </div>
        <label class="btn small">
          <span class="icon">{@html ICON.import}</span>{logo ? t('Replace') : t('Upload')}
          <input type="file" accept="image/svg+xml,image/png,.svg,.png" class="visually-hidden" data-testid="new-team-logo" disabled={busy} onchange={(e) => void pickLogo(e.currentTarget)} />
        </label>
        {#if logo}<button type="button" class="btn ghost small" disabled={busy} onclick={() => setLogo(null)}>{t('Remove')}</button>{/if}
      </div>
      {#if logoError}<div class="team-dialog-error" role="alert" data-testid="new-team-logo-error">{logoError}</div>{/if}
      <label class="team-dialog-field">
        <span>{t('Name')}</span>
        <input class="input" data-testid="new-team-name" data-autofocus bind:value={name} placeholder={t('e.g. Acme')} autocomplete="off" disabled={busy} />
      </label>
      <label class="team-dialog-field">
        <span>{t('Key')}<span class="muted"> · {t('2–6 characters, part of every identifier ({example})', { example: 'ACME-12' })}</span></span>
        <input class="input mono short" data-testid="new-team-key" bind:value={key} maxlength="6" autocomplete="off" disabled={busy} oninput={() => (keyTouched = true)} aria-invalid={keyError ? 'true' : undefined} />
      </label>
      {#if keyError || serverError}<div class="team-dialog-error" role="alert" data-testid="new-team-error">{keyError ?? serverError}</div>{/if}
      <div class="team-dialog-field">
        <span>{t('Content')}<span class="muted"> · {t('"Knowledge only": pages instead of issues, e.g. sources on a topic')}</span></span>
        <span class="seg" data-testid="new-team-wiki">
          {#each WIKI_MODES as [value, label] (value)}<button type="button" class={[wiki === value && 'on']} data-value={value || 'none'} disabled={busy} onclick={() => (wiki = value)}>{label}</button>{/each}
        </span>
      </div>
      <div class="team-dialog-foot">
        <button class="btn ghost small" type="button" disabled={busy} onclick={close}>{t('Cancel')}</button>
        <button class="btn primary small" type="submit" data-testid="new-team-submit" disabled={!ready}>{busy ? t('Creating …') : t('Create team')}</button>
      </div>
    </form>
    </div>
  </div>
{/if}
