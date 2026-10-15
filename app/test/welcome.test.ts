// Start page and sign-in: the way back after sign-in and the "signed in" marker cookie.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { LEGACY_SIGNED_IN_COOKIE as CORE_LEGACY, SIGNED_IN_COOKIE as CORE_COOKIE, signInPath } from '@selfbound/core';
import { LEGACY_SIGNED_IN_COOKIE, markSignedIn, safeRedirect, SIGNED_IN_COOKIE } from '../src/welcome/session.ts';
import { signedOutGuard } from '../vite.plugins.ts';

const origin = 'https://selfbound.example.com';

describe('safeRedirect', () => {
  it('leads into the app without a target', () => {
    expect(safeRedirect(null, origin)).toBe('/');
    expect(safeRedirect('', origin)).toBe('/');
  });
  it('keeps path, query and hash of the same origin', () => {
    expect(safeRedirect('/issue/ACME-106', origin)).toBe('/issue/ACME-106');
    expect(safeRedirect('/oauth/consent?request=abc#x', origin)).toBe('/oauth/consent?request=abc#x');
    expect(safeRedirect('https://selfbound.example.com/team/ACME/backlog', origin)).toBe('/team/ACME/backlog');
  });
  it('allows no other origin', () => {
    expect(safeRedirect('https://evil.example/issue/1', origin)).toBe('/');
    expect(safeRedirect('//evil.example/x', origin)).toBe('/');
    expect(safeRedirect('javascript:alert(1)', origin)).toBe('/');
  });
  it('does not lead back to sign-in', () => {
    expect(safeRedirect('/sign-in', origin)).toBe('/');
    expect(safeRedirect('/sign-in/?redirect_url=/sign-in', origin)).toBe('/');
    expect(safeRedirect('/welcome.html', origin)).toBe('/');
  });
});

describe('sign-in from the app', () => {
  it('appends the way back, except for /', () => {
    expect(signInPath('/')).toBe('/sign-in');
    expect(signInPath('/issue/ACME-106?x=1#c')).toBe('/sign-in?redirect_url=%2Fissue%2FACME-106%3Fx%3D1%23c');
    expect(safeRedirect(new URLSearchParams(signInPath('/issue/ACME-106?x=1#c').split('?')[1]).get('redirect_url'), origin)).toBe('/issue/ACME-106?x=1#c');
  });
  it('start page, app and Vercel use the same cookie names', () => {
    expect(SIGNED_IN_COOKIE).toBe(CORE_COOKIE);
    expect(LEGACY_SIGNED_IN_COOKIE).toBe(CORE_LEGACY);
    expect(SIGNED_IN_COOKIE).toBe('selfbound_signed_in');
    expect(LEGACY_SIGNED_IN_COOKIE).toBe('xlr8_signed_in'); // legacy-xlr8
  });

  // Vercel applies the first rewrite that matches: `has` = all listed cookies present, `missing` = none present.
  type Rule = { source: string; destination: string; has?: { type: string; key: string }[]; missing?: { type: string; key: string }[] };
  const rootTarget = (cookies: string[]) => {
    const vercel = JSON.parse(readFileSync(new URL('../../deploy/vercel.base.json', import.meta.url), 'utf8')) as { rewrites: Rule[] };
    const rule = vercel.rewrites.find(
      (r) => r.source === '/' && (r.has ?? []).every((h) => cookies.includes(h.key)) && (r.missing ?? []).every((m) => !cookies.includes(m.key)),
    );
    return rule?.destination;
  };

  it('Vercel shows the start page at / only when both cookies are missing', () => {
    expect(rootTarget([])).toBe('/welcome.html');
    expect(rootTarget(['other'])).toBe('/welcome.html');
    expect(rootTarget([SIGNED_IN_COOKIE])).toBe('/app.html');
    expect(rootTarget([LEGACY_SIGNED_IN_COOKIE])).toBe('/app.html');
    expect(rootTarget([SIGNED_IN_COOKIE, LEGACY_SIGNED_IN_COOKIE])).toBe('/app.html');
  });

  it('the guard script in index.html accepts either cookie', () => {
    const handler = (signedOutGuard(true).transformIndexHtml as unknown as { handler: (html: string, ctx: { filename: string }) => { children: string }[] }).handler;
    const code = handler('', { filename: '/app/index.html' })[0].children;
    const redirects = (cookie: string) => {
      let to = '';
      new Function('document', 'location', code)({ cookie }, { pathname: '/inbox', search: '', hash: '', replace: (url: string) => (to = url) });
      return to;
    };
    expect(redirects('')).toBe('/sign-in?redirect_url=%2Finbox');
    expect(redirects('a=1')).toBe('/sign-in?redirect_url=%2Finbox');
    expect(redirects('a=1; selfbound_signed_in=1')).toBe('');
    expect(redirects('xlr8_signed_in=1; a=1')).toBe(''); // legacy-xlr8
  });
});

describe('markSignedIn', () => {
  it('sets the new cookie and always clears the old one', () => {
    const writes: string[] = [];
    vi.stubGlobal('location', { protocol: 'https:' });
    vi.stubGlobal('document', { set cookie(line: string) { writes.push(line.split(';')[0]); } });
    markSignedIn(true);
    markSignedIn(false);
    vi.unstubAllGlobals();
    // legacy-xlr8: the old cookie is cleared after every write
    expect(writes).toEqual(['selfbound_signed_in=1', 'xlr8_signed_in=', 'selfbound_signed_in=', 'xlr8_signed_in=']);
  });
});
