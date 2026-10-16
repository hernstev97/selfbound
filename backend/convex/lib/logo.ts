import { LIMITS } from '../shared/constants';

// Checks uploaded team logos. Three layers:
// 1. The UI always shows logos via <img>; no scripts run there.
// 2. SVGs must pass an allowlist of elements and attributes (below).
// 3. Logos are served via GET /logo/<storageId> (convex/http.ts) with a Content-Security-Policy
//    without scripts and `X-Content-Type-Options: nosniff`, in case someone opens the URL
//    directly in the browser. That endpoint runs this check again.

export type LogoType = 'image/svg+xml' | 'image/png';
export type LogoCheck = { ok: true; contentType: LogoType } | { ok: false; reason: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array) {
  return bytes.length >= 24 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

function readUint32(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function checkPng(bytes: Uint8Array): string | null {
  const ihdr = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (ihdr !== 'IHDR') return 'The PNG file is damaged (no IHDR chunk).';
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (width === 0 || height === 0) return 'The PNG file has no valid size.';
  if (width !== height) return `The logo must be square (it is ${width} × ${height} px).`;
  return null;
}

/** Decodes character references (&#106; &#x6A; &colon; …) so they can't bypass the checks. */
function decodeEntities(text: string) {
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;|&newline;/gi, '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function safeCodePoint(n: number) {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/**
 * Form of an attribute value for checking: character references decoded, whitespace and control
 * characters (including tab, newline, null, zero-width) removed, lowercased.
 * Browsers ignore such characters in URL schemes ("java&#9;script:").
 */
function normalized(value: string) {
  return decodeEntities(decodeEntities(value))
    .replace(/[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]+/g, '')
    .toLowerCase();
}

/** Allowed references: internal anchors (#id) and embedded PNG data. */
function allowedReference(value: string) {
  const v = normalized(value);
  return v.startsWith('#') || v.startsWith('data:image/png');
}

/**
 * Allowlist of SVG elements (lowercase names, without namespace prefix).
 * Not included: script, foreignObject, a, animate/set/animateMotion/animateTransform
 * (they can change attributes such as href at runtime), iframe, embed, object, audio, video.
 */
const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'metadata', 'style', 'switch',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath', 'image',
  'lineargradient', 'radialgradient', 'stop', 'pattern', 'clippath', 'mask', 'marker',
  'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite', 'feconvolvematrix',
  'fediffuselighting', 'fedisplacementmap', 'fedistantlight', 'fedropshadow', 'feflood', 'fefunca',
  'fefuncb', 'fefuncg', 'fefuncr', 'fegaussianblur', 'feimage', 'femerge', 'femergenode',
  'femorphology', 'feoffset', 'fepointlight', 'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence',
]);

/** Allowlist of attributes (lowercase, without prefix; xmlns declarations are handled separately). */
const ATTRIBUTES = new Set([
  // Core and structure
  'id', 'class', 'style', 'lang', 'space', 'version', 'baseprofile', 'viewbox', 'preserveaspectratio',
  'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr',
  'd', 'points', 'pathlength', 'transform', 'href', 'role', 'focusable', 'aria-hidden', 'aria-label',
  'aria-labelledby', 'data-name', 'overflow', 'display', 'visibility', 'opacity', 'enable-background',
  'requiredfeatures', 'systemlanguage',
  // Fill and stroke
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'color', 'paint-order',
  'vector-effect', 'shape-rendering', 'image-rendering', 'color-interpolation', 'color-interpolation-filters',
  'mix-blend-mode', 'isolation', 'clip-path', 'clip-rule', 'mask', 'filter', 'marker-start', 'marker-mid',
  'marker-end', 'markerwidth', 'markerheight', 'markerunits', 'orient', 'refx', 'refy',
  // Gradients, patterns, masks
  'gradientunits', 'gradienttransform', 'spreadmethod', 'offset', 'stop-color', 'stop-opacity',
  'patternunits', 'patterncontentunits', 'patterntransform', 'clippathunits', 'maskunits', 'maskcontentunits',
  // Text
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch', 'text-anchor',
  'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'letter-spacing', 'word-spacing',
  'text-decoration', 'text-rendering', 'writing-mode', 'dx', 'dy', 'rotate', 'textlength', 'lengthadjust',
  'startoffset', 'method', 'spacing', 'side',
  // Filter
  'filterunits', 'primitiveunits', 'in', 'in2', 'result', 'stddeviation', 'mode', 'operator', 'k1', 'k2',
  'k3', 'k4', 'values', 'type', 'tablevalues', 'slope', 'intercept', 'amplitude', 'exponent', 'flood-color',
  'flood-opacity', 'lighting-color', 'kernelmatrix', 'kernelunitlength', 'order', 'divisor', 'bias',
  'targetx', 'targety', 'edgemode', 'preservealpha', 'scale', 'xchannelselector', 'ychannelselector',
  'radius', 'basefrequency', 'numoctaves', 'seed', 'stitchtiles', 'surfacescale', 'diffuseconstant',
  'specularconstant', 'specularexponent', 'azimuth', 'elevation', 'z', 'pointsatx', 'pointsaty',
  'pointsatz', 'limitingconeangle',
]);

/** Prefixes whose attributes are only namespace or metadata (xlink:href → href etc.). */
const ATTRIBUTE_PREFIXES = new Set(['xlink', 'xml']);

const localName = (name: string) => name.slice(name.lastIndexOf(':') + 1).toLowerCase();

/** Checks CSS (a <style> element or style attribute) for external loads and script schemes. */
function checkCss(css: string): string | null {
  const text = decodeEntities(css).replace(/<!\[CDATA\[|\]\]>/g, '');
  if (text.includes('\\')) return 'SVG with CSS escape sequences is not allowed.';
  const flat = normalized(text);
  if (flat.includes('@import')) return 'SVG with @import is not allowed.';
  if (/javascript:|vbscript:|expression\(|behavior:|-moz-binding/.test(flat)) return 'SVG with script references in CSS is not allowed.';
  for (const match of text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)) {
    if (!allowedReference(match[2])) return 'SVG with external references (url()) is not allowed.';
  }
  if (flat.replace(/url\(\s*["']?#[^)]*\)/g, '').includes('url(')) return 'SVG with external references (url()) is not allowed.';
  return null;
}

/** Checks one attribute (name and value) of an allowed element. */
function checkAttribute(element: string, rawName: string, value: string): string | null {
  const name = rawName.toLowerCase();
  if (name === 'xmlns' || name.startsWith('xmlns:')) return null; // namespace declaration
  const prefix = name.includes(':') ? name.slice(0, name.indexOf(':')) : null;
  const local = localName(name);
  if (prefix !== null && !ATTRIBUTE_PREFIXES.has(prefix)) return `SVG attribute "${rawName}" is not allowed.`;
  if (local.startsWith('on')) return 'SVG with event attributes (on…=) is not allowed.';
  if (!ATTRIBUTES.has(local)) return `SVG attribute "${rawName}" is not allowed.`;
  const flat = normalized(value);
  if (/javascript:|vbscript:/.test(flat)) return 'SVG with javascript: references is not allowed.';
  if (local === 'href') {
    if (!allowedReference(value)) return 'SVG with external references (href) is not allowed.';
    if (element !== 'image' && !flat.startsWith('#')) return 'SVG with external references (href) is not allowed.';
    return null;
  }
  if (flat.includes('data:')) return 'SVG with embedded data outside <image> is not allowed.';
  if (local === 'style' || flat.includes('url(')) return checkCss(value);
  return null;
}

const TAG = /<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/y;
const ATTRIBUTE = /\s+([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/y;

/**
 * Checks an SVG against an allowlist of elements and attributes. Namespace prefixes are stripped
 * (<s:script> is a script), character references decoded, and whitespace and control characters
 * removed before values are checked. Anything this parser doesn't understand unambiguously is
 * rejected.
 */
export function checkSvgText(raw: string, opts: { square?: boolean } = {}): string | null {
  if (!/<svg[\s>]/i.test(decodeEntities(raw))) return 'Only SVG and PNG are allowed (the file is not an SVG).';
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) return 'SVG with DOCTYPE or ENTITY is not allowed.';
  let i = 0;
  let root: { name: string; attrs: Map<string, string> } | null = null;
  const open: string[] = [];
  while (i < raw.length) {
    const lt = raw.indexOf('<', i);
    if (lt < 0) break;
    if (raw.startsWith('<!--', lt)) {
      const end = raw.indexOf('-->', lt + 4);
      if (end < 0) return 'The SVG is incomplete (unterminated comment).';
      i = end + 3;
      continue;
    }
    if (raw.startsWith('<?', lt)) {
      // Only the XML declaration at the very start.
      const end = raw.indexOf('?>', lt + 2);
      if (end < 0 || root !== null || !/^<\?xml\s/i.test(raw.slice(lt, lt + 6))) {
        return 'SVG with processing instructions is not allowed.';
      }
      i = end + 2;
      continue;
    }
    if (raw.startsWith('<!', lt)) return 'SVG with DOCTYPE, ENTITY or CDATA is not allowed.';
    if (raw.startsWith('</', lt)) {
      const end = /^<\/\s*([A-Za-z_][\w.:-]*)\s*>/.exec(raw.slice(lt));
      if (!end) return 'The SVG is not well-formed.';
      if (open.pop() !== end[1]) return 'The SVG is not well-formed.';
      i = lt + end[0].length;
      continue;
    }
    TAG.lastIndex = lt;
    const tag = TAG.exec(raw);
    if (!tag) return 'The SVG is not well-formed (unreadable element).';
    const [whole, rawName, attrText, selfClosing] = tag;
    const name = localName(rawName);
    if (!ELEMENTS.has(name)) return `SVG element <${rawName}> is not allowed.`;
    if (root === null && name !== 'svg') return 'Only SVG and PNG are allowed (the file is not an SVG).';
    const attrs = new Map<string, string>();
    ATTRIBUTE.lastIndex = 0;
    for (let at = 0; at < attrText.length; ) {
      ATTRIBUTE.lastIndex = at;
      const attr = ATTRIBUTE.exec(attrText);
      if (!attr) return 'The SVG is not well-formed (unreadable attribute).';
      const value = attr[2] ?? attr[3] ?? '';
      const reason = checkAttribute(name, attr[1], value);
      if (reason) return reason;
      attrs.set(attr[1].toLowerCase(), value);
      at = ATTRIBUTE.lastIndex;
    }
    root ??= { name, attrs };
    i = lt + whole.length;
    if (!selfClosing) {
      open.push(rawName);
      if (name === 'style') {
        const close = raw.slice(i).search(/<\/\s*([A-Za-z_][\w.-]*:)?style\s*>/i);
        if (close < 0) return 'The SVG is not well-formed.';
        const reason = checkCss(raw.slice(i, i + close));
        if (reason) return reason;
        i += close;
      }
    }
  }
  if (root === null) return 'Only SVG and PNG are allowed (the file is not an SVG).';
  if (open.length > 0) return 'The SVG is not well-formed (unclosed element).';
  // Team logos are square; provider logos (models.dev) may be wide and are drawn as a fitted mask.
  if (opts.square === false) return null;
  const viewBox = root.attrs.get('viewbox');
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && Math.abs(parts[2] - parts[3]) > 1e-6) {
      return `The logo must be square (viewBox ${parts[2]} × ${parts[3]}).`;
    }
  } else {
    const width = parseFloat(root.attrs.get('width') ?? '');
    const height = parseFloat(root.attrs.get('height') ?? '');
    if (Number.isFinite(width) && Number.isFinite(height) && width !== height) {
      return `The logo must be square (${width} × ${height}).`;
    }
  }
  return null;
}

/**
 * Checks an uploaded logo. `declaredType` is the content type from the storage metadata (may be
 * missing); the content must match it.
 */
export function checkLogo(bytes: Uint8Array, declaredType?: string | null, opts: { square?: boolean } = {}): LogoCheck {
  if (bytes.length === 0) return { ok: false, reason: 'The file is empty.' };
  if (bytes.length > LIMITS.logoMaxBytes) {
    return { ok: false, reason: `The logo is too large (at most ${LIMITS.logoMaxBytes / 1024} KB).` };
  }
  const declared = declaredType?.split(';')[0].trim().toLowerCase() || undefined;
  if (declared && declared !== 'image/svg+xml' && declared !== 'image/png') {
    return { ok: false, reason: 'Only SVG and PNG are allowed.' };
  }
  if (isPng(bytes)) {
    if (declared && declared !== 'image/png') return { ok: false, reason: 'The content (PNG) does not match the file type.' };
    const reason = checkPng(bytes);
    return reason ? { ok: false, reason } : { ok: true, contentType: 'image/png' };
  }
  if (declared === 'image/png') return { ok: false, reason: 'The file has no valid PNG signature.' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'Only SVG and PNG are allowed.' };
  }
  const reason = checkSvgText(text, opts);
  return reason ? { ok: false, reason } : { ok: true, contentType: 'image/svg+xml' };
}

/**
 * URL of a logo (team or model provider): our own endpoint GET /logo/<storageId> (convex/http.ts) with
 * a strict Content-Security-Policy, not the raw storage URL.
 */
export function logoUrl(storageId: string) {
  const site = (process.env.CONVEX_SITE_URL ?? '').replace(/\/+$/, '');
  return `${site}/logo/${storageId}`;
}
