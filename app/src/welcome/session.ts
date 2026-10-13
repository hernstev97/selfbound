// "Signed in" marker for the start page. Vercel serves `/` as the start page without this cookie
// and the app with it (deploy/web/vercel.json). No secret and no permission, only a hint for the
// routing; Clerk and Convex still check everything. Same name as in core/src/auth.ts
// (SIGNED_IN_COOKIE), a test keeps both in sync. Deliberately no shared import: the start page must
// not pull in anything from the app's start bundle.

export const SIGNED_IN_COOKIE = 'xlr8_signed_in';

export function markSignedIn(on: boolean) {
  const secure = location.protocol === 'https:' ? '; secure' : '';
  document.cookie = on ? `${SIGNED_IN_COOKIE}=1; path=/; max-age=31536000; samesite=lax${secure}` : `${SIGNED_IN_COOKIE}=; path=/; max-age=0; samesite=lax${secure}`;
}

/**
 * Target after sign-in from `?redirect_url=`: only same-origin paths, never back to sign-in itself.
 * Anything else leads into the app (`/`).
 */
export function safeRedirect(raw: string | null, origin: string): string {
  if (!raw) return '/';
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return '/';
    if (/^\/sign-in\/?$/.test(url.pathname) || url.pathname === '/welcome.html') return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}
