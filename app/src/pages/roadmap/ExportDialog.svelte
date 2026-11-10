<script lang="ts">
  // Image export of the roadmap (SELF-113): a PNG of the release view or the progress tracker with
  // public issues only, to share on Discord. The preview IS the file (rendered and encoded on every
  // change), so what is downloaded or copied is exactly what was looked at. Options are remembered.
  import '../../styles/pages.css';
  import '../../styles/forms.css';
  import { ICON } from '@selfbound/core';
  import type { ExportData } from '@selfbound/core/app/roadmap';
  import { intlLocale, t, tn } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { leave } from '../../lib/motion.ts';
  import { modal } from '../../lib/modal.ts';
  import { backCloses } from '../../lib/ui.ts';
  import { STAGE_TEXT, PROJECT_STATE_TEXT, monthText, periodText } from './labels.ts';
  import { SIZE_LIMIT, exportPng, fileName, type ExportFile, type ExportLayout, type ExportView } from './exportImage.ts';

  interface Options {
    view: ExportView;
    layout: ExportLayout;
    dark: boolean;
    date: boolean;
    logo: boolean;
    includeEmpty: boolean;
    showGoals: boolean;
    /** Unchecked projects (so new projects are in by default) */
    skip: string[];
    subtitle: string | null;
  }

  const KEY = 'selfbound:roadmapExport';
  const uiSlice = fromSlice(app.roadmap.ui);
  const metaSlice = fromSlice(app.store.meta);
  const team = $derived(app.roadmap.team());
  const projects = $derived(metaSlice.current?.projects.filter((p) => p.teamId === team?._id && p.state !== 'canceled').sort((a, b) => a.order - b.order) ?? []);

  function read(): Options {
    const base: Options = { view: uiSlice.current.tab === 'progress' ? 'progress' : 'roadmap', layout: 'landscape', dark: true, date: true, logo: true, includeEmpty: false, showGoals: false, skip: [], subtitle: null };
    try {
      const saved = JSON.parse(localStorage.getItem(`${KEY}:${uiSlice.current.team}`) ?? '{}') as Partial<Options>;
      return { ...base, ...saved, view: base.view };
    } catch {
      return base;
    }
  }
  let o = $state(read());
  /** A plain copy that reads every option (so effects track them); no $state.snapshot, which would put a Svelte helper into the start bundle. */
  const plain = (): Options => ({ ...o, skip: [...o.skip] });
  let subtitle = $state(o.subtitle ?? app.roadmap.team()?.roadmap?.subtitle ?? '');
  $effect(() => {
    const snapshot = { ...plain(), subtitle: subtitle.trim() || null };
    try {
      localStorage.setItem(`${KEY}:${uiSlice.current.team}`, JSON.stringify(snapshot));
    } catch {
      // Not remembered; the export works anyway.
    }
  });

  const today = new Date();
  const dayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const asOf = () => t('As of {date}', { date: new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(today) });

  const data = $derived.by((): ExportData | null => {
    void metaSlice.current;
    void uiSlice.current;
    const chosen = projects.filter((p) => !o.skip.includes(p._id)).map((p) => p._id as string);
    return app.roadmap.exportData({ projects: chosen, includeEmpty: o.includeEmpty, showGoals: o.showGoals });
  });
  const cards = $derived(data ? data.columns.reduce((n, c) => n + c.total, 0) : 0);
  const rows = $derived(data?.rows.length ?? 0);
  const nothing = $derived(o.view === 'roadmap' ? cards === 0 : rows === 0);
  const hasLogo = $derived(!!(data?.logo.light || data?.logo.dark));

  let file = $state<ExportFile | null>(null);
  let url = $state<string | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let run = 0;

  // Render after a short pause; a newer change wins.
  $effect(() => {
    const d = data;
    const opts = plain();
    const sub = subtitle.trim() || null;
    if (!d) return;
    const mine = ++run;
    busy = true;
    error = null;
    const timer = setTimeout(async () => {
      try {
        const result = await exportPng(d, {
          view: opts.view,
          layout: opts.layout,
          dark: opts.dark,
          subtitle: sub,
          logo: opts.logo,
          labels: {
            stage: STAGE_TEXT,
            state: PROJECT_STATE_TEXT,
            doneOf: (done, total) => t('{done} of {total} done', { done, total }),
            period: (x) => periodText(x.period),
            quarter: (quarter, year) => t('Q{quarter} {year}', { quarter, year }),
            month: (year, month) => monthText(year, month),
            today: t('Today'),
            empty: t('Nothing announced yet'),
            asOf: opts.date ? asOf() : null,
          },
        });
        if (mine !== run) return;
        if (url) URL.revokeObjectURL(url);
        file = result;
        url = URL.createObjectURL(result.blob);
        if (app.debug) (globalThis as { __selfboundRoadmapExport?: unknown }).__selfboundRoadmapExport = { data: d, size: result.blob.size, width: result.width, height: result.height };
      } catch (e) {
        if (mine === run) error = e instanceof Error ? e.message : String(e);
      } finally {
        if (mine === run) busy = false;
      }
    }, 200);
    return () => clearTimeout(timer);
  });
  $effect(() => () => {
    if (url) URL.revokeObjectURL(url);
  });

  function close() {
    app.roadmap.exportOpen.set(false);
  }

  function download() {
    if (!file || !url || !data) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(data.title, o.view, dayKey);
    document.body.append(a);
    a.click();
    a.remove();
    app.toasts.show(t('Picture saved'));
  }

  async function copy() {
    if (!file) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': file.blob })]);
      app.toasts.show(t('Picture copied: paste it into Discord with Ctrl V'));
    } catch (e) {
      app.toasts.error(t('Picture not copied'), e);
    }
  }

  const mb = (bytes: number) => new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024);
  const toggleProject = (id: string) => (o.skip = o.skip.includes(id) ? o.skip.filter((x) => x !== id) : [...o.skip, id]);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="overlay dim rx-overlay"
  out:leave|global
  {@attach modal()}
  {@attach backCloses(() => close())}
  onpointerdown={(e) => {
    if (e.target === e.currentTarget) close();
  }}
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }}
>
  <div class="rx-dialog" role="dialog" aria-modal="true" aria-labelledby="rx-title" data-testid="roadmap-export-dialog">
    <header class="rx-head">
      <h2 id="rx-title">{t('Export as image')}</h2>
      <button class="icon-btn plain" aria-label={t('Close')} onclick={close}><span class="icon">{@html ICON.close}</span></button>
    </header>
    <div class="rx-body">
      <div class="rx-options">
        <p class="rx-lead">{t('Only issues marked as public appear, with their public title, summary and picture. Descriptions, comments and identifiers never do.')}</p>
        <div class="rx-field">
          <span class="rx-label">{t('View')}</span>
          <span class="seg rx-seg">
            <button class={[o.view === 'roadmap' && 'on']} aria-pressed={o.view === 'roadmap'} data-testid="export-view-roadmap" onclick={() => (o.view = 'roadmap')}>{t('Roadmap')}</button>
            <button class={[o.view === 'progress' && 'on']} aria-pressed={o.view === 'progress'} data-testid="export-view-progress" onclick={() => (o.view = 'progress')}>{t('Progress')}</button>
          </span>
        </div>
        <div class="rx-field">
          <span class="rx-label">{t('Format')}</span>
          <span class="seg rx-seg">
            <button class={[o.layout === 'landscape' && 'on']} aria-pressed={o.layout === 'landscape'} data-testid="export-landscape" onclick={() => (o.layout = 'landscape')}>{t('1920 wide (Discord)')}</button>
            <button class={[o.layout === 'portrait' && 'on']} aria-pressed={o.layout === 'portrait'} data-testid="export-portrait" onclick={() => (o.layout = 'portrait')}>{t('1080 (phone)')}</button>
          </span>
        </div>
        <div class="rx-field">
          <span class="rx-label">{t('Look')}</span>
          <span class="seg rx-seg">
            <button class={[o.dark && 'on']} aria-pressed={o.dark} data-testid="export-dark" onclick={() => (o.dark = true)}>{t('Dark')}</button>
            <button class={[!o.dark && 'on']} aria-pressed={!o.dark} data-testid="export-light" onclick={() => (o.dark = false)}>{t('Light')}</button>
          </span>
        </div>
        <label class="rx-field">
          <span class="rx-label">{t('Subtitle')}</span>
          <input class="input" bind:value={subtitle} maxlength={160} placeholder={t('e.g. Early access, what comes next')} data-testid="export-subtitle" />
        </label>
        <div class="rx-field">
          <label class="rx-check"><input type="checkbox" bind:checked={o.date} data-testid="export-date" />{t('Show the date ("As of …")')}</label>
          {#if hasLogo}<label class="rx-check"><input type="checkbox" bind:checked={o.logo} />{t('Team logo')}</label>{/if}
          {#if o.view === 'roadmap'}
            <label class="rx-check"><input type="checkbox" bind:checked={o.includeEmpty} />{t('Stages without public issues too')}</label>
            <label class="rx-check"><input type="checkbox" bind:checked={o.showGoals} data-testid="export-goals" /><span>{t('Goals of the projects')}<span class="sub">{t('Internal text: check that it may be shown.')}</span></span></label>
          {/if}
        </div>
        <div class="rx-field">
          <span class="rx-label">{t('Projects')}</span>
          {#each projects as p (p._id)}
            <label class="rx-check"><input type="checkbox" checked={!o.skip.includes(p._id)} onchange={() => toggleProject(p._id)} data-testid="export-project" />{p.name}</label>
          {/each}
        </div>
      </div>
      <div class="rx-preview" data-testid="export-preview">
        {#if url && !nothing}<img src={url} alt={t('Preview of the picture')} data-testid="export-image" />{/if}
        {#if nothing}
          <div class="empty"><div class="empty-text">{t('No public issues yet. Mark issues as public on the issue (Roadmap section) or with the command “Public on the roadmap”.')}</div></div>
        {:else if busy}<span class="rx-status">{t('Drawing …')}</span>{/if}
        {#if error}<span class="rx-status" role="alert">{error}</span>{/if}
      </div>
    </div>
    <footer class="rx-foot">
      <span class={['rx-note', file && file.blob.size > SIZE_LIMIT && 'warn']} data-testid="export-info">
        {#if file && !nothing}
          {o.view === 'roadmap' ? tn(cards, '{count} public issue', '{count} public issues') : tn(rows, '{count} row', '{count} rows')} · {file.width} × {file.height} px · {t('{size} MB', { size: mb(file.blob.size) })}{#if file.scale < 1} · {t('scaled down to stay under 8 MB')}{/if}{#if file.blob.size > SIZE_LIMIT} · {t('over 8 MB: choose fewer projects')}{/if}{#if file.cut} · {t('too long, cut at the bottom')}{/if}
        {/if}
      </span>
      <button class="btn" disabled={!file || busy || nothing} data-testid="export-copy" onclick={() => void copy()}><span class="icon">{@html ICON.copy}</span>{t('Copy')}</button>
      <button class="btn primary" disabled={!file || busy || nothing} data-testid="export-download" onclick={download}><span class="icon">{@html ICON.import}</span>{t('Download PNG')}</button>
    </footer>
  </div>
</div>
