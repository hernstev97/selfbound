<script lang="ts">
  // About: license and source code of this instance (AGPL-3.0 § 13: everyone using it over the network
  // can get the source; forks set their own link, instance field sourceUrl) and the third-party
  // licenses, generated at build time into a static file (vite.notices.ts).
  import { ICON } from '@selfbound/core';
  import { t, tc } from '@selfbound/core/i18n';

  const source = typeof __SELFBOUND_SOURCE_URL__ === 'string' ? __SELFBOUND_SOURCE_URL__ : '';
  const build = typeof __SELFBOUND_BUILD__ === 'string' ? __SELFBOUND_BUILD__ : 'dev';
</script>

<h1 class="page-title">{t('About')}</h1>
<p class="page-lead">{t('Selfbound is free software: you may use, study, share and change it under the GNU Affero General Public License v3.0.')}</p>

<div class="card-list" data-testid="about">
  <div class="card-row">
    <span class="t">{t('License')}<div class="sub">GNU Affero General Public License v3.0 (AGPL-3.0)</div></span>
    <a class="btn small" href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer"><span class="icon">{@html ICON.open}</span>{t('Read')}</a>
  </div>
  <div class="card-row">
    <span class="t">{t('Source code')}<div class="sub">{t('Everyone who uses this instance can get its source code here. If you run a changed version, the link points to your changes (instance setting sourceUrl).')}<br /><span class="mono" data-testid="about-source-url">{source}</span></div></span>
    <a class="btn small" href={source} target="_blank" rel="noopener noreferrer" data-testid="about-source"><span class="icon">{@html ICON.open}</span>{tc('verb', 'Open')}</a>
  </div>
  <div class="card-row">
    <span class="t">{t('Third-party licenses')}<div class="sub">{t('Libraries, fonts, color themes and syntax grammars in this build, with their licenses.')}</div></span>
    <a class="btn small" href="/third-party-notices.txt" target="_blank" rel="noopener" data-testid="about-notices"><span class="icon">{@html ICON.open}</span>{tc('verb', 'Open')}</a>
  </div>
  <div class="card-row">
    <span class="t">{t('Version')}<div class="sub mono" data-testid="about-build">{build}</div></span>
  </div>
</div>
