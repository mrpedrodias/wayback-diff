// Wayback Machine client: capture listing via the CDX API and raw snapshot fetches.
// Both need the https://web.archive.org/* host permission (CDX sends no CORS headers).

const CDX = 'https://web.archive.org/cdx/search/cdx';
export const SNAPSHOT_LIMIT = 1500; // newest N content-changing captures per listing

export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter a URL to compare.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs can be looked up in the Wayback Machine.');
  u.hash = '';
  return u.href;
}

// Lists captures newest-first. `collapse=digest` drops consecutive captures whose
// content hash is unchanged, so the list is effectively "versions that differ".
export async function listSnapshots(url, { signal } = {}) {
  const params = new URLSearchParams({
    url,
    output: 'json',
    fl: 'timestamp,statuscode,mimetype,digest',
    filter: 'statuscode:200',
    collapse: 'digest',
    limit: String(-SNAPSHOT_LIMIT),
  });
  const res = await fetch(`${CDX}?${params}`, { signal });
  if (res.status === 429) throw new Error('The Wayback Machine is rate-limiting requests — wait a minute and retry.');
  if (!res.ok) throw new Error(`CDX API returned HTTP ${res.status}`);
  const text = await res.text();
  // No matches comes back as an empty body or a bare `[]` (no header row).
  const parsed = text.trim() ? JSON.parse(text) : [];
  if (!Array.isArray(parsed) || parsed.length < 2) return { snapshots: [], truncated: false };

  const [header, ...rows] = parsed;
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const snapshots = rows
    .map((r) => ({
      timestamp: r[col.timestamp],
      status: r[col.statuscode],
      mime: r[col.mimetype],
      digest: r[col.digest],
    }))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return { snapshots, truncated: snapshots.length >= SNAPSHOT_LIMIT };
}

// Fetches the archived response body untouched (`id_` flag: no Wayback toolbar or
// URL rewriting). Wayback redirects to the nearest capture when the exact timestamp
// doesn't exist, so the resolved timestamp/URL are read back from the final URL.
export async function fetchSnapshot(url, timestamp, { signal } = {}) {
  const res = await fetch(`https://web.archive.org/web/${timestamp}id_/${url}`, { signal });
  if (res.status === 429) throw new Error('The Wayback Machine is rate-limiting requests — wait a minute and retry.');
  if (!res.ok) throw new Error(`Wayback returned HTTP ${res.status} for snapshot ${timestamp}`);
  const html = await res.text();
  const m = res.url.match(/\/web\/(\d{14})id_\/(.*)$/);
  return {
    html,
    status: res.status,
    timestamp: m ? m[1] : timestamp,
    resolvedUrl: m ? m[2] : url,
    bytes: byteLength(html),
  };
}

export function wayback(url, timestamp) {
  return `https://web.archive.org/web/${timestamp}/${url}`;
}

export function calendar(url) {
  return `https://web.archive.org/web/*/${url}`;
}

// "20260608081138" -> "2026-06-08 08:11:38 UTC"
export function formatTimestamp(ts, { seconds = true } = {}) {
  const [Y, M, D, h, m, s] = [ts.slice(0, 4), ts.slice(4, 6), ts.slice(6, 8), ts.slice(8, 10), ts.slice(10, 12), ts.slice(12, 14)];
  return `${Y}-${M}-${D} ${h}:${m}${seconds ? `:${s}` : ''} UTC`;
}

export function byteLength(s) {
  return new TextEncoder().encode(s).length;
}
