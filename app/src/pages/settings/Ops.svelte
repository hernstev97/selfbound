<script lang="ts">
  // Ops: a readable summary of ops.status and health.status. The traffic light is only a small
  // dot; the text carries the message.
  import { ICON, fullDate, relativeTime } from '@xlr8/core';
  import { intlLocale, t, tn } from '@xlr8/core/i18n';
  import { api } from '@xlr8/backend/api';
  import { useQuery } from '../../lib/live.svelte.ts';

  const status = useQuery(api.ops.status, {});
  const health = useQuery(api.health.status, {});
  const s = $derived(status.current);
  const h = $derived(health.current);

  const DAY = 86_400_000;
  type Tone = 'ok' | 'warn' | 'bad' | 'none';
  const num = (n: number, digits = 0) => n.toLocaleString(intlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });

  const backup = $derived.by(() => {
    const b = s?.backup as { value: { ok?: boolean; at?: number; bytes?: number; documents?: number; files?: number }; at: number } | null | undefined;
    if (!b) return { tone: 'warn' as Tone, title: t('No backup reported yet'), text: t('The nightly backup run has never reported in. Until it does, the data lives only in the backend.') };
    const at = b.value?.at ?? b.at;
    const old = Date.now() - at > 2 * DAY;
    if (b.value?.ok === false) return { tone: 'bad' as Tone, title: t('Last backup failed'), text: t('Reported {time} ({date}). Please check the backup run.', { time: relativeTime(at), date: fullDate(at) }) };
    const size = b.value?.bytes ? ` · ${num(b.value.bytes / 1_048_576, 1)} MB` : '';
    const docs = b.value?.documents ? ` · ${t('{count} documents', { count: num(b.value.documents) })}` : '';
    return { tone: (old ? 'warn' : 'ok') as Tone, title: old ? t('Backup is older than two days') : t('Backup is fine'), text: `${t('Last {time} ({date})', { time: relativeTime(at), date: fullDate(at) })}${size}${docs}.` };
  });

  const importInfo = $derived.by(() => {
    const r = s?.lastImport;
    if (!r) return { tone: 'none' as Tone, title: t('No import from Linear yet'), text: t('Once issues are imported from Linear, the result shows up here.') };
    const counts = (r.counts ?? {}) as Record<string, Record<string, number>>;
    const issues = counts.issue ?? {};
    const parts = [t('{count} new', { count: issues.created ?? 0 }), t('{count} updated', { count: issues.updated ?? 0 }), t('{count} unchanged', { count: issues.unchanged ?? 0 })];
    if (issues.skipped) parts.push(t('{count} skipped', { count: issues.skipped }));
    const conflicts = issues.conflicts ?? issues.collisions ?? 0;
    const when = r.finishedAt ?? r.startedAt;
    if (r.status === 'failed') return { tone: 'bad' as Tone, title: t('Last import aborted'), text: `${relativeTime(when)}: ${r.error ?? t('unknown error')}` };
    if (r.status === 'running') return { tone: 'warn' as Tone, title: t('Import is running'), text: r.phase ? t('Started {time}, step "{phase}".', { time: relativeTime(r.startedAt), phase: r.phase }) : t('Started {time}.', { time: relativeTime(r.startedAt) }) };
    return {
      tone: (r.deviations > 0 || conflicts > 0 ? 'warn' : 'ok') as Tone,
      title: t('Last import finished'),
      text: `${t('{time}: issues {parts}.', { time: relativeTime(when), parts: parts.join(', ') })} ${conflicts ? `${t('{count} identifiers collided (XLR8 issue renamed).', { count: conflicts })} ` : ''}${r.deviations ? t('{count} deviations noted.', { count: r.deviations }) : t('No deviations.')}`,
    };
  });

  const audit = $derived.by(() => {
    const a = s?.sprintAudit as { value: { ok: boolean; problems: string[]; sprints: number; items: number }; at: number } | null | undefined;
    if (!a) return { tone: 'none' as Tone, title: t('Sprint check has not run yet'), text: t('The nightly check (01:15 UTC) compares sprint entries and issues.'), problems: [] as string[] };
    if (a.value.ok) return { tone: 'ok' as Tone, title: t('Sprints are consistent'), text: t('Checked {time}: {sprints} sprints, {items} entries, all consistent.', { time: relativeTime(a.at), sprints: a.value.sprints, items: a.value.items }), problems: [] as string[] };
    return { tone: 'bad' as Tone, title: t('Sprint check found deviations'), text: t('Checked {time}.', { time: relativeTime(a.at) }), problems: a.value.problems.slice(0, 8) };
  });

  // File storage: the Convex free tier includes 1 GB (images, logos). Yellow from 70 %, red from 90 %.
  const STORAGE_LIMIT = 1024 ** 3;
  const mb = (bytes: number) => `${num(bytes / 1_048_576, bytes < 10 * 1_048_576 ? 1 : 0)} MB`;
  const storage = $derived.by(() => {
    const st = s?.storage;
    if (!st) return { tone: 'none' as Tone, title: t('Storage unknown'), text: '', share: 0 };
    const share = st.bytes / STORAGE_LIMIT;
    const pct = share > 0 && share < 0.001 ? t('under {n}', { n: num(0.1, 1) }) : num(share * 100, share < 0.1 ? 1 : 0);
    // More files than counted (capped): the sum is only a lower bound, so never "fine".
    const tone: Tone = share >= 0.9 ? 'bad' : share >= 0.7 || st.capped ? 'warn' : 'ok';
    const images = t('{count} images ({size})', { count: num(st.images), size: mb(st.imageBytes) });
    const orphaned = st.orphaned ? t(', {count} of them unreferenced (deleted after the grace period)', { count: st.orphaned }) : '';
    const files = st.capped ? t('At least {count} files in total', { count: num(st.files) }) : t('{count} files in total', { count: num(st.files) });
    return {
      tone,
      title: st.capped ? t('File storage: at least {size} of 1 GB', { size: mb(st.bytes) }) : t('File storage: {size} of 1 GB ({pct} %)', { size: mb(st.bytes), pct }),
      text: `${files}, ${images}${orphaned}. ${t('Data transfer (1 GB per month) is shown in the Convex dashboard.')}`,
      share,
    };
  });

  // Revoked keys with calls today stay visible (marked as revoked).
  const agents = $derived([...(s?.agents ?? [])].filter((a) => a.revokedAt === null || a.callsToday > 0).sort((a, b) => b.callsToday - a.callsToday));
</script>

<h1 class="page-title">{t('Ops')}</h1>
<p class="page-lead">{t('Is everything running? This page reads the state directly from the backend.')}</p>

{#if !s || !h}
  <div class="card-list"><div class="card-row muted">{t('Loading …')}</div></div>
{:else}
  <div class="ops-grid" data-testid="ops-page">
    <div class="ops-card" data-testid="ops-backup" data-tone={backup.tone}>
      <div class="ops-head"><span class={['tone', backup.tone]}></span>{backup.title}</div>
      <p>{backup.text}</p>
    </div>
    <div class="ops-card" data-testid="ops-import" data-tone={importInfo.tone}>
      <div class="ops-head"><span class={['tone', importInfo.tone]}></span>{importInfo.title}</div>
      <p>{importInfo.text}</p>
    </div>
    <div class="ops-card" data-testid="ops-audit" data-tone={audit.tone}>
      <div class="ops-head"><span class={['tone', audit.tone]}></span>{audit.title}</div>
      <p>{audit.text}</p>
      {#if audit.problems.length}<ul class="ops-list">{#each audit.problems as p, i (i)}<li>{p}</li>{/each}</ul>{/if}
    </div>
    <div class="ops-card" data-testid="ops-storage" data-tone={storage.tone}>
      <div class="ops-head"><span class={['tone', storage.tone]}></span>{storage.title}</div>
      <div class="ops-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.min(100, Math.round(storage.share * 100))} aria-label={t('File storage used')}><span style:width="{Math.min(100, Math.max(storage.share * 100, storage.share > 0 ? 1 : 0))}%" class={storage.tone}></span></div>
      <p>{storage.text}</p>
    </div>
    <div class="ops-card" data-testid="ops-github" data-tone={s.github ? 'ok' : 'none'}>
      <div class="ops-head"><span class={['tone', s.github ? 'ok' : 'none']}></span>{s.github ? t('GitHub is delivering') : t('Nothing from GitHub yet')}</div>
      <p>{s.github ? t('Last delivery {time} ({event}).', { time: relativeTime(s.github.receivedAt), event: s.github.event }) : t('Once a repository uses the webhook, the last delivery shows up here.')}</p>
    </div>
  </div>

  <h2 class="section-title">{t('Agents today')}</h2>
  <div class="card-list" data-testid="ops-agents">
    {#each agents as a (a._id)}
      <div class={['card-row', a.revokedAt !== null && 'archived']} data-testid="ops-agent" data-revoked={a.revokedAt !== null}>
        <span class="icon" style="color: var(--text-muted)">{@html ICON.agent}</span>
        <span class="t">{a.name}<div class="sub">{a.revokedAt !== null ? t('revoked {time}', { time: relativeTime(a.revokedAt) }) : a.lastUsedAt ? t('last used {time}', { time: relativeTime(a.lastUsedAt) }) : t('never used')}</div></span>
        <span class="num">{tn(a.callsToday, '{count} call', '{count} calls')}</span>
        {#if a.revokedAt !== null}<span class="state-badge revoked">{t('revoked')}</span>{/if}
      </div>
    {:else}
      <div class="card-row muted">{t('No active agent keys.')}</div>
    {/each}
  </div>

  <h2 class="section-title">{t('Backend')}</h2>
  <div class="card-list" data-testid="ops-health">
    <div class="card-row">
      <span class={['tone', h.ok ? 'ok' : 'bad']}></span>
      <span class="t">{h.ok ? t('Backend reachable') : t('Backend reports a problem')}<div class="sub">{h.local ? t('Running locally on this machine.') : t('Running in the cloud.')}</div></span>
    </div>
    <div class="card-row">
      <span class={['tone', h.devAuth && !h.local ? 'bad' : h.devAuth ? 'warn' : 'ok']}></span>
      <span class="t">{h.devAuth ? t('Local test sign-in is active') : t('Local test sign-in is off')}<div class="sub">{h.devAuth ? t('Fine for trying things out. It must be off before real use.') : h.devAuthConfigured ? t('Configured, but not in effect here (only on your own machine).') : t('Sign-in only through the real account.')}</div></span>
    </div>
    <div class="card-row">
      <span class={['tone', h.clerk ? 'ok' : 'none']}></span>
      <span class="t">{h.clerk ? t('Sign-in through Clerk is set up') : t('Clerk is not set up yet')}<div class="sub">{h.clerk ? t('You sign in with your account.') : t('Comes with the first deployment.')}</div></span>
    </div>
    <div class="card-row">
      <span class={['tone', h.testSwitches ? 'warn' : 'ok']}></span>
      <span class="t">{h.testSwitches ? t('Test switches available') : t('No test switches')}<div class="sub">{h.testSwitches ? (s.rejectWrites ? t('Active right now: the server rejects changes.') : t('Tests only: "Server rejects" is off.')) : t('Same as in production.')}</div></span>
    </div>
  </div>
{/if}
