// Operator details for the imprint and privacy policy of the landing page (site/) and the docs
// (docs-site/). They name a person and a postal address, so they never live in this public repository:
// they are read at build time from a file outside it.
//
//   ~/.config/xlr8/site-legal.json   (or $XDG_CONFIG_HOME/xlr8/site-legal.json, or XLR8_SITE_LEGAL_FILE)
//   { "name": "…", "street": "…", "postalCode": "…", "city": "…", "country": "…", "email": "…", "phone": "…" }
//
// `phone` is optional. A build that goes live (production deploy, or a listed site) fails if the file is
// missing or incomplete; any other build fills in visible placeholders.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LEGAL_FILE = process.env.XLR8_SITE_LEGAL_FILE || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'xlr8', 'site-legal.json');

const REQUIRED = ['name', 'street', 'postalCode', 'city', 'country', 'email'];

export const LEGAL_PLACEHOLDER = {
  name: '[Name of the provider]',
  street: '[Street and number]',
  postalCode: '[Postal code]',
  city: '[City]',
  country: '[Country]',
  email: 'provider@example.invalid',
};

/** Truthy for the builds that go live: the deploy tools set XLR8_SITE_REQUIRE_LEGAL=1 for production. */
export const legalRequired = (env = process.env, listed = false) => listed || ['1', 'true', 'yes'].includes(String(env.XLR8_SITE_REQUIRE_LEGAL ?? '').toLowerCase());

/**
 * @param {{ required?: boolean, file?: string }} [opts]
 * @returns {{ name: string, street: string, postalCode: string, city: string, country: string, email: string, phone?: string }}
 */
export function loadLegal({ required = false, file = LEGAL_FILE } = {}) {
  if (!existsSync(file)) {
    if (!required) return { ...LEGAL_PLACEHOLDER };
    throw new Error(`Imprint details missing: ${file} does not exist. Create it (name, street, postalCode, city, country, email; see site/README.md) before building for production.`);
  }
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Imprint details: ${file} is not valid JSON (${e instanceof Error ? e.message : e}).`);
  }
  const missing = REQUIRED.filter((k) => typeof json[k] !== 'string' || !json[k].trim());
  if (missing.length) {
    if (!required) return { ...LEGAL_PLACEHOLDER, ...Object.fromEntries(REQUIRED.filter((k) => !missing.includes(k)).map((k) => [k, json[k].trim()])) };
    throw new Error(`Imprint details incomplete: ${file} lacks ${missing.join(', ')}.`);
  }
  const phone = typeof json.phone === 'string' && json.phone.trim() ? json.phone.trim() : undefined;
  return { ...Object.fromEntries(REQUIRED.map((k) => [k, json[k].trim()])), ...(phone && { phone }) };
}

export const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HTML pieces for the templates: name, postal address (lines joined by <br>), mail link, optional phone. */
export function legalHtml(l) {
  const e = escapeHtml;
  return {
    name: e(l.name),
    address: [e(l.name), e(l.street), `${e(l.postalCode)} ${e(l.city)}`, e(l.country)].join('<br />'),
    addressInline: e(`${l.name}, ${l.street}, ${l.postalCode} ${l.city}, ${l.country}`),
    email: `<a href="mailto:${e(l.email)}">${e(l.email)}</a>`,
    phone: l.phone ? `<a href="tel:${e(l.phone.replace(/[^+\d]/g, ''))}">${e(l.phone)}</a>` : '',
  };
}

/** Replaces __LEGAL_NAME__, __LEGAL_ADDRESS__, __LEGAL_ADDRESS_INLINE__, __LEGAL_EMAIL__, __LEGAL_PHONE__ in a template. */
export function fillLegal(html, l) {
  const h = legalHtml(l);
  return html
    .replaceAll('__LEGAL_ADDRESS_INLINE__', h.addressInline)
    .replaceAll('__LEGAL_ADDRESS__', h.address)
    .replaceAll('__LEGAL_NAME__', h.name)
    .replaceAll('__LEGAL_EMAIL__', h.email)
    .replaceAll('__LEGAL_PHONE__', h.phone);
}
