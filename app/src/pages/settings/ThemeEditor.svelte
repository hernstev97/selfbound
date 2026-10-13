<script lang="ts">
  // Paste or upload a custom VS Code theme. JSON with comments and trailing commas is allowed (as in
  // VS Code). While typing: an error, or a preview with contrast notes.
  import { api } from '@xlr8/backend/api';
  import { t } from '@xlr8/core/i18n';
  import type { Id } from '@xlr8/backend/dataModel';
  import { untrack } from 'svelte';
  import { app } from '../../app-instance.ts';
  import { look } from '../../lib/look/index.ts';
  import { mapTheme, varLabel, type MappedTheme } from '../../lib/look/map.ts';
  import { compactSource, readTheme, ThemeError, type VsTheme } from '../../lib/look/vscode.ts';
  import ThemePreview from './ThemePreview.svelte';

  let { id, close }: { id?: string; close: () => void } = $props();

  /** Largest file to upload; the cleaned-up JSON may be at most 300 kB on the server. */
  const MAX_FILE = 2_000_000;

  let text = $state('');
  let name = $state('');
  let nameTouched = $state(false);
  let error = $state<string | null>(null);
  let theme = $state<VsTheme | null>(null);
  let mapped = $state<MappedTheme | null>(null);
  let busy = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Edit: load the saved JSON once (the editor is created anew per theme).
  const editId = untrack(() => id);
  if (editId) {
    void look.theme(`custom:${editId}`).then((saved) => {
      if (!saved) return;
      text = JSON.stringify({ name: saved.name, type: saved.type, colors: saved.colors, tokenColors: saved.tokenColors }, null, 2);
      name = saved.name;
      nameTouched = true;
      parse();
    });
  }

  function parse() {
    if (!text.trim()) {
      error = null;
      theme = null;
      mapped = null;
      return;
    }
    try {
      const read = readTheme(text);
      theme = read;
      mapped = mapTheme(read);
      error = null;
      if (!nameTouched) name = read.name;
    } catch (e) {
      error = e instanceof ThemeError || e instanceof Error ? e.message : String(e);
      theme = null;
      mapped = null;
    }
  }

  function onInput() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(parse, 150);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE) {
      error = t('The file is too large.');
      return;
    }
    text = await file.text();
    parse();
  }

  async function save(use: boolean) {
    if (!theme || busy) return;
    busy = true;
    try {
      const result = await app.store.call(api.appearance.saveTheme, { id: id as Id<'customThemes'> | undefined, name: name.trim() || theme.name, type: theme.type, source: compactSource(theme) });
      if (use) look.set({ [theme.type]: `custom:${result.id}` });
      app.toasts.show(id ? t('Theme saved') : t('Theme added'));
      close();
    } catch (e) {
      app.toasts.error(t('Theme not saved'), e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="theme-editor" data-testid="theme-editor">
  <div class="theme-editor-fields">
    <label class="theme-editor-label" for="theme-json">{t('VS Code theme (JSON)')}</label>
    <textarea
      id="theme-json"
      class="input mono theme-json"
      rows="10"
      spellcheck="false"
      placeholder={'{\n  "name": "' + t('My theme') + '",\n  "type": "dark",\n  "colors": { "editor.background": "#1e1e2e", … },\n  "tokenColors": [ … ]\n}'}
      data-testid="theme-json"
      bind:value={text}
      oninput={onInput}
    ></textarea>
    <div class="theme-editor-row">
      <label class="btn small file-btn">
        {t('Choose file…')}
        <input class="visually-hidden" type="file" accept=".json,.jsonc,application/json" data-testid="theme-file" onchange={(e) => void onFile(e.currentTarget.files?.[0])} />
      </label>
      <span class="sub">{t('In a theme package, the JSON is usually under')} <code>themes/</code>. {t('From VS Code: "Developer: Generate Color Theme From Current Settings".')}</span>
    </div>
    {#if error}<p class="field-error" role="alert" data-testid="theme-error">{error}</p>{/if}
    <label class="theme-editor-label" for="theme-name">{t('Name')}</label>
    <input id="theme-name" class="input" maxlength="80" data-testid="theme-name" bind:value={name} oninput={() => (nameTouched = true)} />
  </div>
  {#if theme && mapped}
    <div class="theme-editor-preview">
      <span class="sub">{theme.type === 'dark' ? t('Dark theme') : t('Light theme')} · {t('{colors} colors, {rules} syntax rules', { colors: Object.keys(theme.colors).length, rules: theme.tokenColors.length })}</span>
      <ThemePreview mode={theme.type} vars={mapped.vars} testid="theme-editor-preview" />
      {#if mapped.fixes.length}
        <p class="theme-note" data-testid="theme-editor-fixes">{t('Adjusted for readability: {names}.', { names: mapped.fixes.map((f) => varLabel(f.name)).join(', ') })}</p>
      {/if}
    </div>
  {/if}
  <div class="theme-editor-foot">
    <button class="btn small" onclick={close}>{t('Cancel')}</button>
    <button class="btn small" disabled={!theme || busy} data-testid="theme-save" onclick={() => void save(false)}>{t('Save')}</button>
    <button class="btn small primary" disabled={!theme || busy} data-testid="theme-save-use" onclick={() => void save(true)}>{t('Save and use')}</button>
  </div>
</div>
