<script lang="ts">
  // One model with what the chip offers: effort values, speeds, context window (info only).
  import { contextLabel, type ModelInfo } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { speedsOf } from '@selfbound/backend/shared/models';

  let { model, showProvider = false, on }: { model: ModelInfo; showProvider?: boolean; on: (model: ModelInfo, enabled: boolean) => void } = $props();
  const details = $derived(
    [
      showProvider ? model.providerName : null,
      model.releaseDate ?? null,
      contextLabel(model),
      model.efforts.length ? t('Effort: {values}', { values: model.efforts.join(', ') }) : t('No effort setting'),
      model.modes.length ? t('Speed: {values}', { values: speedsOf(model).join(', ') }) : null,
    ].filter(Boolean),
  );
</script>

<div class="card-row" data-testid="model-row" data-model="{model.provider}/{model.modelId}">
  <span class="t"
    >{model.name}
    <div class="sub">{details.join(' · ')}{#if model.removed}<span class="warn-text"> · {t('No longer in the catalog')}</span>{/if}</div></span
  >
  <button class={['toggle small', model.enabled && 'on']} role="switch" aria-checked={!!model.enabled} aria-label={t('Use {name}', { name: model.name })} data-testid="model-toggle" onclick={() => on(model, !model.enabled)}></button>
</div>

<style>
  .warn-text {
    color: var(--warning-text);
  }
</style>
