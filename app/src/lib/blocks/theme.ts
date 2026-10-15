// Notifies when the app's theme changes (light/dark switch, another theme chosen). The theme is a
// set of CSS variables: `data-theme` on <html> for light/dark, and the "selfbound-look" style
// element for the chosen colors (lib/look/index.ts).

/** Calls `cb` (debounced to one frame) on every theme change; returns the unsubscribe function. */
export function onThemeChange(cb: () => void): () => void {
  let frame = 0;
  const fire = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(cb);
  };
  const root = new MutationObserver(fire);
  root.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const style = document.getElementById('selfbound-look');
  const look = new MutationObserver(fire);
  if (style) look.observe(style, { childList: true, characterData: true, subtree: true });
  return () => {
    cancelAnimationFrame(frame);
    root.disconnect();
    look.disconnect();
  };
}
