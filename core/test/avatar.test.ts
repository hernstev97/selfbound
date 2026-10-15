import { describe, expect, test } from 'vitest';
import { AVATAR_ZOOM_MAX, clampCrop, cropRect, zoomCrop, type CropState } from '../src/avatar.ts';

// Cropping the profile picture: which square of the image the circular viewport shows.

const wide: CropState = { view: 200, width: 1000, height: 500, zoom: 1, x: 0, y: 0 };

describe('avatar crop', () => {
  test('centered, zoom 1: the shortest side fits the viewport', () => {
    expect(cropRect(wide)).toEqual({ sx: 250, sy: 0, side: 500 });
    expect(cropRect({ ...wide, width: 400, height: 800 })).toEqual({ sx: 0, sy: 200, side: 400 });
  });

  test('zoom shrinks the region around the center', () => {
    expect(cropRect({ ...wide, zoom: 2 })).toEqual({ sx: 375, sy: 125, side: 250 });
  });

  test('moving the image moves the region the other way and stays inside the image', () => {
    // Dragging the image right by 50 viewport px shows 125 image px further left (scale 0.4)
    expect(cropRect({ ...wide, x: 50 })).toEqual({ sx: 125, sy: 0, side: 500 });
    // Far beyond the edge: clamped to the image border
    const far = cropRect({ ...wide, x: 9999, y: 9999 });
    expect(far.sx).toBe(0);
    expect(far.sy).toBe(0);
    const farOther = cropRect({ ...wide, x: -9999, y: -9999 });
    expect(farOther.sx).toBe(500);
    expect(farOther.sx + farOther.side).toBe(1000);
  });

  test('zoom is limited, and zooming back out re-centers an image that no longer has room to move', () => {
    expect(clampCrop({ ...wide, zoom: 99 }).zoom).toBe(AVATAR_ZOOM_MAX);
    expect(clampCrop({ ...wide, zoom: 0.1 }).zoom).toBe(1);
    const zoomedIn = zoomCrop({ ...wide, x: 80 }, 3);
    expect(zoomedIn.zoom).toBe(3);
    const out = zoomCrop({ ...zoomedIn, x: 300, y: 0 }, 1);
    // Square image at zoom 1: no room left in y; in x the wide image still has some
    expect(out.y).toBe(0);
    expect(Math.abs(out.x)).toBeLessThanOrEqual((1000 * 0.4 - 200) / 2);
  });

  test('a square image cannot move at zoom 1', () => {
    const square: CropState = { view: 200, width: 300, height: 300, zoom: 1, x: 40, y: -40 };
    expect(clampCrop(square)).toMatchObject({ x: 0, y: 0 });
  });
});
