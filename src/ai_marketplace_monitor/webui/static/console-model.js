// Config and activity contracts shared with the native Node regression checks.
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
export const own = (obj, key) => Object.hasOwn(obj || {}, key);
export const filled = value => value != null && value !== '' && (!Array.isArray(value) || value.length > 0);
export function mergeConfig(base, override) {
  const result = structuredClone(base || {});
  for (const [key, value] of Object.entries(override || {})) {
    if (own(result, key) && Array.isArray(result[key]) && Array.isArray(value)) result[key] = [...result[key], ...value];
    else if (value && typeof value === 'object' && !Array.isArray(value)) result[key] = mergeConfig(result[key], value);
    else Object.defineProperty(result, key, {value: structuredClone(value), enumerable: true, configurable: true, writable: true});
  }
  return result;
}
const defaults = {rating: 3, search_interval: '30m', max_search_interval: '60m', availability: 'all', date_listed: 0, delivery_method: 'all', sort_by: 'suggested'};
export function marketplaceFor(config, name) {
  return config.item?.[name]?.marketplace || Object.keys(config.marketplace || {})[0];
}
export function itemValue(config, name, key) {
  const item = config.item?.[name] || {};
  const market = config.marketplace?.[marketplaceFor(config, name)] || {};
  // AI and prompt fields treat explicit empty values differently from filters.
  const nullable = ['ai', 'prompt', 'extra_prompt', 'rating_prompt'];
  for (const section of [item, market]) {
    if (own(section, key) && (nullable.includes(key) || filled(section[key]))) return section[key];
  }
  if (key === 'marketplace') return marketplaceFor(config, name);
  if (key === 'notify') return Object.keys(config.user || {});
  if (key === 'ai') return Object.keys(config.ai || {}).filter(n => config.ai[n].enabled !== false);
  return defaults[key];
}
export function seconds(value) {
  if (typeof value === 'number') return value;
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?|d|days?)$/i);
  if (!match) return null;
  const scale = {s:1,m:60,h:3600,d:86400}[match[2][0].toLowerCase()];
  return Number(match[1]) * scale;
}
const duration = value => {
  const n = seconds(value);
  return n == null ? String(value) : n % 3600 === 0 ? `${n / 3600}h` : n % 60 === 0 ? `${n / 60}m` : `${n}s`;
};
export function scheduleLabel(config, name) {
  const times = itemValue(config, name, 'start_at');
  if (filled(times)) return `at ${list(times).join(', ')}`;
  const low = itemValue(config, name, 'search_interval');
  const high = itemValue(config, name, 'max_search_interval');
  const lowSeconds = seconds(low), highSeconds = seconds(high);
  return lowSeconds != null && highSeconds != null && highSeconds > lowSeconds ? `${duration(low)}–${duration(high)}, random` : duration(low);
}
export const CHANNELS = {
  Telegram: ['telegram_token', 'telegram_chat_id'],
  Email: ['email', 'smtp_password'],
  Pushbullet: ['pushbullet_token'],
  Pushover: ['pushover_user_key', 'pushover_api_token'],
  ntfy: ['ntfy_server', 'ntfy_topic'],
};
export function resolvedUser(config, name) {
  const user = {...config.user?.[name]};
  for (const sectionName of list(user.notify_with ?? Object.keys(config.notification || {}))) {
    const shared = config.notification_values?.[sectionName] || config.notification?.[sectionName];
    if (!shared || shared.enabled === false) continue;
    for (const [key, value] of Object.entries(shared)) if (value != null && !['name','type'].includes(key)) user[key] = value;
  }
  return user;
}
export function available(value, environment = {}) {
  if (typeof value === 'string' && /^\$\{\w+\}$/.test(value)) return environment[value.slice(2,-1)] === true;
  return filled(value);
}
export function userChannels(config, name, environment = {}) {
  const user = resolvedUser(config, name);
  return Object.keys(CHANNELS).filter(channel => CHANNELS[channel].every(key => available(user[key], environment)));
}
export function matchRecord(record, filters = {}) {
  const extra = record.extra || {};
  if (filters.kind && extra.kind !== filters.kind) return false;
  if (filters.item && extra.item !== filters.item) return false;
  if (filters.level && record.levelno < ({INFO:20, WARNING:30, ERROR:40}[filters.level] || 0)) return false;
  if (filters.score && (extra.score == null || extra.score < Number(filters.score))) return false;
  return !filters.text || String(record.message).toLowerCase().includes(filters.text.toLowerCase());
}
export function mergeRecords(current, incoming, capacity) {
  const byId = new Map(current.map(record => [record.id, record]));
  for (const record of incoming) byId.set(record.id, record);
  return [...byId.values()].sort((a,b) => a.id - b.id).slice(-capacity);
}
export function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export function renameSection(content, prefix, oldName, newName) {
  // Change only the header; field edits continue through toml_edit.
  const pattern = new RegExp(`^(\\s*\\[${prefix}\\.)(?:${oldName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}|"${oldName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}")(\\][ \t]*(?:#.*)?)$`, 'm');
  if (!pattern.test(content)) throw new Error('This section name needs to be renamed in config.toml.');
  return content.replace(pattern, `$1${newName}$2`);
}

export function matchPhotoUrl(row, photo = row.photos?.[0]) {
  if (!row.marketplace || !row.listing_id || !/^[a-f0-9]{64}$/.test(photo?.digest || '')) return null;
  return `/api/matches/${encodeURIComponent(row.marketplace)}/${encodeURIComponent(row.listing_id)}/photos/${photo.digest}.webp`;
}
