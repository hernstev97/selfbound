// Image upload (loaded with the first image, see imageInput.ts).
//
// Per file: placeholder `![Uploading name …](#upload-<id>)` at the cursor → check in the browser and
// shrink if needed (WebP) → upload URL → POST → files.register (the server checks type and size) →
// replace the placeholder with `![name](<url>)`. On error the placeholder becomes "Upload failed"
// and a sticky toast offers a retry.
import { api } from '@selfbound/backend/api';
import type { Id } from '@selfbound/backend/dataModel';
import { IMAGE_TYPES, LIMITS, OWNER_KIND } from '@selfbound/backend/constants';
import type { IssueId } from '@selfbound/core';
import { intlLocale, t } from '@selfbound/core/i18n';
import { app } from '../app-instance.ts';
import { imageMarkdown, type ImageField, type ImageRef, type UploadTarget } from './imageInput.ts';
import { failedAlt, uploadingAlt } from './uploadNote.ts';

/** Longest edge after shrinking. Enough for screenshots of 4K screens at half size. */
const MAX_EDGE = 2560;
/** Above this size the image is re-encoded (WebP), even without shrinking. */
const RECODE_ABOVE = 300 * 1024;
const WEBP_QUALITY = 0.86;

interface Job {
  id: string;
  file: File;
  name: string;
  field: ImageField;
  target: UploadTarget;
}

let seq = 0;
const nextId = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** File name without extension and without characters that break the Markdown. */
function altText(file: File) {
  const base = file.name.replace(/\.[a-z0-9]{2,5}$/i, '');
  const clean = base.replace(/[[\]()\\!\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean && !/^image$/i.test(clean) ? clean : t('Image');
}

const uploading = (job: Job): ImageRef => ({ alt: uploadingAlt(job.name), src: `#upload-${job.id}` });
const failed = (job: Job): ImageRef => ({ alt: failedAlt(job.name), src: `#upload-${job.id}` });
/** Finds a job's placeholder, even if someone edited the text in the brackets. */
const placeholderRe = (job: Job) => new RegExp(`!\\[[^\\]\\n]*\\]\\(#upload-${job.id}\\)`);

/** Inserts images at the cursor and uploads them. */
export function insertImages(field: ImageField, files: File[], target: UploadTarget) {
  const jobs = files.map((file) => ({ id: nextId(), file, name: altText(file), field, target }));
  if (!jobs.length) return;
  field.insertImages(jobs.map(uploading));
  for (const job of jobs) void run(job);
}

async function run(job: Job) {
  try {
    const blob = await prepareImage(job.file);
    const uploadUrl = await app.store.call(api.files.generateUploadUrl, {});
    const response = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
    if (!response.ok) throw new Error(t('Upload failed ({status}).', { status: response.status }));
    const { storageId } = (await response.json()) as { storageId: Id<'_storage'> };
    const { url } = await app.store.act(api.files.register, { storageId });
    replace(job, { alt: job.name, src: url });
  } catch (error) {
    replace(job, failed(job));
    app.toasts.error(t('Image "{name}" not uploaded', { name: job.name }), error, () => {
      replace(job, uploading(job));
      void run(job);
    });
  }
}

/**
 * Checks type and size and shrinks large images in the browser: longest edge at most 2560 px, as
 * WebP. JPEGs are always re-encoded so camera metadata (location, device) does not travel along.
 * GIFs stay unchanged (animation).
 */
async function prepareImage(file: File): Promise<Blob> {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
    throw new Error(t('Images only: PNG, JPEG, WebP or GIF.'));
  }
  const tooLarge = () => new Error(t('The image is too large (at most {mb} MB).', { mb: (LIMITS.imageMaxBytes / 1024 / 1024).toLocaleString(intlLocale()) }));
  if (file.type === 'image/gif') {
    if (file.size > LIMITS.imageMaxBytes) throw tooLarge();
    return file;
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(t('The image cannot be read (damaged or not an image).'));
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const recode = file.type === 'image/jpeg' || file.size > RECODE_ABOVE || scale < 1;
  if (!recode) {
    bitmap.close();
    return file;
  }
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY));
  // Without a WebP encoder (older Safari) PNG comes back: keep the original then.
  const webp = blob?.type === 'image/webp' ? blob : null;
  // Shrunk, JPEG (metadata removed) or simply smaller: use the new version.
  const result = webp && (scale < 1 || file.type === 'image/jpeg' || webp.size < file.size) ? webp : file;
  if (result.size > LIMITS.imageMaxBytes) throw tooLarge();
  return result;
}

/** Replace the placeholder: in the open field, otherwise wherever the text lives by now. */
function replace(job: Job, next: ImageRef) {
  if (job.field.connected && job.field.replaceImage(job.id, next)) return;
  void replaceElsewhere(job, imageMarkdown(next));
}

async function replaceElsewhere(job: Job, next: string) {
  const re = placeholderRe(job);
  const swap = (text: string) => text.replace(re, () => next);
  if ('create' in job.target) {
    const draft = app.create.state.get().draft;
    if (re.test(draft.description)) app.create.update({ description: swap(draft.description) });
    return;
  }
  if ('articleId' in job.target) return await replaceInArticle(job.target.articleId, re, swap);
  const id = job.target.issueId as IssueId;
  // Description in the editor (a different field after preview/redraw).
  const desc = app.detail.desc.get();
  if (desc.editing && re.test(desc.text)) {
    app.detail.input(swap(desc.text));
    return;
  }
  // Unsent comment.
  const draft = app.detail.commentDraft(id);
  if (re.test(draft)) app.detail.setCommentDraft(id, swap(draft));
  // Locally kept description that is not saved yet.
  try {
    const key = `xlr8:desc:${id}`;
    const local = JSON.parse(localStorage.getItem(key) ?? 'null') as { text: string; base: number } | null;
    if (local && re.test(local.text)) localStorage.setItem(key, JSON.stringify({ ...local, text: swap(local.text) }));
  } catch {
    // ignore
  }
  // Already saved: description or own comment.
  const doc = app.store.detail(id);
  if (!doc) return;
  try {
    if (re.test(doc.body.markdown)) await app.store.setDescription(id, swap(doc.body.markdown), doc.body.version);
    for (const c of doc.comments) {
      if (c.author.kind === OWNER_KIND && re.test(c.body)) await app.store.editComment(id, c._id, swap(c.body));
    }
  } catch (error) {
    app.toasts.error(t('Image not added to the text'), error);
  }
}

/** Wiki page: open editor, local draft, otherwise the saved text of the page. */
async function replaceInArticle(id: string, re: RegExp, swap: (text: string) => string) {
  const wiki = app.wikiLoaded();
  const editing = wiki?.editingText(id);
  if (wiki && editing != null && re.test(editing)) {
    wiki.input(swap(editing));
    return;
  }
  try {
    const key = `xlr8:article:${id}`;
    const local = JSON.parse(localStorage.getItem(key) ?? 'null') as { text: string; base: number } | null;
    if (local && re.test(local.text)) localStorage.setItem(key, JSON.stringify({ ...local, text: swap(local.text) }));
  } catch {
    // ignore
  }
  // Already saved (even if the page is no longer open): read the saved text, replace the
  // placeholder, save with the version; on a conflict read again and retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await articleOnce(id);
    if (!doc || !re.test(doc.body.markdown)) return;
    try {
      await app.store.call(api.wiki.setBody, { id: id as never, markdown: swap(doc.body.markdown), baseVersion: doc.body.version });
      return;
    } catch (error) {
      if ((error as { data?: { code?: string } }).data?.code !== 'conflict' || attempt === 2) {
        app.toasts.error(t('Image not added to the page'), error);
        return;
      }
    }
  }
}

/** Current state of a page (read once through a short subscription). */
function articleOnce(id: string) {
  const { slice, release } = app.store.watch(api.wiki.get, { id });
  return new Promise<ReturnType<typeof slice.get>>((resolve) => {
    const done = () => {
      const value = slice.get();
      if (value === undefined) return false;
      stop();
      release();
      resolve(value);
      return true;
    };
    const stop = slice.subscribe(done);
    done();
  });
}
