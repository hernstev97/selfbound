// Sign-in in the client. Two ways:
//
// 1. Local: `VITE_DEV_TOKEN` (written by tooling/local.mjs). Only when set; the backend accepts
//    the issuer only locally (SELFBOUND_DEV_JWKS).
// 2. Production: Clerk (`VITE_CLERK_PUBLISHABLE_KEY`), token template "convex". Clerk is loaded
//    on demand and is not part of the start bundle.
//
// Signing in happens on the own sign-in page `/sign-in` (welcome.html, embedded Clerk form), which
// returns to the same address. The app itself only loads clerk-js without UI. Once signed in, the
// browser remembers it in the cookie SIGNED_IN_COOKIE; Vercel then picks between sign-in page and
// app under `/`.
//
// Offline: Clerk needs the network for `load()`. If the marker is set, the app shows the cache right
// away (status `cached`). Convex gets a token that only arrives with Clerk; until then the store holds
// back changes (App.#gateWrites), because after a lost connection Convex would send them without a
// token. Without the marker (never signed in) the status is `offline` with "Try again". Clerk is
// retried as soon as the browser reports being online again, else with a growing pause.

import type { ConvexClient } from 'convex/browser';
import { Slice } from './observable.ts';

/**
 * `denied`: signed in at Clerk, but the backend rejects the account (not in SELFBOUND_OWNER_IDS).
 * `cached`: signed in last time (marker), Clerk has not confirmed yet; the app shows the cache.
 * `offline`: not signed in and Clerk unreachable.
 */
export type AuthStatus = 'loading' | 'cached' | 'signed-in' | 'signed-out' | 'denied' | 'offline' | 'unconfigured';

/** Wait this long for Clerk, then sign-in counts as unreachable (notice); waiting continues. */
export const CLERK_TIMEOUT = 6000;
/** Clerk unreachable: retry after this pause, doubling each time up to RETRY_MAX (and right away when the browser reports being online). */
const RETRY_MS = 15_000;
const RETRY_MAX = 5 * 60_000;

export interface AuthConfig {
  devToken?: string;
  clerkPublishableKey?: string;
  /** Loads Clerk on demand (in the app: `() => import('@clerk/clerk-js')`), only for way 2 */
  loadClerk?: () => Promise<{ Clerk: new (key: string) => unknown }>;
}

/** What the UI needs from Clerk (deliberately narrow so the rest does not depend on Clerk). */
interface ClerkLike {
  load(opts?: Record<string, unknown>): Promise<void>;
  /** Address of the Clerk server (Frontend API), e.g. `clerk.selfbound.example.com` */
  readonly frontendApi?: string;
  readonly user: unknown;
  readonly session: { getToken(opts: { template: string; skipCache?: boolean }): Promise<string | null> } | null | undefined;
  addListener(cb: (state: { user?: unknown }) => void): () => void;
  signOut(opts?: Record<string, unknown>): Promise<void>;
}

/** "Signed in" marker for the switch under `/` (same name in app/src/welcome/session.ts). Not a secret. */
export const SIGNED_IN_COOKIE = 'selfbound_signed_in';
/** Name before the rename: still accepted when reading, always cleared when writing (legacy-xlr8). */
export const LEGACY_SIGNED_IN_COOKIE = 'xlr8_signed_in';

/**
 * Does the Clerk server answer at all? `no-cors`: only whether an answer arrives counts, not which.
 * Only asked after "no user", so rarely.
 */
async function reachable(host: string | undefined) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  if (!host || typeof fetch === 'undefined') return true;
  try {
    await fetch(`https://${host}/v1/environment`, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(CLERK_TIMEOUT) });
    return true;
  } catch {
    return false;
  }
}

/** Frontend API address from the publishable key (`pk_live_` + base64 of "host$"). */
function clerkHost(key: string): string | undefined {
  try {
    return atob(key.split('_')[2] ?? '').replace(/\$$/, '') || undefined;
  } catch {
    return undefined;
  }
}

/** Error because Clerk cannot fetch a token without network (otherwise it is a real rejection). */
function offlineError(error: unknown) {
  const code = (error as { code?: string; errors?: { code?: string }[] } | null)?.code ?? (error as { errors?: { code?: string }[] } | null)?.errors?.[0]?.code;
  return code === 'network_error' || code === 'clerk_offline' || (typeof navigator !== 'undefined' && navigator.onLine === false);
}

/** Until the browser reports being online again, at most RETRY_MS. */
function onlineAgain() {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      removeEventListener('online', done);
      resolve();
    };
    const timer = setTimeout(done, RETRY_MS);
    addEventListener('online', done);
  });
}

function signedInBefore() {
  if (typeof document === 'undefined') return false;
  const cookies = document.cookie.split('; ');
  return cookies.includes(`${SIGNED_IN_COOKIE}=1`) || cookies.includes(`${LEGACY_SIGNED_IN_COOKIE}=1`);
}

function markSignedIn(on: boolean) {
  if (typeof document === 'undefined') return;
  const secure = location.protocol === 'https:' ? '; secure' : '';
  document.cookie = on ? `${SIGNED_IN_COOKIE}=1; path=/; max-age=31536000; samesite=lax${secure}` : `${SIGNED_IN_COOKIE}=; path=/; max-age=0; samesite=lax${secure}`;
  document.cookie = `${LEGACY_SIGNED_IN_COOKIE}=; path=/; max-age=0; samesite=lax${secure}`;
}

/** Sign-in address that leads back to `path` afterwards (`/` needs no way back). */
export function signInPath(path: string): string {
  return path === '/' ? '/sign-in' : `/sign-in?redirect_url=${encodeURIComponent(path)}`;
}

export class Auth {
  readonly status = new Slice<AuthStatus>('loading');
  readonly kind: 'dev' | 'clerk' | 'none';
  #clerk: ClerkLike | null = null;

  constructor(readonly config: AuthConfig) {
    this.kind = config.devToken ? 'dev' : config.clerkPublishableKey ? 'clerk' : 'none';
  }

  /** Starts sign-in and connects the Convex client. */
  async start(client: ConvexClient) {
    if (this.kind === 'dev') {
      const token = this.config.devToken!;
      client.setAuth(async () => token, (ok) => this.status.set(ok ? 'signed-in' : 'signed-out'));
      // The token is always valid locally: show right away, do not wait for confirmation.
      this.status.set('signed-in');
      return;
    }
    if (this.kind === 'none') {
      this.status.set('unconfigured');
      return;
    }
    if (!this.config.loadClerk) throw new Error('Clerk is not configured.');
    this.#client = client;
    if (signedInBefore()) {
      // Until Clerk is there, Convex waits for this token (paused connection, nothing goes out without sign-in).
      const seq = ++this.#authSeq;
      client.setAuth(() => this.#clerkReady.then((clerk) => this.#token(clerk, false, seq)), (ok) => this.#onServerAuth(ok));
      this.status.set('cached');
    }
    if (typeof addEventListener !== 'undefined')
      addEventListener('online', () => {
        this.#retryDelay = RETRY_MS;
        void this.#attempt();
      });
    await this.#attempt();
  }

  /** Clerk currently unreachable (no network, time limit exceeded). */
  readonly unreachable = new Slice(false);

  #client: ConvexClient | null = null;
  #resolveClerk: ((clerk: ClerkLike) => void) | null = null;
  readonly #clerkReady = new Promise<ClerkLike>((resolve) => (this.#resolveClerk = resolve));
  /** Running attempt; `slow`: longer than CLERK_TIMEOUT, a new attempt may replace it. */
  #attempting: { done: Promise<void>; slow: boolean } | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #retryDelay = RETRY_MS;
  #tries = 0;

  /** "Try again" on the offline notice (the notice stays until Clerk answers). */
  retry() {
    this.#retryDelay = RETRY_MS;
    return this.#attempt();
  }

  /** Load Clerk, one at a time. A hanging attempt (no network, but no rejection) is replaced after CLERK_TIMEOUT. */
  #attempt(): Promise<void> {
    if (this.#clerk) return Promise.resolve();
    if (this.#attempting && !this.#attempting.slow) return this.#attempting.done;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const attempt = { done: Promise.resolve(), slow: false };
    const current = () => this.#attempting === attempt;
    this.#attempting = attempt;
    attempt.done = (async () => {
      const slow = setTimeout(() => {
        attempt.slow = true;
        if (!current()) return;
        this.#setUnreachable(true);
        this.#retryLater();
      }, CLERK_TIMEOUT);
      try {
        // New attempt: first ask whether Clerk answers. Every instance stays around with its timers.
        if (this.#tries++ > 0 && !(await reachable(clerkHost(this.config.clerkPublishableKey!)))) throw new Error('Clerk unreachable');
        const { Clerk } = await this.config.loadClerk!();
        const clerk = new Clerk(this.config.clerkPublishableKey!) as unknown as ClerkLike;
        await clerk.load();
        // Without network Clerk still reports "loaded", just without a user. That is not a sign-out
        // (otherwise we would go to the sign-in page, which does not load offline either).
        if (!clerk.user && !(await reachable(clerk.frontendApi))) throw new Error('Clerk unreachable');
        // A replaced attempt that still arrives counts too, as long as none finished before.
        if (this.#clerk) return;
        this.#clerk = clerk;
        this.#setUnreachable(false);
        this.#connect(clerk);
      } catch {
        // Chunk not loadable or Clerk offline: notice, retry later.
        if (current()) this.#setUnreachable(true);
      } finally {
        clearTimeout(slow);
        if (current()) {
          this.#attempting = null;
          if (!this.#clerk) this.#retryLater();
        }
      }
    })();
    return attempt.done;
  }

  /** Every attempt creates a new Clerk instance; offline, hence with a growing pause. */
  #retryLater() {
    if (this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => void this.#attempt(), this.#retryDelay);
    this.#retryDelay = Math.min(this.#retryDelay * 2, RETRY_MAX);
  }

  #setUnreachable(on: boolean) {
    this.unreachable.set(on);
    if (on && this.status.get() === 'loading') this.status.set('offline');
  }

  /** Counts every setAuth: a token fetch of a replaced version stops waiting. */
  #authSeq = 0;

  async #token(clerk: ClerkLike, forceRefreshToken: boolean | undefined, seq = this.#authSeq) {
    for (;;) {
      try {
        const token = (await clerk.session?.getToken({ template: 'convex', skipCache: forceRefreshToken })) ?? null;
        if (this.unreachable.get()) this.#setUnreachable(false);
        return token;
      } catch (error) {
        // No token without network: wait. An error would mean "rejected" to Convex, and the app would show "No access".
        if (!offlineError(error) || seq !== this.#authSeq) throw error;
        this.#setUnreachable(true);
        await onlineAgain();
      }
    }
  }

  #onServerAuth(ok: boolean) {
    markSignedIn(ok);
    this.status.set(ok ? 'signed-in' : 'denied');
  }

  #connect(clerk: ClerkLike) {
    const client = this.#client!;
    const connect = () => {
      const seq = ++this.#authSeq;
      if (clerk.user) {
        client.setAuth(({ forceRefreshToken }) => this.#token(clerk, forceRefreshToken, seq), (ok) => this.#onServerAuth(ok));
        this.#resolveClerk?.(clerk);
        markSignedIn(true);
        this.status.set('signed-in');
      } else {
        markSignedIn(false);
        client.setAuth(async () => null);
        this.status.set('signed-out');
      }
    };
    connect();
    let wasSignedIn = !!clerk.user;
    clerk.addListener(({ user }) => {
      if (!!user !== wasSignedIn) {
        wasSignedIn = !!user;
        connect();
      }
    });
  }

  /** On to the sign-in page; afterwards you come back to the same address. */
  signIn({ replace = false } = {}) {
    const target = signInPath(location.pathname + location.search + location.hash);
    if (replace) location.replace(target);
    else location.assign(target);
  }

  /** When signing out: no detour via the sign-in page, go to `/`. */
  leaving = false;

  /** Sign out and go to `/` (without the marker Vercel serves the sign-in page there). */
  async signOut() {
    this.leaving = true;
    markSignedIn(false);
    await this.#clerk?.signOut({ redirectUrl: `${location.origin}/` });
  }
}
