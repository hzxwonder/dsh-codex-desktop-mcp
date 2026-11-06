export const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic';

export function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
    throw new Error('Base URL must be one HTTP or HTTPS URL without line breaks.');
  }
  let url;
  try { url = new URL(value.trim() || DEFAULT_BASE_URL); }
  catch { throw new Error('Base URL must be an absolute HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL must use HTTP or HTTPS without credentials, a query, or a fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export function parseProviderSettings(text) {
  if (!text) return {};
  let settings;
  try { settings = JSON.parse(text); }
  catch { throw new Error('The private settings.json file is not valid JSON.'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('The private settings.json file must contain an object.');
  }
  return settings;
}
