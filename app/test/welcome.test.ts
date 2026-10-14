// Start page and sign-in: the way back after sign-in and the "signed in" marker cookie.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIGNED_IN_COOKIE as CORE_COOKIE, signInPath } from '@selfbound/core';
import { safeRedirect, SIGNED_IN_COOKIE } from '../src/welcome/session.ts';

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
  it('start page, app and Vercel use the same cookie name', () => {
    expect(SIGNED_IN_COOKIE).toBe(CORE_COOKIE);
    const vercel = JSON.parse(readFileSync(new URL('../../deploy/vercel.base.json', import.meta.url), 'utf8'));
    const root = vercel.rewrites.find((r: { source: string }) => r.source === '/');
    expect(root.missing).toEqual([{ type: 'cookie', key: SIGNED_IN_COOKIE }]);
    expect(root.destination).toBe('/welcome.html');
    expect(readFileSync(new URL('../vite.plugins.ts', import.meta.url), 'utf8')).toContain(`${SIGNED_IN_COOKIE}=1`);
  });
});
