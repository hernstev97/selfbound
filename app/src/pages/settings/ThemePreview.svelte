<script lang="ts">
  // Small theme preview: sidebar, list, buttons, warning, error and code in the theme's colors. The
  // variables apply only inside this element; without `vars`, the XLR8 colors of the mode.
  import { t, tc } from '@xlr8/core/i18n';
  import { previewStyle, xlr8PreviewStyle } from '../../lib/look/map.ts';

  let { mode, vars, testid }: { mode: 'dark' | 'light'; vars: Record<string, string> | null; testid?: string } = $props();
</script>

<div class="tp" data-theme={mode} style={vars ? previewStyle(vars) : xlr8PreviewStyle(mode)} data-testid={testid} aria-hidden="true">
  <div class="tp-side">
    <div class="tp-nav on">{t('Inbox')}</div>
    <div class="tp-nav">{t('My issues')}</div>
    <div class="tp-nav">{t('Sprint')}</div>
  </div>
  <div class="tp-main">
    <div class="tp-row"><span class="tp-id">XLR8-37</span><span class="tp-title">{t('Pick a theme')}</span><span class="tp-pill warn">{t('Due tomorrow')}</span></div>
    <div class="tp-row sel"><span class="tp-id">XLR8-38</span><span class="tp-title">{t('Font for code')}</span><span class="tp-pill bad">{t('Overdue')}</span></div>
    <div class="tp-row hover"><span class="tp-id">XLR8-39</span><span class="tp-title">{t('Check contrast')}</span><span class="tp-link">{t('Link')}</span></div>
    <div class="tp-tools">
      <span class="tp-btn primary">{t('Save')}</span><span class="tp-btn">{t('Cancel')}</span><span class="tp-hint">{t('Placeholder')}</span>
    </div>
    <pre class="tp-code"><span class="k">const</span> <span class="v">theme</span> = <span class="f">pick</span>(<span class="s">'mocha'</span>, <span class="n">42</span>); <span class="c">// {tc('code', 'Comment')}</span></pre>
  </div>
</div>
