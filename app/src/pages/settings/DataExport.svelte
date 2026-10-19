<script lang="ts">
  // Data export (SELF-46): everything as one ZIP with JSON (complete) and Markdown (readable). The
  // export core (core/src/export) loads only on click; tooling/export builds the same ZIP from a
  // `convex export` snapshot for automation.
  import { ICON } from '@selfbound/core';
  import { intlLocale, t, tn } from '@selfbound/core/i18n';
  import type { ExportProgress } from '@selfbound/core/export/index';
  import { app } from '../../app-instance.ts';

  type Done = { bytes: number; issues: number; pages: number; files: number; missing: number };
  let running = $state(false);
  let step = $state('');
  let done = $state<Done | null>(null);

  const num = (n: number) => n.toLocaleString(intlLocale());
  const mb = (bytes: number) => (bytes / 1_048_576).toLocaleString(intlLocale(), { maximumFractionDigits: 1 });

  let rows = 0;
  let tableRows = 0;
  let table = '';
  function progress(p: ExportProgress) {
    if (p.phase === 'tables') {
      if (p.table !== table) {
        rows += tableRows;
        table = p.table;
      }
      tableRows = p.rows;
      step = t('Reading data … {count} rows', { count: num(rows + tableRows) });
    } else if (p.phase === 'files') step = t('Loading files … {done} of {total}', { done: num(p.done), total: num(p.total) });
    else step = t('Packing the ZIP …');
  }

  async function run() {
    if (running) return;
    running = true;
    done = null;
    rows = tableRows = 0;
    table = '';
    step = t('Reading data …');
    try {
      const { buildExport, exportFileName, readTables, urlFileReader } = await import('@selfbound/core/export/index');
      const client = app.store.client;
      const tables = await readTables(client, progress);
      const exportedAt = Date.now();
      const result = await buildExport(tables, { exportedAt, source: 'app', readFiles: urlFileReader(client), onProgress: progress });
      const url = URL.createObjectURL(new Blob(result.parts as BlobPart[], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFileName(exportedAt);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      done = {
        bytes: result.bytes,
        issues: tables.issues.filter((i) => !i.deletedAt).length,
        pages: tables.articles.filter((a) => !a.deletedAt).length,
        files: result.files,
        missing: result.missingFiles.length,
      };
    } catch (error) {
      app.toasts.error(t('Export failed'), error);
    } finally {
      running = false;
      step = '';
    }
  }
</script>

<h1 class="page-title">{t('Data export')}</h1>
<p class="page-lead">{t('Download everything in this instance as one ZIP file: a complete JSON copy that a later version can import again, and readable Markdown with one file per issue and per knowledge page.')}</p>

<div class="card-list" data-testid="data-export">
  <div class="card-row">
    <span class="t"
      >{t('Export all data')}
      <div class="sub">{t('Teams, issues with descriptions, comments and history, projects, sprints, labels, recurring issues, knowledge pages, images and logos, including the trash. Not included: agent keys, connections and push devices.')}</div>
    </span>
    <button class="btn primary small" data-testid="data-export-run" disabled={running} onclick={() => void run()}><span class="icon">{@html ICON.import}</span>{running ? t('Exporting …') : t('Export')}</button>
  </div>
  {#if running}
    <div class="card-row muted" data-testid="data-export-progress" aria-live="polite">{step}</div>
  {:else if done}
    <div class="card-row" data-testid="data-export-done" aria-live="polite">
      <span class="t"
        >{t('Downloaded: {size} MB. Issues: {issues}, pages: {pages}, files: {files}.', { size: mb(done.bytes), issues: num(done.issues), pages: num(done.pages), files: num(done.files) })}
        {#if done.missing}<div class="sub">{tn(done.missing, '{count} file could not be loaded; the export lists it in json/manifest.json.', '{count} files could not be loaded; the export lists them in json/manifest.json.')}</div>{/if}
      </span>
    </div>
  {/if}
</div>

<h2 class="section-title">{t('Automatic export')}</h2>
<div class="card-list">
  <div class="card-row">
    <span class="t"
      >{t('Script')}
      <div class="sub">{t('The same ZIP can be built from a Convex export, for example from the nightly backup:')} <code>node tooling/export/index.mjs --from &lt;convex-export.zip&gt;</code>. {t('Details are in docs/backup.md.')}</div>
    </span>
  </div>
</div>
