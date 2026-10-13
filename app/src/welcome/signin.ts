// Embedded Clerk sign-in form instead of redirecting to Clerk's own sign-in page (accounts.…).
// Since version 6 clerk-js ships no UI; that comes from @clerk/ui (with React). Only this page
// loads either, and only when needed, never the app.

import { markSignedIn } from './session.ts';

type Theme = 'dark' | 'light';

interface ClerkLike {
  load(opts?: Record<string, unknown>): Promise<void>;
  readonly user: unknown;
  addListener(cb: (state: { user?: unknown }) => void): () => void;
  mountSignIn(el: HTMLElement, props?: Record<string, unknown>): void;
  unmountSignIn(el: HTMLElement): void;
}

/** Colors as in welcome.css (oklch, accent hue 276), as fixed values for Clerk. */
const VARIABLES: Record<Theme, Record<string, string>> = {
  dark: {
    colorPrimary: '#5f69d2',
    colorPrimaryForeground: '#ffffff',
    colorBackground: '#0e0f12',
    colorForeground: '#e3e4e8',
    colorMutedForeground: '#a3a4ab',
    colorMuted: '#18191e',
    colorInput: '#18191e',
    colorInputForeground: '#e3e4e8',
    colorBorder: 'rgba(255, 255, 255, 0.12)',
    colorNeutral: '#ffffff',
    colorRing: '#9eabf7',
    colorDanger: '#eb5757',
    colorShadow: 'rgba(0, 0, 0, 0.6)',
    colorModalBackdrop: 'rgba(0, 0, 0, 0.6)',
  },
  light: {
    colorPrimary: '#5f69d2',
    colorPrimaryForeground: '#ffffff',
    colorBackground: '#fdfdff',
    colorForeground: '#202127',
    colorMutedForeground: '#53555d',
    colorMuted: '#eeeff2',
    colorInput: '#ffffff',
    colorInputForeground: '#202127',
    colorBorder: 'rgba(0, 0, 0, 0.12)',
    colorNeutral: '#000000',
    colorRing: '#4e55bc',
    colorDanger: '#d93f3f',
    colorShadow: 'rgba(40, 44, 90, 0.18)',
    colorModalBackdrop: 'rgba(0, 0, 0, 0.4)',
  },
};

export function appearance(theme: Theme) {
  return {
    variables: {
      ...VARIABLES[theme],
      fontFamily: "'Inter Variable', Inter, ui-sans-serif, system-ui, sans-serif",
      fontFamilyButtons: "'Inter Variable', Inter, ui-sans-serif, system-ui, sans-serif",
      borderRadius: '9px',
      fontSize: '15px',
    },
    elements: {
      rootBox: { width: '100%' },
      cardBox: { width: '100%', maxWidth: '420px', boxShadow: theme === 'dark' ? '0 30px 80px -20px rgba(0,0,0,0.7)' : '0 30px 80px -24px rgba(40,44,90,0.35)', border: `1px solid ${VARIABLES[theme].colorBorder}` },
      // No sign-up: only the owner can sign in.
      footerAction: { display: 'none' },
    },
  };
}

export interface SignInOptions {
  publishableKey: string;
  /** Target after sign-in (already checked, see safeRedirect) */
  redirect: string;
  theme: () => Theme;
}

/** Preloads Clerk (when hovering "Sign in") so the form is ready sooner on click. */
let loading: Promise<[unknown, unknown]> | null = null;
export function preloadClerk() {
  loading ??= Promise.all([import('@clerk/clerk-js/no-rhc'), import('@clerk/ui')]);
  return loading;
}

export async function mountSignIn(el: HTMLElement, opts: SignInOptions) {
  const [{ Clerk }, { ui }] = (await preloadClerk()) as [{ Clerk: new (key: string) => unknown }, { ui: unknown }];
  const clerk = new Clerk(opts.publishableKey) as ClerkLike;
  // Clerk redirects (after sign-in, after SSO) pass through here: set the marker cookie first, then
  // navigate, otherwise Vercel serves the start page again under `/`.
  const go = (replace: boolean) => (to: string) => {
    markSignedIn(!!clerk.user);
    if (replace) location.replace(to);
    else location.assign(to);
  };
  await clerk.load({ ui, routerPush: go(false), routerReplace: go(true), signInUrl: '/sign-in', signInForceRedirectUrl: opts.redirect });
  clerk.addListener(({ user }) => markSignedIn(!!user));
  if (clerk.user) {
    markSignedIn(true);
    location.replace(opts.redirect);
    return;
  }
  const mount = () =>
    clerk.mountSignIn(el, {
      routing: 'hash',
      forceRedirectUrl: opts.redirect,
      withSignUp: false,
      appearance: appearance(opts.theme()),
    });
  mount();
  return {
    /** Color scheme changed: remount the form with the new colors */
    retheme() {
      clerk.unmountSignIn(el);
      mount();
    },
  };
}
