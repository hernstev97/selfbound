<script lang="ts">
  // Triage: the keys that decide an issue, shown at the bottom of the list like the keys in sprint planning.
  import { t } from '@selfbound/core/i18n';
</script>

<div class="key-row desktop-only" data-testid="triage-keys">
  <span><span class="kbd">1</span>{t('accept')}</span>
  <span><span class="kbd">2</span>{t('duplicate')}</span>
  <span><span class="kbd">3</span>{t('decline')}</span>
  <span><span class="kbd">H</span>{t('snooze')}</span>
</div>
