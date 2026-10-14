// Clerk key per host: during a domain change two Clerk hosts run side by side.
import { describe, expect, it } from 'vitest';
import { publishableKeyFor } from '../src/publishableKey.ts';

const both = 'selfbound.example.com=pk_live_old, tracker.example.org=pk_live_new';

describe('publishableKeyFor', () => {
  it('uses a single key for every host', () => {
    expect(publishableKeyFor('pk_live_abc', 'tracker.example.org')).toBe('pk_live_abc');
    expect(publishableKeyFor('pk_live_abc', '127.0.0.1')).toBe('pk_live_abc');
  });
  it('picks the key of the host from the list', () => {
    expect(publishableKeyFor(both, 'selfbound.example.com')).toBe('pk_live_old');
    expect(publishableKeyFor(both, 'tracker.example.org')).toBe('pk_live_new');
  });
  it('returns no key for other hosts', () => {
    expect(publishableKeyFor(both, 'www.tracker.example.org')).toBeUndefined();
    expect(publishableKeyFor(both, 'evil.example')).toBeUndefined();
  });
  it('no value, no key', () => {
    expect(publishableKeyFor(undefined, 'tracker.example.org')).toBeUndefined();
    expect(publishableKeyFor('', 'tracker.example.org')).toBeUndefined();
  });
});
