// Viewer page: pick two sources (Wayback captures or the live page), fetch them,
// and render the Text / HTML / Summary comparison.
import {
  normalizeUrl, listSnapshots, fetchSnapshot, wayback, calendar, formatTimestamp, byteLength, SNAPSHOT_LIMIT,
} from '../lib/wayback.js';
import { extractText, formatHtml, summarize } from '../lib/extract.js';
import { computeDiff, diffStats, hunkStarts, renderSplit, renderUnified, inlineDiff, esc } from '../lib/diffview.js';

const DIFF_TIMEOUT_MS = 8000;

const $ = (id) => document.getElementById(id);
const els = {
  url: $('url'), form: $('url-form'), calendar: $('calendar'),
  selA: $('sel-a'), selB: $('sel-b'), swap: $('swap'), compare: $('compare'), refresh: $('refresh-live'),
  metaA: $('meta-a'), metaB: $('meta-b'), stats: $('stats'),
  prev: $('prev-hunk'), next: $('next-hunk'), pos: $('hunk-pos'), notice: $('notice'), out: $('out'),
  ignoreWs: $('opt-ignore-ws'), onlyChanges: $('opt-only-changes'), context: $('opt-context'),
  format: $('opt-format'), collapseScripts: $('opt-collapse-scripts'),
};

const state = {
  url: '',
  tabId: null,
  snapshots: [],
  truncated: false,
  live: null, // capture stored by background.js
  mode: 'text',
  opts: { ignoreWs: false, onlyChanges: true, context: 3, format: true, collapseScripts: false, layout: 'split' },
  sides: { a: null, b: null },
  rows: null,
  rowsKey: '',
  hunks: [],
  hunkIdx: -1,
  expanded: new Set(),
  loadToken: 0,
  notices: [],
};
const snapshotCache = new Map(); // `${timestamp}|${url}` -> Promise<fetchSnapshot result>

// ---------- startup ----------

async function init() {
  const stored = (await chrome.storage.local.get('opts')).opts;
  if (stored) Object.assign(state.opts, stored);
  applyOptsToControls();
  bindEvents();

  const params = new URLSearchParams(location.search);
  state.tabId = Number(params.get('tab')) || null;
  const url = params.get('url') || '';
  els.url.value = url;
  if (params.get('mode')) setMode(params.get('mode'), { render: false });
  if (url) await loadUrl(url, { a: params.get('a'), b: params.get('b') });
  else placeholder('Enter a URL above to list its Wayback Machine captures.');
}

function applyOptsToControls() {
  const o = state.opts;
  els.ignoreWs.checked = o.ignoreWs;
  els.onlyChanges.checked = o.onlyChanges;
  els.context.value = o.context;
  els.format.checked = o.format;
  els.collapseScripts.checked = o.collapseScripts;
  document.querySelectorAll('.layout').forEach((b) => b.classList.toggle('active', b.dataset.layout === o.layout));
}

function saveOpts() {
  chrome.storage.local.set({ opts: state.opts });
}

// ---------- loading ----------

async function loadUrl(input, initial = {}) {
  let url;
  try { url = normalizeUrl(input); } catch (e) { notice(e.message, 'error'); return; }
  state.url = url;
  els.url.value = url;
  els.calendar.href = calendar(url);
  els.calendar.hidden = false;
  document.title = `Wayback Diff · ${url.replace(/^https?:\/\//, '')}`;
  clearNotices();
  state.sides = { a: null, b: null };
  state.rows = null;

  state.live = (await chrome.storage.session.get(`live:${url}`))[`live:${url}`] || null;
  if (state.live?.error) notice(state.live.error);
  else if (state.live?.sourceError) notice(`Live page source could not be fetched (${state.live.sourceError}); only the rendered DOM is available.`);

  placeholder('Loading captures from the Wayback Machine…', true);
  els.selA.innerHTML = els.selB.innerHTML = '';
  try {
    const { snapshots, truncated } = await listSnapshots(url);
    state.snapshots = snapshots;
    state.truncated = truncated;
    if (!snapshots.length) notice('The Wayback Machine has no successful (HTTP 200) captures of this URL.');
    if (truncated) notice(`Showing the newest ${SNAPSHOT_LIMIT} content-changing captures; older ones are omitted.`);
  } catch (e) {
    state.snapshots = [];
    state.truncated = false;
    notice(`Could not list captures: ${e.message}`, 'error');
  }
  fillSelects();
  pickDefaults(initial);
  await compare();
}

function liveOptions() {
  const live = state.live;
  if (!live || live.error) return [];
  const t = live.capturedAt ? new Date(live.capturedAt).toLocaleTimeString() : '';
  const out = [];
  if (live.source != null) out.push({ value: 'live:source', label: `Live — page source (${t})` });
  if (live.dom != null) out.push({ value: 'live:dom', label: `Live — rendered DOM (${t})` });
  return out;
}

function fillSelects() {
  const prev = [els.selA.value, els.selB.value];
  let html = '';
  const live = liveOptions();
  if (live.length) {
    html += `<optgroup label="Live">${live.map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</optgroup>`;
  }
  const byYear = new Map();
  for (const s of state.snapshots) {
    const y = s.timestamp.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(s);
  }
  for (const [year, list] of byYear) {
    html += `<optgroup label="${year} · ${list.length} capture${list.length === 1 ? '' : 's'}">`;
    html += list.map((s) => `<option value="${s.timestamp}">${formatTimestamp(s.timestamp)}</option>`).join('');
    html += '</optgroup>';
  }
  if (!html) html = '<option value="" disabled>No sources available</option>';
  els.selA.innerHTML = html;
  els.selB.innerHTML = html;
  [els.selA.value, els.selB.value] = prev;
}

// Default pairing: newest capture vs live when we have one, else the two newest captures.
function pickDefaults(initial) {
  const values = new Set([...els.selA.options].map((o) => o.value).filter(Boolean));
  const snaps = state.snapshots.map((s) => s.timestamp);
  const live = values.has('live:source') ? 'live:source' : values.has('live:dom') ? 'live:dom' : null;
  let a = values.has(initial.a) ? initial.a : null;
  let b = values.has(initial.b) ? initial.b : null;
  if (!b) b = live && live !== a ? live : snaps.find((s) => s !== a) || null;
  if (!a) a = snaps.find((s) => s !== b) || null;
  els.selA.value = a || '';
  els.selB.value = b || '';
}

async function compare() {
  const va = els.selA.value;
  const vb = els.selB.value;
  if (!va || !vb) { placeholder('Pick a source for each side.'); return; }
  const token = ++state.loadToken;
  placeholder('Fetching both versions…', true);
  els.compare.disabled = true;
  try {
    const [a, b] = await Promise.all([loadSide(va), loadSide(vb)]);
    if (token !== state.loadToken) return; // a newer compare superseded this one
    state.sides = { a, b };
    state.expanded = new Set();
    state.rowsKey = '';
    syncLocation();
    renderMeta();
    render();
  } catch (e) {
    if (token !== state.loadToken) return;
    placeholder('');
    notice(`Fetch failed: ${e.message}`, 'error');
  } finally {
    if (token === state.loadToken) els.compare.disabled = false;
  }
}

async function loadSide(value) {
  if (value.startsWith('live:')) {
    const variant = value.slice(5);
    const live = state.live;
    if (!live || live.error) throw new Error('no live capture — click the extension icon on the page, or use “Refresh live”');
    const html = variant === 'dom' ? live.dom : live.source;
    if (html == null) throw new Error(`live page source unavailable (${live.sourceError || 'not captured'})`);
    return {
      kind: 'live', value, html, variant,
      label: variant === 'dom' ? 'Live — rendered DOM' : 'Live — page source',
      capturedAt: live.capturedAt, status: variant === 'dom' ? null : live.sourceStatus,
      bytes: byteLength(html), url: live.url, derived: {},
    };
  }
  const key = `${value}|${state.url}`;
  if (!snapshotCache.has(key)) {
    snapshotCache.set(key, fetchSnapshot(state.url, value).catch((e) => { snapshotCache.delete(key); throw e; }));
  }
  const snap = await snapshotCache.get(key);
  return {
    kind: 'snapshot', value, html: snap.html,
    label: `Snapshot ${formatTimestamp(snap.timestamp)}`,
    timestamp: snap.timestamp, requested: value, resolvedUrl: snap.resolvedUrl,
    status: snap.status, bytes: snap.bytes, derived: {},
  };
}

// ---------- rendering ----------

function renderMeta() {
  for (const [side, el] of [['a', els.metaA], ['b', els.metaB]]) {
    const s = state.sides[side];
    if (!s) { el.innerHTML = ''; continue; }
    const bits = [`<span class="tag tag-${side}">${side.toUpperCase()}</span>`, esc(s.label)];
    if (s.status != null) bits.push(`HTTP ${s.status}`);
    bits.push(formatBytes(s.bytes));
    if (s.kind === 'snapshot') {
      bits.push(`<a href="${esc(wayback(state.url, s.timestamp))}" target="_blank" rel="noopener">open in Wayback ↗</a>`);
      if (s.timestamp !== s.requested) bits.push(`<span class="warn">nearest capture to ${formatTimestamp(s.requested)}</span>`);
      if (s.resolvedUrl && s.resolvedUrl !== state.url) bits.push(`<span class="warn">archived redirect → ${esc(s.resolvedUrl)}</span>`);
    } else {
      bits.push(`captured ${new Date(s.capturedAt).toLocaleString()}`);
      if (s.url && s.url !== state.url) bits.push(`<span class="warn">captured from ${esc(s.url)}</span>`);
    }
    el.innerHTML = bits.join(' · ');
  }
}

function render() {
  const { a, b } = state.sides;
  if (!a || !b) return;
  document.body.dataset.mode = state.mode;
  if (state.mode === 'summary') { renderSummary(a, b); return; }

  const key = `${state.mode}|${state.opts.ignoreWs}|${state.opts.format}|${state.opts.collapseScripts}`;
  if (state.rowsKey !== key) {
    const rows = computeDiff(derive(a), derive(b), { ignoreWhitespace: state.opts.ignoreWs, timeout: DIFF_TIMEOUT_MS });
    if (!rows) { placeholder('These two versions are too different to diff within the time limit.'); return; }
    state.rows = rows;
    state.rowsKey = key;
    state.hunks = hunkStarts(rows);
    state.hunkIdx = -1;
    state.expanded = new Set();
  }
  renderRows();
}

// The comparable text for a side in the current mode, memoised per side.
function derive(side) {
  const key = state.mode === 'text' ? 'text' : `html|${state.opts.format}|${state.opts.collapseScripts}`;
  if (!(key in side.derived)) {
    side.derived[key] = state.mode === 'text'
      ? extractText(side.html)
      : state.opts.format ? formatHtml(side.html, { collapseScripts: state.opts.collapseScripts }) : side.html;
  }
  return side.derived[key];
}

function renderRows() {
  const opts = { onlyChanges: state.opts.onlyChanges, context: state.opts.context, expanded: state.expanded };
  const table = (state.opts.layout === 'split' ? renderSplit : renderUnified)(state.rows, opts);
  const none = state.hunks.length === 0
    ? `<div class="placeholder">No differences in the ${state.mode === 'text' ? 'extracted text' : 'HTML'}.</div>`
    : '';
  els.out.innerHTML = none + table;
  const st = diffStats(state.rows);
  els.stats.innerHTML = `<span class="plus">+${st.added}</span> <span class="minus">−${st.removed}</span> ~${st.modified} · ${st.total} lines`;
  updateHunkPos();
}

function renderSummary(a, b) {
  const sa = summarize(a.html, state.url);
  const sb = summarize(b.html, state.url);
  let changed = 0;
  const rows = sa.map(([label, va], i) => {
    const vb = sb[i][1];
    const diff = va !== vb;
    if (diff) changed++;
    let ha = va ? esc(va) : '—';
    let hb = vb ? esc(vb) : '—';
    if (diff && va && vb) {
      const inline = inlineDiff(va, vb);
      if (inline) [ha, hb] = inline;
    }
    return `<tr class="${diff ? 'changed' : ''}"><td class="label">${esc(label)}</td>`
      + `<td class="va${va ? '' : ' empty'}">${ha}</td><td class="vb${vb ? '' : ' empty'}">${hb}</td></tr>`;
  });
  els.out.innerHTML = `<table class="summary"><colgroup><col class="label"><col><col></colgroup>`
    + `<thead><tr><th></th><th><span class="tag tag-a">A</span> ${esc(a.label)}</th><th><span class="tag tag-b">B</span> ${esc(b.label)}</th></tr></thead>`
    + `<tbody>${rows.join('')}</tbody></table>`;
  els.stats.textContent = `${changed} of ${sa.length} signals changed`;
  els.pos.textContent = '–';
}

function placeholder(msg, spinner = false) {
  els.out.innerHTML = msg ? `<div class="placeholder${spinner ? ' spinner' : ''}">${esc(msg)}</div>` : '';
  els.stats.textContent = '';
  els.pos.textContent = '–';
}

function notice(msg, kind = 'info') {
  state.notices.push({ msg, kind });
  els.notice.hidden = false;
  els.notice.classList.toggle('error', state.notices.some((n) => n.kind === 'error'));
  els.notice.innerHTML = state.notices.map((n) => `<div>${esc(n.msg)}</div>`).join('');
}

function clearNotices() {
  state.notices = [];
  els.notice.hidden = true;
  els.notice.innerHTML = '';
}

function formatBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

// ---------- change navigation ----------

function gotoHunk(idx) {
  if (!state.hunks.length) return;
  state.hunkIdx = (idx + state.hunks.length) % state.hunks.length;
  const row = document.getElementById(`hunk-${state.hunkIdx}`);
  if (!row) return;
  els.out.querySelectorAll('tr.current').forEach((t) => t.classList.remove('current'));
  row.classList.add('current');
  row.scrollIntoView({ block: 'center' });
  updateHunkPos();
}

function updateHunkPos() {
  const n = state.hunks.length;
  els.pos.textContent = n ? `${state.hunkIdx + 1 || '–'} / ${n}` : '0';
  els.prev.disabled = els.next.disabled = !n;
}

// ---------- live page refresh ----------

async function refreshLive() {
  if (!state.url) return;
  els.refresh.disabled = true;
  try {
    let capture = null;
    if (state.tabId) {
      const res = await chrome.runtime.sendMessage({ type: 'capture-tab', tabId: state.tabId })
        .catch((e) => ({ ok: false, error: e.message }));
      if (res?.ok && res.capture.url === state.url) capture = res.capture;
      else if (res?.ok) notice(`The original tab has moved to ${res.capture.url}; fetching ${state.url} directly instead.`);
    }
    if (!capture) capture = await fetchLiveDirect(state.url);
    state.live = capture;
    fillSelects();
    if (!/^live:/.test(els.selB.value) && !/^live:/.test(els.selA.value)) els.selB.value = liveOptions()[0]?.value || els.selB.value;
    await compare();
  } catch (e) {
    notice(`Could not refresh the live page: ${e.message}`, 'error');
  } finally {
    els.refresh.disabled = false;
  }
}

// Fallback when the originating tab is gone: ask for permission on that origin
// and fetch the page from the extension (raw source only, no rendered DOM).
async function fetchLiveDirect(url) {
  const origin = `${new URL(url).origin}/*`;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) throw new Error(`permission to read ${origin} was declined`);
  const res = await fetch(url, { cache: 'no-store', credentials: 'include' });
  const capture = {
    url, title: '', capturedAt: Date.now(), dom: null,
    source: await res.text(), sourceStatus: res.status, sourceError: null,
  };
  await chrome.storage.session.set({ [`live:${url}`]: capture });
  return capture;
}

// ---------- events ----------

function setMode(mode, { render: doRender = true } = {}) {
  if (!['text', 'html', 'summary'].includes(mode)) return;
  state.mode = mode;
  document.body.dataset.mode = mode;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  syncLocation();
  if (doRender) render();
}

function syncLocation() {
  const params = new URLSearchParams({ url: state.url, mode: state.mode });
  if (state.tabId) params.set('tab', state.tabId);
  if (els.selA.value) params.set('a', els.selA.value);
  if (els.selB.value) params.set('b', els.selB.value);
  history.replaceState(null, '', `?${params}`);
}

// Moves a side's selection to the adjacent capture (options are newest-first),
// skipping over the capture already selected on the other side.
function step(side, dir) {
  const sel = side === 'a' ? els.selA : els.selB;
  const other = side === 'a' ? els.selB : els.selA;
  const opts = [...sel.options].filter((o) => /^\d{14}$/.test(o.value));
  if (!opts.length) return;
  const cur = opts.findIndex((o) => o.value === sel.value);
  const delta = dir === 'older' ? 1 : -1;
  let idx;
  if (cur === -1) { if (dir === 'newer') return; idx = 0; } // from "live", older = newest capture
  else idx = cur + delta;
  if (idx >= 0 && idx < opts.length && opts[idx].value === other.value) idx += delta;
  if (idx < 0 || idx >= opts.length) return;
  sel.value = opts[idx].value;
  compare();
}

function bindEvents() {
  els.form.addEventListener('submit', (e) => { e.preventDefault(); loadUrl(els.url.value); });
  els.selA.addEventListener('change', compare);
  els.selB.addEventListener('change', compare);
  els.compare.addEventListener('click', compare);
  els.refresh.addEventListener('click', refreshLive);
  els.swap.addEventListener('click', () => {
    [els.selA.value, els.selB.value] = [els.selB.value, els.selA.value];
    compare();
  });
  document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => step(b.dataset.side, b.dataset.dir)));
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
  document.querySelectorAll('.layout').forEach((b) => b.addEventListener('click', () => {
    state.opts.layout = b.dataset.layout;
    applyOptsToControls();
    saveOpts();
    if (state.rows) renderRows();
  }));

  // Options that change the diff itself re-run it; display-only ones just re-render.
  const rediff = () => { state.rowsKey = ''; saveOpts(); render(); };
  const redraw = () => { saveOpts(); if (state.rows && state.mode !== 'summary') renderRows(); };
  els.ignoreWs.addEventListener('change', () => { state.opts.ignoreWs = els.ignoreWs.checked; rediff(); });
  els.format.addEventListener('change', () => { state.opts.format = els.format.checked; rediff(); });
  els.collapseScripts.addEventListener('change', () => { state.opts.collapseScripts = els.collapseScripts.checked; rediff(); });
  els.onlyChanges.addEventListener('change', () => { state.opts.onlyChanges = els.onlyChanges.checked; redraw(); });
  els.context.addEventListener('change', () => {
    state.opts.context = Math.max(0, Math.min(50, Number(els.context.value) || 0));
    els.context.value = state.opts.context;
    redraw();
  });

  els.prev.addEventListener('click', () => gotoHunk(state.hunkIdx - 1));
  els.next.addEventListener('click', () => gotoHunk(state.hunkIdx + 1));
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'n' || e.key === 'j') gotoHunk(state.hunkIdx + 1);
    else if (e.key === 'p' || e.key === 'k') gotoHunk(state.hunkIdx - 1);
  });

  // Unfold a collapsed run of unchanged lines, keeping the viewport where it is.
  els.out.addEventListener('click', (e) => {
    const row = e.target.closest('tr.r-skip');
    if (!row) return;
    const top = els.out.scrollTop;
    state.expanded.add(Number(row.dataset.run));
    renderRows();
    els.out.scrollTop = top;
  });
}

init();
