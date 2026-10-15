<script lang="ts">
  // Crop the profile picture: the image sits under a circular mask; drag to move, wheel or slider to
  // zoom, arrow keys and + / − from the keyboard. The canvas shows exactly the square that is saved
  // (256 × 256, WebP; re-encoding also drops camera metadata). The circle is only drawn on top.
  import { clampCrop, cropRect, zoomCrop, AVATAR_ZOOM_MAX, type CropState } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { LIMITS } from '@selfbound/backend/constants';
  import Dialog from './Dialog.svelte';

  let { bitmap, close, save }: { bitmap: ImageBitmap; close: () => void; save: (picture: Blob) => Promise<string | null> } = $props();

  const VIEW = 240;
  const STEP = 12;
  // The dialog is created per picture, so reading the bitmap once is enough.
  // svelte-ignore state_referenced_locally
  let crop = $state<CropState>({ view: VIEW, width: bitmap.width, height: bitmap.height, zoom: 1, x: 0, y: 0 });
  let canvas = $state<HTMLCanvasElement | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  function draw(target: HTMLCanvasElement, size: number) {
    target.width = size;
    target.height = size;
    const { sx, sy, side } = cropRect(crop);
    const ctx = target.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  }

  $effect(() => {
    if (!canvas) return;
    // Track the crop, then draw at the screen's pixel density.
    void [crop.zoom, crop.x, crop.y];
    draw(canvas, Math.round(VIEW * Math.min(2, window.devicePixelRatio || 1)));
  });

  let drag: { id: number; x: number; y: number } | null = null;
  function down(e: PointerEvent) {
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (!drag || drag.id !== e.pointerId) return;
    crop = clampCrop({ ...crop, x: crop.x + e.clientX - drag.x, y: crop.y + e.clientY - drag.y });
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }
  const up = () => (drag = null);
  function wheel(e: WheelEvent) {
    e.preventDefault();
    // Firefox reports mouse wheels in lines (3 per notch), others in pixels.
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    crop = zoomCrop(crop, crop.zoom * Math.exp(-delta / 400));
  }
  function keydown(e: KeyboardEvent) {
    const dir: Record<string, [number, number]> = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
    if (dir[e.key]) {
      // An arrow key moves the picture in that direction, like dragging it
      crop = clampCrop({ ...crop, x: crop.x + dir[e.key]![0], y: crop.y + dir[e.key]![1] });
    } else if (e.key === '+' || e.key === '=') crop = zoomCrop(crop, crop.zoom * 1.15);
    else if (e.key === '-' || e.key === '_') crop = zoomCrop(crop, crop.zoom / 1.15);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** WebP (about 10–30 KB); without a WebP encoder (Safari) PNG comes back, kept if small enough, else JPEG. */
  async function encode(): Promise<Blob | null> {
    const out = document.createElement('canvas');
    draw(out, LIMITS.avatarPx);
    const blob = (type: string, quality: number) => new Promise<Blob | null>((resolve) => out.toBlob(resolve, type, quality));
    const first = await blob('image/webp', 0.9);
    if (first && first.size <= LIMITS.avatarMaxBytes) return first;
    // JPEG has no transparency: paint a neutral background under the picture first.
    const g = out.getContext('2d')!;
    g.globalCompositeOperation = 'destination-over';
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, out.width, out.height);
    return (await blob('image/jpeg', 0.9)) ?? first;
  }

  async function submit() {
    busy = true;
    error = null;
    const picture = await encode();
    error = picture ? await save(picture) : t('The image cannot be read (damaged or not an image).');
    busy = false;
    if (!error) close();
  }
</script>

<Dialog title={t('Crop profile picture')} close={() => !busy && close()} testid="avatar-crop-dialog">
  <p class="dialog-text">{t('Drag the picture to move it and zoom to choose the part inside the circle.')}</p>
  <div class="stage">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="crop"
      role="application"
      tabindex="0"
      aria-label={t('Picture area. Arrow keys move the picture, plus and minus zoom.')}
      data-testid="avatar-crop"
      style:--view="{VIEW}px"
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
      onwheel={wheel}
      onkeydown={keydown}
    >
      <canvas bind:this={canvas}></canvas>
      <span class="mask"></span>
    </div>
  </div>
  <label class="zoom">
    <span>{t('Zoom')}</span>
    <input type="range" min="1" max={AVATAR_ZOOM_MAX} step="0.01" value={crop.zoom} aria-label={t('Zoom')} data-testid="avatar-zoom" oninput={(e) => (crop = zoomCrop(crop, Number(e.currentTarget.value)))} />
  </label>
  {#if error}<div class="field-error" role="alert" data-testid="avatar-error">{error}</div>{/if}
  <div class="dialog-foot">
    <button class="btn ghost" disabled={busy} onclick={close}>{t('Cancel')}</button>
    <button class="btn primary" data-testid="avatar-save" disabled={busy} onclick={() => void submit()}>{busy ? t('Saving …') : t('Save')}</button>
  </div>
</Dialog>

<style>
  .stage {
    display: grid;
    place-items: center;
    padding: 4px 0 12px;
  }
  .crop {
    position: relative;
    width: var(--view);
    height: var(--view);
    cursor: grab;
    touch-action: none;
    border-radius: var(--radius-md);
    overflow: hidden;
    outline: none;
    background: var(--bg-control);
  }
  .crop:active {
    cursor: grabbing;
  }
  .crop:focus-visible {
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  /* Everything outside the circle is dimmed. */
  .mask {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    box-shadow:
      0 0 0 999px rgb(0 0 0 / 0.55),
      inset 0 0 0 1px rgb(255 255 255 / 0.6);
    pointer-events: none;
  }
  .zoom {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 4px;
    color: var(--text-muted);
  }
  .zoom input {
    flex: 1;
  }
</style>
