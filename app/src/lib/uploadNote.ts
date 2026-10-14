// Alt text of image placeholders while uploading (`![…](#upload-<id>)`, see upload.ts), shared by
// the editor (editor/views.ts) and the renderer (markdownRender.ts). The alt text is stored in the
// Markdown, so it is written in the language of whoever inserted the image.
import { t } from '@selfbound/core/i18n';

export const uploadingAlt = (name: string) => t('Uploading {name} …', { name });
export const failedAlt = (name: string) => t('Upload failed: {name}', { name });

/** Text and state of a placeholder note. Failed in English or in the active language. */
export function uploadNote(alt: string): { text: string; failed: boolean } {
  const failed = alt.startsWith('Upload failed:') || alt.startsWith(failedAlt(''));
  return { text: alt || t('Uploading image …'), failed };
}
