import { describe, expect, it } from 'vitest';
import { ctx, intlLocale, locale, msg, resolveLocale, setDictionary, t, tc, tn, translated } from '../src/i18n.ts';

// Module state is shared within this file: the first test runs before any setDictionary() call.
const LABELS = translated({ open: 'Open', closed: 'Closed' });

describe('i18n', () => {
  it('reports keys looked up before setDictionary() that have a translation', () => {
    expect(t('Open')).toBe('Open');
    expect(t('Not translated')).toBe('Not translated');
    expect(LABELS.closed).toBe('Closed');
    const missed = setDictionary('de', { Open: 'Offen', Closed: 'Geschlossen', Unused: 'Unbenutzt' });
    expect(missed.sort()).toEqual(['Closed', 'Open']);
    // Only the first activation collects keys.
    t('Open');
    expect(setDictionary('de', { Open: 'Offen' })).toEqual([]);
  });

  it('resolves the saved choice against the browser languages', () => {
    expect(resolveLocale('de')).toBe('de');
    expect(resolveLocale('en', ['de-DE'])).toBe('en');
    expect(resolveLocale('auto', ['fr-FR', 'de-AT', 'en'])).toBe('de');
    expect(resolveLocale('auto', ['en-GB', 'de'])).toBe('en');
    expect(resolveLocale(undefined, ['fr', 'it'])).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale('xx' as never, ['de'])).toBe('de');
  });

  it('translates without a dictionary to the English key', () => {
    setDictionary('en', { Open: 'Offen' });
    expect(locale()).toBe('en');
    expect(intlLocale()).toBe('en-US');
    expect(t('Open')).toBe('Open');
    expect(t('{n} selected', { n: 3 })).toBe('3 selected');
    expect(tn(1, '{count} issue', '{count} issues')).toBe('1 issue');
    expect(tn(4, '{count} issue', '{count} issues')).toBe('4 issues');
    expect(tc('verb', 'Open')).toBe('Open');
  });

  it('translates with a dictionary', () => {
    setDictionary('de', {
      Open: 'Offen',
      '{n} selected': '{n} gewählt',
      '{count} issue': ['{count} Issue', '{count} Issues'],
      '{count} point': '{count} Pkt.',
      [ctx('verb', 'Open')]: 'Öffnen',
      'Moved {key} to {team}': '{key} nach {team} verschoben',
    });
    expect(locale()).toBe('de');
    expect(intlLocale()).toBe('de-DE');
    expect(t('Open')).toBe('Offen');
    expect(t('Missing')).toBe('Missing');
    expect(t('{n} selected', { n: 2 })).toBe('2 gewählt');
    expect(tn(1, '{count} issue', '{count} issues')).toBe('1 Issue');
    expect(tn(0, '{count} issue', '{count} issues')).toBe('0 Issues');
    // A plain string entry serves both forms.
    expect(tn(5, '{count} point', '{count} points')).toBe('5 Pkt.');
    expect(tc('verb', 'Open')).toBe('Öffnen');
    expect(tc('noun', 'Open')).toBe('Open');
    expect(t('Moved {key} to {team}', { key: 'ACME-1', team: 'Core' })).toBe('ACME-1 nach Core verschoben');
  });

  it('fills placeholders and leaves unknown ones alone', () => {
    setDictionary('en', null);
    expect(t('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    expect(t('{a} and {a}', { a: 'x' })).toBe('x and x');
    expect(tn(2, '{count} {thing}', '{count} {thing}s', { thing: 'label' })).toBe('2 labels');
  });

  it('reads translated() maps lazily', () => {
    setDictionary('de', { Open: 'Offen', Closed: 'Geschlossen' });
    expect(LABELS.open).toBe('Offen');
    expect({ ...LABELS }).toEqual({ open: 'Offen', closed: 'Geschlossen' });
    expect(Object.keys(LABELS)).toEqual(['open', 'closed']);
    setDictionary('en', null);
    expect(LABELS.open).toBe('Open');
  });

  it('marks strings without translating them', () => {
    setDictionary('de', { Open: 'Offen' });
    expect(msg('Open')).toBe('Open');
    setDictionary('en', null);
  });
});
