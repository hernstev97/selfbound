// Cropping the profile picture. The dialog shows a square viewport with a circular mask; the image
// is scaled to cover it (`zoom` 1 = shortest side fits) and can be moved and zoomed. These are the
// pure calculations; drawing and the file handling live in the app.

/** Largest zoom factor in the dialog. */
export const AVATAR_ZOOM_MAX = 4;

export interface CropState {
  /** Edge of the square viewport in px */
  view: number;
  /** Natural size of the image */
  width: number;
  height: number;
  /** 1 … AVATAR_ZOOM_MAX */
  zoom: number;
  /** Shift of the image center from the viewport center, in viewport px */
  x: number;
  y: number;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Scale of the image in viewport px per image px. */
export function cropScale(s: Pick<CropState, 'view' | 'width' | 'height' | 'zoom'>) {
  return (s.view / Math.min(s.width, s.height)) * clamp(s.zoom, 1, AVATAR_ZOOM_MAX);
}

/** Keeps the image covering the viewport: clamps zoom and shift. */
export function clampCrop(s: CropState): CropState {
  const zoom = clamp(s.zoom, 1, AVATAR_ZOOM_MAX);
  const scale = cropScale({ ...s, zoom });
  const limitX = Math.max(0, (s.width * scale - s.view) / 2);
  const limitY = Math.max(0, (s.height * scale - s.view) / 2);
  // + 0 turns -0 into 0
  return { ...s, zoom, x: clamp(s.x, -limitX, limitX) + 0, y: clamp(s.y, -limitY, limitY) + 0 };
}

/** The square region of the image (in image px) that the viewport shows. */
export function cropRect(s: CropState): { sx: number; sy: number; side: number } {
  const c = clampCrop(s);
  const scale = cropScale(c);
  const side = c.view / scale;
  return { sx: c.width / 2 - c.x / scale - side / 2, sy: c.height / 2 - c.y / scale - side / 2, side };
}

/** Zoom around the viewport center, keeping the shift in proportion. */
export function zoomCrop(s: CropState, zoom: number): CropState {
  const next = clamp(zoom, 1, AVATAR_ZOOM_MAX);
  const ratio = next / clamp(s.zoom, 1, AVATAR_ZOOM_MAX);
  return clampCrop({ ...s, zoom: next, x: s.x * ratio, y: s.y * ratio });
}
