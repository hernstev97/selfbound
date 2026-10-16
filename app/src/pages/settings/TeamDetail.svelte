<script lang="ts">
  // One team: name, key (renaming a team with issues asks first; old identifiers keep working),
  // color, dormant, light/dark logos with a preview on light and dark ground at 16/20/32 px. Upload: upload URL → file → check on the
  // server (SVG/PNG, square, ≤ 256 KB, SVG without scripts); errors show at the field.
  import { ICON, type TeamBadge, type TeamId } from '@selfbound/core';
  import { TEAM_KEY_RE } from '@selfbound/backend/constants';
  import { t, tn } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import TeamLogo from '../../components/TeamLogo.svelte';
  import InlineText from './InlineText.svelte';
  import HuePicker from './HuePicker.svelte';
  import Workflow from './Workflow.svelte';
  import TeamModel from './TeamModel.svelte';
  import Dialog from './Dialog.svelte';
  import { admin } from './admin.ts';
  import type { LogoVariant } from '@selfbound/core/app/admin';

  let { teamKey }: { teamKey: string } = $props();
  const metaSlice = fromSlice(app.store.meta);
  const versionSlice = fromSlice(app.store.version);
  const team = $derived(metaSlice.current?.teams.find((x) => x.key === teamKey) ?? null);
  const issues = $derived.by(() => {
    void versionSlice.current;
    if (!team) return { count: 0, last: 0 };
    let count = 0;
    let last = 0;
    for (const i of app.store.all()) {
      if (i.teamId !== team._id) continue;
      count++;
      last = Math.max(last, i.number);
    }
    return { count, last };
  });
  const issueCount = $derived(issues.count);

  let busy = $state<LogoVariant | null>(null);
  let errors = $state<Record<LogoVariant, string | null>>({ light: null, dark: null });

  /** Badge for a preview: light logo on light ground, dark (otherwise light) logo on dark ground. */
  function preview(dark: boolean): TeamBadge {
    const tm = team!;
    return { id: tm._id, key: tm.key, name: tm.name, hue: tm.hue, logo: (dark ? (tm.logoDarkUrl ?? tm.logoUrl) : (tm.logoUrl ?? tm.logoDarkUrl)) ?? null };
  }

  async function upload(variant: LogoVariant, input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file || !team) return;
    busy = variant;
    errors[variant] = null;
    const error = await admin.uploadLogo(team._id as TeamId, file, variant);
    busy = null;
    errors[variant] = error;
    if (!error) app.toasts.show(t('Logo for {name} set', { name: team.name }));
  }

  /** New key waiting for confirmation (the team has issues, so every identifier changes). */
  let renaming = $state<string | null>(null);

  /** Checked before asking (the server checks again), so the dialog only offers keys that work. */
  function keyProblem(key: string): string | null {
    if (!TEAM_KEY_RE.test(key)) return t('The key needs 2 to 6 characters: capital letters and digits, starting with a letter.');
    const others = (metaSlice.current?.teams ?? []).filter((x) => x._id !== team?._id);
    if (others.some((x) => x.key === key)) return t('The key {key} is already taken.', { key });
    const former = others.find((x) => x.previousKeys?.includes(key));
    if (former) return t('{key} was the key of {team}: old identifiers like {example} still lead there.', { key, team: former.name, example: `${key}-12` });
    return null;
  }

  function setKey(next: string) {
    if (!team) return;
    const key = next.trim().toUpperCase();
    if (key === team.key) return;
    const problem = keyProblem(key);
    if (problem) app.toasts.show(t('Team not updated'), undefined, 'error', problem);
    else if (issueCount > 0) renaming = key;
    else rename(key);
  }

  function rename(key: string) {
    renaming = null;
    if (!team) return;
    const before = team.key;
    void admin.updateTeam(team._id as TeamId, { key }).then((r) => {
      // The optimistic rename may already have moved this page; if the server said no, move it back.
      const page = app.nav.page.get();
      if (page.name === 'settings' && page.section === 'teams' && (page.sub === key || page.sub === before)) {
        app.nav.go({ name: 'settings', section: 'teams', sub: r ? key : before }, { replace: true });
      }
    });
  }
  const WIKI_MODES = [[null, t('Off')], ['on', t('Alongside issues')], ['only', t('Knowledge only')]] as const;
</script>

{#if !team}
  <div class="empty" style="padding: 48px 0">
    <div class="empty-text">{t('Team {key} does not exist.', { key: teamKey })}</div>
    <button class="btn" onclick={() => app.nav.go({ name: 'settings', section: 'teams' })}>{t('Go to teams')}</button>
  </div>
{:else}
  <div class="title-row">
    <TeamLogo team={preview(app.prefs.dark.get())} size={32} />
    <h1 class="page-title">{team.name}</h1>
  </div>
  <p class="page-lead">{team.wiki === 'only' ? t('Knowledge only') : `${tn(issueCount, '{count} issue', '{count} issues')} · ${t('identifiers like {example}', { example: `${team.key}-12` })}`}</p>

  <h2 class="section-title">{t('General')}</h2>
  <div class="card-list" data-testid="team-detail">
    <div class="card-row">
      <span class="t">{t('Name')}</span>
      <InlineText value={team.name} label={t('Name')} testid="team-name" save={(v) => admin.updateTeam(team!._id as TeamId, { name: v })} />
    </div>
    <div class="card-row">
      <span class="t">{t('Key')}<div class="sub">{issueCount > 0 ? t('Part of every identifier. After a rename, old identifiers keep working.') : t('2–6 characters, capital letters and digits.')}</div>{#if team.previousKeys?.length}<div class="sub" data-testid="team-previous-keys">{t('Previously: {keys}', { keys: team.previousKeys.join(', ') })}</div>{/if}</span>
      <InlineText value={team.key} label={t('Key')} testid="team-key" mono maxlength={6} save={setKey} />
    </div>
    <div class="card-row">
      <span class="t">{t('Color')}<div class="sub">{t('For the placeholder without a logo.')}</div></span>
      <HuePicker hue={team.hue} testid="team-hue" pick={(h) => admin.updateTeam(team!._id as TeamId, { hue: h })} />
    </div>
    <div class="card-row">
      <span class="t">{t('Dormant')}<div class="sub">{t('Dormant teams are listed in the sidebar under "More" and are left out of sprint planning.')}</div></span>
      <button class={['toggle', team.dormant && 'on']} role="switch" aria-checked={team.dormant} aria-label={t('Dormant')} data-testid="team-dormant" onclick={() => admin.updateTeam(team!._id as TeamId, { dormant: !team!.dormant })}></button>
    </div>
    <div class="card-row">
      <span class="t">{t('Knowledge')}<div class="sub">{t('Pages for knowledge and documentation. "Knowledge only": the team has no issues (only possible without open issues and active recurrences). "Off" is only possible while the area is empty.')}</div></span>
      <span class="seg" data-testid="team-wiki">
        {#each WIKI_MODES as [value, label] (label)}<button class={[(team.wiki ?? null) === value && 'on']} data-value={value ?? 'off'} onclick={() => admin.updateTeam(team!._id as TeamId, { wiki: value })}>{label}</button>{/each}
      </span>
    </div>
    {#if team.wiki !== 'only'}<TeamModel {team} />{/if}
  </div>

  {#if team.wiki !== 'only'}<Workflow {team} />{/if}

  <h2 class="section-title">{t('Logo')}</h2>
  <p class="section-lead">{t('SVG or PNG, square, at most 256 KB. Optionally a second logo for dark backgrounds. From Inkscape, save as "Plain SVG".')}</p>
  <div class="card-list" data-testid="team-logos">
    {#each [['light', t('Logo'), team.logoUrl], ['dark', t('Logo for dark backgrounds'), team.logoDarkUrl]] as const as [variant, label, url] (variant)}
      <div class="card-row logo-row" data-testid="logo-{variant}">
        <span class="t">{label}
          <div class="sub">{url ? t('Set') : variant === 'dark' ? t('Not set: dark mode uses the normal logo') : t('Not set: placeholder from key and color')}</div>
          {#if errors[variant]}<div class="field-error" role="alert" data-testid="logo-error-{variant}">{errors[variant]}</div>{/if}
        </span>
        <label class={['btn small', busy === variant && 'busy']}>
          <span class="icon">{@html ICON.import}</span>{busy === variant ? t('Checking …') : url ? t('Replace') : t('Upload')}
          <input type="file" accept="image/svg+xml,image/png,.svg,.png" class="visually-hidden" data-testid="logo-file-{variant}" disabled={busy !== null} onchange={(e) => void upload(variant, e.currentTarget)} />
        </label>
        {#if url}<button class="btn ghost small" data-testid="logo-remove-{variant}" onclick={() => admin.removeLogo(team!._id as TeamId, variant)}>{t('Remove')}</button>{/if}
      </div>
    {/each}
  </div>

  <div class="logo-preview" data-testid="logo-preview">
    {#each [false, true] as dark (dark)}
      <div class={['logo-ground', dark ? 'dark' : 'light']}>
        <span class="ground-label">{dark ? t('Dark') : t('Light')}</span>
        <TeamLogo team={preview(dark)} size={16} />
        <TeamLogo team={preview(dark)} size={20} />
        <TeamLogo team={preview(dark)} size={32} />
        <span class="ground-row"><TeamLogo team={preview(dark)} size={16} /><span class="ground-key">{team.key}-128</span><span>{t('This is how it looks in lists')}</span></span>
      </div>
    {/each}
  </div>
{/if}

{#if renaming && team}
  {@const n = issues.last || 12}
  <Dialog title={t('Rename {old} to {new}?', { old: team.key, new: renaming })} close={() => (renaming = null)} testid="team-rename-dialog">
    <p class="dialog-text">{tn(issueCount, '{count} issue gets a new identifier, {old} becomes {new}.', '{count} issues get new identifiers, {old} becomes {new}.', { old: `${team.key}-${n}`, new: `${renaming}-${n}` })}</p>
    <p class="dialog-text">{t('Old identifiers keep working: links, bookmarks, mentions, branch names, pull requests and agents still find the issues. {old} stays reserved for this team. Texts that mention {old} are not rewritten.', { old: team.key })}</p>
    <div class="dialog-foot">
      <button class="btn ghost" onclick={() => (renaming = null)}>{t('Cancel')}</button>
      <button class="btn primary" data-testid="team-rename-confirm" onclick={() => rename(renaming!)}>{t('Rename key')}</button>
    </div>
  </Dialog>
{/if}
