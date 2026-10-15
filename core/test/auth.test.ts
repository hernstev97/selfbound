// Starting offline: Clerk is simulated, time and "online" events are driven by the test.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/index.ts';
import { Auth, CLERK_TIMEOUT, LEGACY_SIGNED_IN_COOKIE, SIGNED_IN_COOKIE } from '../src/auth.ts';
import { callName, doc, fakeClient, meta } from './helpers.ts';

type FetchToken = (args: { forceRefreshToken: boolean }) => Promise<string | null>;

/** Browser environment as far as Auth needs it: cookie, location, "online" event. */
function browser(cookie: string) {
  const listeners = new Set<() => void>();
  const g = globalThis as Record<string, unknown>;
  // A cookie jar: writing "name=value; ..." sets one cookie, an empty value or max-age=0 removes it.
  const jar = new Map<string, string>(cookie.split('; ').filter(Boolean).map((c) => c.split('=') as [string, string]));
  g.document = {
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(line: string) {
      const [pair, ...attrs] = line.split('; ');
      const [name, value] = pair.split('=');
      if (value === '' || attrs.includes('max-age=0')) jar.delete(name);
      else jar.set(name, value);
    },
  };
  g.location = { protocol: 'https:' };
  g.addEventListener = (type: string, cb: () => void) => type === 'online' && listeners.add(cb);
  g.removeEventListener = (_type: string, cb: () => void) => listeners.delete(cb);
  return { online: () => listeners.forEach((cb) => cb()), cookies: () => [...jar.keys()].sort() };
}

function client() {
  const calls: { fetchToken: FetchToken; onChange?: (ok: boolean) => void }[] = [];
  return { calls, setAuth: (fetchToken: FetchToken, onChange?: (ok: boolean) => void) => void calls.push({ fetchToken, onChange }) };
}

/** Clerk stand-in: `load` as specified, a session with a token that can fail offline. */
function clerk(load: () => Promise<void>, opts: { user?: boolean; token?: () => Promise<string>; server?: boolean } = {}) {
  const made: unknown[] = [];
  class Clerk {
    user = opts.user === false ? null : { id: 'u1' };
    // Server reachable: a real address; else one that does not answer in the test (fetch is replaced).
    frontendApi = opts.server === false ? 'clerk.offline.invalid' : 'clerk.online.invalid';
    session = { getToken: opts.token ?? (async () => 'token-1') };
    constructor() {
      made.push(this);
    }
    load = load;
    addListener() {
      return () => {};
    }
    async signOut() {}
  }
  return { made, loadClerk: async () => ({ Clerk: Clerk as never }) };
}

const never = () => new Promise<void>(() => {});
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const saved = { ...globalThis } as Record<string, unknown>;
beforeEach(() => {
  vi.useFakeTimers();
  // Clerk server: "online" answers, "offline" does not.
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).includes('offline')) throw new TypeError('Failed to fetch');
    return new Response(null, { status: 200 });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const g = globalThis as Record<string, unknown>;
  for (const key of ['document', 'location', 'addEventListener', 'removeEventListener']) g[key] = saved[key];
});

describe('starting offline', () => {
  test('signed in last time: "cached" right away, Convex waits for the token until Clerk is there', async () => {
    browser(`${SIGNED_IN_COOKIE}=1`);
    let finish!: () => void;
    const fake = clerk(() => new Promise<void>((r) => (finish = r)));
    const auth = new Auth({ clerkPublishableKey: 'pk_test_x', loadClerk: fake.loadClerk });
    const c = client();
    void auth.start(c as never);
    expect(auth.status.get()).toBe('cached');
    expect(c.calls).toHaveLength(1);
    let token: string | null | undefined;
    void c.calls[0].fetchToken({ forceRefreshToken: false }).then((t) => (token = t));
    await settle();
    expect(token).toBeUndefined();
    // Clerk takes too long: notice, the app stays.
    await vi.advanceTimersByTimeAsync(CLERK_TIMEOUT + 10);
    expect(auth.unreachable.get()).toBe(true);
    expect(auth.status.get()).toBe('cached');
    // Clerk arrives after all: signed in, the waiting token arrives.
    finish();
    await settle();
    expect(auth.status.get()).toBe('signed-in');
    expect(auth.unreachable.get()).toBe(false);
    await settle();
    expect(token).toBe('token-1');
  });

  test('never signed in and Clerk fails: "offline", Try again reloads', async () => {
    browser('');
    const fake = clerk(async () => {
      throw new TypeError('Failed to fetch');
    });
    const auth = new Auth({ clerkPublishableKey: 'pk_test_x', loadClerk: fake.loadClerk });
    const c = client();
    await auth.start(c as never);
    expect(auth.status.get()).toBe('offline');
    expect(c.calls).toHaveLength(0);
    // The notice stays while retrying.
    const retry = auth.retry();
    expect(auth.status.get()).toBe('offline');
    await retry;
    expect(auth.status.get()).toBe('offline');
    expect(fake.made).toHaveLength(2);
  });

  test('if Clerk hangs without rejecting, "online" replaces the attempt', async () => {
    const env = browser(`${SIGNED_IN_COOKIE}=1`);
    const fake = clerk(never);
    const auth = new Auth({ clerkPublishableKey: 'pk_test_x', loadClerk: fake.loadClerk });
    void auth.start(client() as never);
    await settle();
    expect(fake.made).toHaveLength(1);
    // Before the time limit: no second attempt.
    env.online();
    await settle();
    expect(fake.made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CLERK_TIMEOUT + 10);
    env.online();
    await settle();
    expect(fake.made).toHaveLength(2);
  });

  test('token offline: wait instead of "No access", it arrives once online again', async () => {
    const env = browser(`${SIGNED_IN_COOKIE}=1`);
    let offline = true;
    const fake = clerk(async () => {}, {
      token: async () => {
        if (offline) throw Object.assign(new Error('offline'), { code: 'clerk_offline' });
        return 'token-2';
      },
    });
    const auth = new Auth({ clerkPublishableKey: 'pk_test_x', loadClerk: fake.loadClerk });
    const c = client();
    await auth.start(c as never);
    expect(auth.status.get()).toBe('signed-in');
    const latest = c.calls.at(-1)!;
    let token: string | null | undefined;
    void latest.fetchToken({ forceRefreshToken: false }).then((t) => (token = t));
    await settle();
    expect(token).toBeUndefined();
    expect(auth.unreachable.get()).toBe(true);
    expect(auth.status.get()).toBe('signed-in');
    offline = false;
    env.online();
    await settle();
    expect(token).toBe('token-2');
    expect(auth.unreachable.get()).toBe(false);
  });

  test('Clerk without server (loaded, but without user) is not a sign-out', async () => {
    browser(`${SIGNED_IN_COOKIE}=1`);
    const fake = clerk(async () => {}, { user: false, server: false });
    const auth = new Auth({ clerkPublishableKey: 'pk_test_x', loadClerk: fake.loadClerk });
    const c = client();
    await auth.start(c as never);
    expect(auth.status.get()).toBe('cached');
    expect(auth.unreachable.get()).toBe(true);
    expect(c.calls).toHaveLength(1);
    // Retried later, with a growing pause.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.made).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.made).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.made).toHaveLength(3);
  });

  test('token error with network (session revoked) does not wait, Convex gets the rejection', async () => {
    browser(`${SIGNED_IN_COOKIE}=1`);
    const fake = clerk(async () => {}, {
      token: async () => {
        throw Object.assign(new Error('revoked'), { code: 'session_revoked' });
      },
    });
    const auth = new Auth({ clerkPublishableKey: 'pk_test_x', loadClerk: fake.loadClerk });
    const c = client();
    await auth.start(c as never);
    await expect(c.calls.at(-1)!.fetchToken({ forceRefreshToken: false })).rejects.toThrow('revoked');
  });

  test('Clerk reports signed out: Convex gets no token', async () => {
    browser(`${SIGNED_IN_COOKIE}=1`);
    const fake = clerk(async () => {}, { user: false });
    const auth = new Auth({ clerkPublishableKey: 'pk_test_x', loadClerk: fake.loadClerk });
    const c = client();
    await auth.start(c as never);
    expect(auth.status.get()).toBe('signed-out');
    expect(await c.calls.at(-1)!.fetchToken({ forceRefreshToken: false })).toBeNull();
  });
});

describe('signed-in cookie', () => {
  test('the old cookie alone still counts as signed in, and signing in replaces it with the new one', async () => {
    const env = browser(`${LEGACY_SIGNED_IN_COOKIE}=1`);
    const auth = new Auth({ clerkPublishableKey: 'pk_test_x', loadClerk: clerk(async () => {}).loadClerk });
    void auth.start(client() as never);
    expect(auth.status.get()).toBe('cached');
    await settle();
    expect(auth.status.get()).toBe('signed-in');
    expect(env.cookies()).toEqual([SIGNED_IN_COOKIE]);
  });

  test('no cookie: not signed in before, and a fresh sign-in sets only the new name', async () => {
    const env = browser('');
    const auth = new Auth({ clerkPublishableKey: 'pk_test_x', loadClerk: clerk(async () => {}).loadClerk });
    void auth.start(client() as never);
    expect(auth.status.get()).toBe('loading');
    await settle();
    expect(env.cookies()).toEqual([SIGNED_IN_COOKIE]);
  });
});

describe('changes when starting from the cache', () => {
  async function setup() {
    vi.useRealTimers();
    const c = fakeClient();
    const auth = new Auth({ devToken: 'x' });
    auth.status.set('cached');
    const app = new App({ client: c as never, auth, debug: false, perf: false, cacheName: `gate-${Math.random()}` });
    app.start();
    await Promise.resolve();
    c.push('meta:get', {}, meta);
    c.push('meta:counter', {}, { maxSeq: 63 });
    c.push('issues:bucket', { bucket: 0 }, [doc(0), doc(1)]);
    await new Promise((r) => setTimeout(r, 0));
    const updates = () => c.mutation.mock.calls.filter((call) => callName(call) === 'issues:update');
    return { app, auth, updates };
  }

  test('wait for sign-in and go out afterwards', async () => {
    const { app, auth, updates } = await setup();
    app.edit.patch(['i0' as never], { priority: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(updates()).toHaveLength(0);
    auth.status.set('signed-in');
    await new Promise((r) => setTimeout(r, 0));
    expect(updates()).toHaveLength(1);
  });

  test('without Clerk server: refused with a notice, nothing goes out without a token', async () => {
    const { app, auth, updates } = await setup();
    app.edit.patch(['i0' as never], { priority: 1 });
    auth.unreachable.set(true);
    await new Promise((r) => setTimeout(r, 0));
    app.edit.patch(['i1' as never], { priority: 2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(updates()).toHaveLength(0);
    const errors = app.toasts.list.get().filter((t) => t.kind === 'error');
    expect(errors).toHaveLength(2);
    expect(errors[0].detail).toContain('Offline');
  });
});
