// ── Discover local businesses that have a website, from OpenStreetMap ──
// Free, no API key. Two public services are used:
//   1. Nominatim  — turns a place name ("Venlo", "Jordaan Amsterdam") into a bounding box
//   2. Overpass   — lists businesses inside that box that carry a `website` tag
// Both ask for a descriptive User-Agent and are rate-limited, so this is meant for
// occasional interactive use, not bulk crawling.

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// Several interchangeable Overpass mirrors. The main one is often overloaded and will
// drop the connection rather than answer, so we try the next mirror when that happens.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const UA = 'LeadGenerator/1.1 (local lead-generation tool)';

class DiscoverError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// Business categories → Overpass tag selectors. Every selector also requires a
// `website` tag, so we only ever return businesses we can actually scan.
const CATEGORIES = {
  all: ['["name"]["website"]'],
  shop: ['["shop"]["website"]'],
  food: ['["amenity"~"^(restaurant|cafe|bar|fast_food|pub|ice_cream|biergarten)$"]["website"]'],
  craft: ['["craft"]["website"]'],
  office: ['["office"]["website"]'],
  health: ['["healthcare"]["website"]', '["amenity"~"^(doctors|dentist|pharmacy|clinic|veterinary)$"]["website"]'],
};

// Place name → bounding box via Nominatim
async function geocode(area) {
  const url = NOMINATIM + '?format=jsonv2&limit=1&q=' + encodeURIComponent(area);
  let r;
  try {
    r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'nl,en' }, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new DiscoverError('geocode_failed', 'Could not reach the location service.');
  }
  if (!r.ok) throw new DiscoverError('geocode_failed', `Location lookup failed (HTTP ${r.status}).`);
  const list = await r.json().catch(() => null);
  if (!Array.isArray(list) || !list.length) throw new DiscoverError('area_not_found', `No place found for "${area}".`);
  const hit = list[0];
  // Nominatim boundingbox order is [south, north, west, east]
  const bb = (hit.boundingbox || []).map(Number);
  if (bb.length !== 4 || bb.some(Number.isNaN)) throw new DiscoverError('area_not_found', 'That place has no usable area.');
  return { south: bb[0], north: bb[1], west: bb[2], east: bb[3], displayName: hit.display_name || area };
}

// One Overpass request to one endpoint. Throws a DiscoverError tagged 'overpass_busy'
// for problems that another mirror or a retry might solve, 'overpass_failed' otherwise.
async function overpassOnce(endpoint, query) {
  let r;
  try {
    r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(28000),
    });
  } catch {
    // Connection reset/refused/timeout — an overloaded mirror drops the connection like this
    throw new DiscoverError('overpass_busy', 'The OpenStreetMap data service is busy right now.');
  }
  // 429 (rate limit) and 5xx (gateway/overload) are worth trying elsewhere
  if (r.status === 429 || r.status >= 500) throw new DiscoverError('overpass_busy', `The OpenStreetMap data service is busy (HTTP ${r.status}).`);
  if (!r.ok) throw new DiscoverError('overpass_failed', `OpenStreetMap data request failed (HTTP ${r.status}).`);
  const data = await r.json().catch(() => null);
  if (!data || !Array.isArray(data.elements)) throw new DiscoverError('overpass_failed', 'Unexpected response from the data service.');
  return data.elements;
}

// Bounding box → list of OSM elements with a website tag.
// Queries every mirror at once and takes the first that answers, so one healthy
// mirror is enough and a stuck one never holds up the result.
async function overpass(bbox, selectors, limit) {
  const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const body = selectors.map(sel => `nwr${sel}(${box});`).join('');
  const query = `[out:json][timeout:25];(${body});out center tags ${limit};`;

  try {
    return await Promise.any(OVERPASS_ENDPOINTS.map(e => overpassOnce(e, query)));
  } catch (err) {
    // Promise.any only rejects when every mirror failed (AggregateError)
    const errors = (err && err.errors) || [];
    const hardFail = errors.find(e => e instanceof DiscoverError && e.code === 'overpass_failed');
    const anyBusy = errors.some(e => e instanceof DiscoverError && e.code === 'overpass_busy');
    // A real failure (e.g. a malformed query) is only meaningful if nothing was merely busy
    if (hardFail && !anyBusy) throw hardFail;
    throw new DiscoverError('overpass_busy', 'The OpenStreetMap data service is busy right now. Try again in a minute.');
  }
}

// A website tag can hold several addresses or a bare domain; take the first and make it a valid URL
function cleanWebsite(raw) {
  let v = String(raw || '').trim().split(/[\s;,]/)[0].trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
    return u.href;
  } catch {
    return null;
  }
}

function hostKey(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return String(url).toLowerCase(); }
}

// A short human label for what kind of business this is
function labelFor(tags) {
  const v = tags.shop || tags.craft || tags.office || tags.healthcare || tags.amenity || tags.tourism || tags.leisure;
  return v && v !== 'yes' ? String(v).replace(/_/g, ' ') : null;
}

async function discoverBusinesses({ area, type = 'all', limit = 120 } = {}) {
  area = String(area || '').trim();
  if (!area) throw new DiscoverError('no_area', 'Enter a town, city or neighbourhood.');
  const selectors = CATEGORIES[type] || CATEGORIES.all;

  const bbox = await geocode(area);
  // Guard against accidentally querying a whole province or country, which would hammer Overpass
  const span = Math.abs(bbox.north - bbox.south) * Math.abs(bbox.east - bbox.west);
  if (span > 1.5) throw new DiscoverError('area_too_large', 'That area is too large. Try a specific town, city or neighbourhood.');

  const elements = await overpass(bbox, selectors, Math.min(Number(limit) || 120, 300));

  const seen = new Set();
  const results = [];
  for (const el of elements) {
    const tags = el.tags || {};
    const url = cleanWebsite(tags.website || tags['contact:website']);
    if (!url) continue;
    const key = hostKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      name: tags.name || tags.brand || key,
      url,
      phone: (tags.phone || tags['contact:phone'] || '').trim() || null,
      email: (tags.email || tags['contact:email'] || '').trim() || null,
      category: labelFor(tags),
      city: tags['addr:city'] || null,
      lat: el.lat ?? (el.center && el.center.lat) ?? null,
      lon: el.lon ?? (el.center && el.center.lon) ?? null,
    });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));

  return { area: { query: area, displayName: bbox.displayName }, count: results.length, results };
}

module.exports = { discoverBusinesses, DiscoverError };
