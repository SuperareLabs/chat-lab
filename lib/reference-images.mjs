import { isIP } from 'node:net';

const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 180;
const SPECIAL_SUFFIXES = new Set([
  'localhost', 'local', 'internal', 'localdomain', 'localnet',
  'home', 'lan', 'corp', 'mail', 'intranet', 'private',
  'test', 'invalid', 'example', 'onion', 'alt', 'arpa',
]);

function publicUrl(value, protocols) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH ||
      /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!protocols.includes(url.protocol) || url.username || url.password) return null;
  // Also reject an explicitly empty userinfo section, which URL removes.
  const authority = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu)?.[1];
  if (!authority || authority.includes('@')) return null;

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  const ip = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (!hostname || isIP(ip) || hostname.length > 253) return null;
  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some(label => label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) return null;
  const suffix = labels.at(-1);
  if (!/[a-z]/u.test(suffix) || SPECIAL_SUFFIXES.has(suffix)) return null;

  // This is a syntactic public-domain filter, not a DNS reachability check.
  // It never fetches a URL or resolves a domain (including image URLs).
  url.hostname = hostname;
  return url.href.length <= MAX_URL_LENGTH ? url.href : null;
}

function boundedTitle(value) {
  if (typeof value !== 'string') return '';
  const title = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const bounded = title.slice(0, MAX_TITLE_LENGTH);
  // Keep the UTF-16 length bound without returning half of an emoji.
  return /[\ud800-\udbff]$/u.test(bounded) ? bounded.slice(0, -1) : bounded;
}

/** Normalize one provider-supplied image reference; no network or ID creation. */
export function normalizeReferenceImage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const imageUrl = publicUrl(value.imageUrl, ['https:']);
  const sourceUrl = publicUrl(value.sourceUrl, ['http:', 'https:']);
  if (!imageUrl || !sourceUrl) return null;
  return {
    type: 'reference_image', imageUrl, sourceUrl, title: boundedTitle(value.title),
    ...(Number.isSafeInteger(value.width) && value.width > 0 ? { width: value.width } : {}),
    ...(Number.isSafeInteger(value.height) && value.height > 0 ? { height: value.height } : {}),
  };
}
