// Images in text fields (description, comment, create dialog): Ctrl V with a screenshot, drag a
// file in, or a button. Only detection lives here; shrinking, uploading, placeholders and errors
// are in upload.ts, loaded with the first image (not in the start bundle).
// A field is the editor (editor/RichEditor.svelte) or, while it loads or as a fallback, a textarea
// (`textareaField`).
import { t } from '@xlr8/core/i18n';
import type { Attachment } from 'svelte/attachments';
import { app } from '../app-instance.ts';

/**
 * Where the text belongs. If the field is no longer open when the upload ends (editor closed,
 * navigated away, already sent), upload.ts replaces the placeholder there: in the issue's
 * description, drafts and own comments, in a wiki page's text, or in the create draft.
 */
export type UploadTarget = { issueId: string } | { articleId: string } | { create: true };

/** An image in the text: `![alt](src)`. Upload placeholders have `src` = `#upload-<id>`. */
export interface ImageRef {
  alt: string;
  src: string;
}

/** What upload.ts needs from an input field. */
export interface ImageField {
  /** Insert images at the cursor, each on its own line. */
  insertImages(images: ImageRef[]): void;
  /** Replace the image with `src` = `#upload-<id>`; false if it is not there (anymore). */
  replaceImage(id: string, next: ImageRef): boolean;
  /** Field still in the document? */
  readonly connected: boolean;
}

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((f) => f.type.startsWith('image/'));
}

/** Markdown of an image (alt text without characters that break the brackets). */
export const imageMarkdown = (image: ImageRef) => `![${image.alt.replace(/[[\]\\]/g, '\\$&')}](${image.src})`;

/** Loads upload.ts and inserts the images at the cursor. */
export function insertImages(field: ImageField, files: File[], target: UploadTarget) {
  if (!files.length) return;
  // If the upload code fails to load (offline, new version deployed), a toast says so.
  import('./upload.ts').then(
    (m) => m.insertImages(field, files, target),
    (error) => app.toasts.error(t('Image not inserted'), error),
  );
}

/** A textarea as image field: placeholders as Markdown lines at the cursor. */
export function textareaField(el: HTMLTextAreaElement): ImageField {
  return {
    insertImages(images) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const before = el.value.slice(0, start);
      const after = el.value.slice(end);
      const lead = before === '' || before.endsWith('\n') ? '' : '\n';
      const tail = after.startsWith('\n') ? '' : '\n';
      el.focus();
      el.setRangeText(lead + images.map(imageMarkdown).join('\n') + tail, start, end, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    replaceImage(id, next) {
      const m = new RegExp(`!\\[(?:[^\\]\\\\\\n]|\\\\.)*\\]\\(#upload-${id}\\)`).exec(el.value);
      if (!m) return false;
      el.setRangeText(imageMarkdown(next), m.index, m.index + m[0].length, 'preserve');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    get connected() {
      return el.isConnected;
    },
  };
}

/**
 * Svelte attachment for a textarea: paste and drop images. `field`: where the images go (default:
 * the textarea itself; TextEditor.svelte passes a field that forwards to the editor once it has
 * switched over).
 */
export function imageInput(target: UploadTarget, field?: ImageField): Attachment<HTMLTextAreaElement> {
  return (el) => {
    field ??= textareaField(el);
    const paste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      // Text wins (e.g. cells copied from a spreadsheet also carry an image).
      if (!data || data.getData('text/plain')) return;
      const files = imageFiles(data.files);
      if (!files.length) return;
      e.preventDefault();
      insertImages(field!, files, target);
    };
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('drop-target');
    };
    const leave = () => el.classList.remove('drop-target');
    const drop = (e: DragEvent) => {
      el.classList.remove('drop-target');
      const files = imageFiles(e.dataTransfer?.files);
      if (!files.length) return;
      e.preventDefault();
      el.focus();
      insertImages(field!, files, target);
    };
    el.addEventListener('paste', paste);
    el.addEventListener('dragover', over);
    el.addEventListener('dragleave', leave);
    el.addEventListener('drop', drop);
    return () => {
      el.removeEventListener('paste', paste);
      el.removeEventListener('dragover', over);
      el.removeEventListener('dragleave', leave);
      el.removeEventListener('drop', drop);
    };
  };
}

/** "Image" button: open the file picker and insert the images into the field. */
export function pickImages(field: ImageField | null | undefined, target: UploadTarget) {
  if (!field) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = IMAGE_ACCEPT;
  input.multiple = true;
  input.dataset.testid = 'image-file-input';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    insertImages(field, [...(input.files ?? [])], target);
    input.remove();
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.append(input);
  input.click();
}
