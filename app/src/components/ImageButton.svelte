<script lang="ts">
  // "Insert image" button next to a text field. Opens the file picker; on a phone the system
  // also offers photos and the camera there.
  import { t } from '@xlr8/core/i18n';
  import { pickImages, type ImageField, type UploadTarget } from '../lib/imageInput.ts';

  let { field, target }: { field: () => ImageField | null | undefined; target: UploadTarget } = $props();
</script>

<button
  type="button"
  class="btn ghost small image-btn"
  data-testid="image-button"
  title={t('Insert image (or Ctrl V, drop a file)')}
  aria-label={t('Insert image')}
  onmousedown={(e) => e.preventDefault()}
  onclick={() => pickImages(field(), target)}
>
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
    ><path
      fill="currentColor"
      d="M3.5 2A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 12.5 2h-9Zm0 1.25h9c.14 0 .25.11.25.25v6.19l-2.2-2.2a.75.75 0 0 0-1.06 0L6 10.94 4.8 9.75a.75.75 0 0 0-1.05 0l-.5.5V3.5c0-.14.11-.25.25-.25ZM5.75 4.5a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"
    /></svg
  >{t('Image')}
</button>
