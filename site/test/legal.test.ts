// Operator details for the imprint come from a file outside the repository (tooling/site-legal.mjs).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain .mjs without types, shared with docs-site/
import { LEGAL_PLACEHOLDER, fillLegal, legalRequired, loadLegal } from '../../tooling/site-legal.mjs';

const dir = mkdtempSync(join(tmpdir(), 'selfbound-legal-'));
const write = (name: string, content: unknown) => {
  const file = join(dir, name);
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};
const full = { name: ' Erika Beispiel ', street: 'Musterweg 1', postalCode: '12345', city: 'Musterstadt', country: 'Deutschland', email: 'kontakt@example.com' };

describe('loadLegal', () => {
  it('reads and trims the file, with an optional phone number', () => {
    expect(loadLegal({ file: write('ok.json', full) })).toEqual({ ...full, name: 'Erika Beispiel' });
    expect(loadLegal({ file: write('phone.json', { ...full, phone: '+49 123 4567' }) }).phone).toBe('+49 123 4567');
  });
  it('fails loudly for a build that goes live when the file is missing, unreadable or incomplete', () => {
    expect(() => loadLegal({ required: true, file: join(dir, 'missing.json') })).toThrow(/Imprint details missing/);
    expect(() => loadLegal({ required: true, file: write('bad.json', '{') })).toThrow(/not valid JSON/);
    expect(() => loadLegal({ required: true, file: write('partial.json', { ...full, city: ' ', email: undefined }) })).toThrow(/lacks city, email/);
  });
  it('fills in visible placeholders for other builds', () => {
    expect(loadLegal({ file: join(dir, 'missing.json') })).toEqual(LEGAL_PLACEHOLDER);
    expect(loadLegal({ file: write('partial2.json', { ...full, city: '' }) })).toMatchObject({ name: 'Erika Beispiel', city: LEGAL_PLACEHOLDER.city });
  });
});

describe('legalRequired', () => {
  it('is on for a listed site and for production deploys (SELFBOUND_SITE_REQUIRE_LEGAL), off otherwise', () => {
    expect(legalRequired({}, false)).toBe(false);
    expect(legalRequired({}, true)).toBe(true);
    expect(legalRequired({ SELFBOUND_SITE_REQUIRE_LEGAL: '1' }, false)).toBe(true);
    expect(legalRequired({ SELFBOUND_SITE_REQUIRE_LEGAL: '0' }, false)).toBe(false);
  });
  it('still reads the old variable name, the new one wins', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // legacy-xlr8: fallback until the follow-up removes it
    expect(legalRequired({ XLR8_SITE_REQUIRE_LEGAL: '1' }, false)).toBe(true);
    expect(legalRequired({ XLR8_SITE_REQUIRE_LEGAL: '1', SELFBOUND_SITE_REQUIRE_LEGAL: '0' }, false)).toBe(false); // legacy-xlr8
    vi.restoreAllMocks();
  });
});

describe('fillLegal', () => {
  it('writes the address block, the inline form, the mail link and the phone link', () => {
    const out = fillLegal('__LEGAL_ADDRESS__|__LEGAL_ADDRESS_INLINE__|__LEGAL_EMAIL__|__LEGAL_PHONE__', { ...full, name: 'Erika Beispiel', phone: '+49 (0)1 23' });
    expect(out).toContain('Erika Beispiel<br />Musterweg 1<br />12345 Musterstadt<br />Deutschland');
    expect(out).toContain('Erika Beispiel, Musterweg 1, 12345 Musterstadt, Deutschland');
    expect(out).toContain('<a href="mailto:kontakt@example.com">kontakt@example.com</a>');
    expect(out).toContain('href="tel:+4901 23"'.replace(' ', ''));
  });
});
