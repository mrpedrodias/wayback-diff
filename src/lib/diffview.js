// Line diff → row model → HTML for side-by-side or unified views.
// Uses the vendored jsdiff UMD build (global `Diff`, loaded by viewer.html).
/* global Diff */

const INLINE_MAX_CHARS = 5000; // skip word-level highlighting on very long lines
const INLINE_MAX_RATIO = 0.6;  // …and when most of a line changed (highlights would be noise)

export function splitLines(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Returns rows of {type: 'equal'|'modify'|'add'|'remove', a, b} where a/b are
// {no, text, html?} (html = inline-highlighted markup for modified lines), or
// null if the diff timed out. Lines are compared on a normalised key but the
// originals from each side are what gets displayed.
export function computeDiff(aText, bText, { ignoreWhitespace = false, timeout = 20000 } = {}) {
  const aLines = splitLines(aText);
  const bLines = splitLines(bText);
  const key = ignoreWhitespace ? (l) => l.replace(/\s+/g, ' ').trim() : (l) => l;
  const parts = Diff.diffArrays(aLines.map(key), bLines.map(key), { timeout });
  if (!parts) return null;

  const rows = [];
  let ai = 0;
  let bi = 0;
  const takeA = () => ({ no: ai + 1, text: aLines[ai++] });
  const takeB = () => ({ no: bi + 1, text: bLines[bi++] });

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      for (let k = 0; k < p.count; k++) rows.push({ type: 'equal', a: takeA(), b: takeB() });
    } else if (p.removed) {
      // jsdiff emits a removal directly before the insertion that replaces it;
      // pair those line by line so they render as modifications.
      const next = parts[i + 1];
      const addCount = next && next.added ? next.count : 0;
      const paired = Math.min(p.count, addCount);
      for (let k = 0; k < paired; k++) rows.push(modifyRow(takeA(), takeB(), ignoreWhitespace));
      for (let k = paired; k < p.count; k++) rows.push({ type: 'remove', a: takeA(), b: null });
      for (let k = paired; k < addCount; k++) rows.push({ type: 'add', a: null, b: takeB() });
      if (addCount) i++;
    } else {
      for (let k = 0; k < p.count; k++) rows.push({ type: 'add', a: null, b: takeB() });
    }
  }
  return rows;
}

function modifyRow(a, b, ignoreWhitespace) {
  const inline = inlineDiff(a.text, b.text, { ignoreWhitespace });
  if (inline) [a.html, b.html] = inline;
  return { type: 'modify', a, b };
}

// Word-level highlight of two strings as [aHtml, bHtml] (with <del>/<ins>), or
// null when the strings are too long or too different for highlights to help.
export function inlineDiff(aText, bText, { ignoreWhitespace = false } = {}) {
  if (aText.length > INLINE_MAX_CHARS || bText.length > INLINE_MAX_CHARS) return null;
  const tokens = ignoreWhitespace ? Diff.diffWords(aText, bText) : Diff.diffWordsWithSpace(aText, bText);
  let changed = 0;
  let aHtml = '';
  let bHtml = '';
  for (const t of tokens) {
    if (t.added) { changed += t.value.length; bHtml += `<ins>${esc(t.value)}</ins>`; }
    else if (t.removed) { changed += t.value.length; aHtml += `<del>${esc(t.value)}</del>`; }
    else { const e = esc(t.value); aHtml += e; bHtml += e; }
  }
  if (changed / Math.max(1, aText.length + bText.length) > INLINE_MAX_RATIO) return null;
  return [aHtml, bHtml];
}

export function diffStats(rows) {
  const s = { added: 0, removed: 0, modified: 0, total: rows.length };
  for (const r of rows) if (r.type !== 'equal') s[r.type === 'add' ? 'added' : r.type === 'remove' ? 'removed' : 'modified']++;
  return s;
}

// Row indexes where a run of changes begins — the "next change" targets.
export function hunkStarts(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type !== 'equal' && (i === 0 || rows[i - 1].type === 'equal')) out.push(i);
  }
  return out;
}

// Decides which rows to show: every row, or changes plus `context` lines around
// them with long unchanged runs folded into a {skip} item. `expanded` holds the
// start indexes of runs the user has unfolded.
function layout(rows, { onlyChanges, context, expanded }) {
  if (!onlyChanges) return rows.map((_, i) => i);
  const items = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type !== 'equal') { items.push(i++); continue; }
    let j = i;
    while (j < rows.length && rows[j].type === 'equal') j++;
    const lead = i === 0 ? 0 : context;
    const trail = j === rows.length ? 0 : context;
    if (expanded.has(i) || j - i <= lead + trail + 1) {
      for (let k = i; k < j; k++) items.push(k);
    } else {
      for (let k = i; k < i + lead; k++) items.push(k);
      items.push({ skip: j - trail - (i + lead), run: i });
      for (let k = j - trail; k < j; k++) items.push(k);
    }
    i = j;
  }
  return items;
}

export function renderSplit(rows, opts) {
  const hunks = new Map(hunkStarts(rows).map((idx, n) => [idx, n]));
  const out = ['<table class="diff split"><colgroup><col class="c-ln"><col><col class="c-ln"><col></colgroup><tbody>'];
  for (const item of layout(rows, opts)) {
    if (typeof item !== 'number') { out.push(skipRow(item, 4)); continue; }
    const r = rows[item];
    const id = hunks.has(item) ? ` id="hunk-${hunks.get(item)}"` : '';
    out.push(`<tr class="r-${r.type}"${id}>${cell(r.a, 'a')}${cell(r.b, 'b')}</tr>`);
  }
  out.push('</tbody></table>');
  return out.join('');
}

export function renderUnified(rows, opts) {
  const hunks = new Map(hunkStarts(rows).map((idx, n) => [idx, n]));
  const out = ['<table class="diff unified"><colgroup><col class="c-ln"><col class="c-ln"><col></colgroup><tbody>'];
  for (const item of layout(rows, opts)) {
    if (typeof item !== 'number') { out.push(skipRow(item, 3)); continue; }
    const r = rows[item];
    const id = hunks.has(item) ? ` id="hunk-${hunks.get(item)}"` : '';
    if (r.type === 'equal') {
      out.push(`<tr class="r-equal"${id}><td class="ln">${r.a.no}</td><td class="ln">${r.b.no}</td><td class="code">${code(r.a)}</td></tr>`);
      continue;
    }
    if (r.a) out.push(`<tr class="r-remove"${id}><td class="ln">${r.a.no}</td><td class="ln"></td><td class="code">${code(r.a)}</td></tr>`);
    if (r.b) out.push(`<tr class="r-add"${r.a ? '' : id}><td class="ln"></td><td class="ln">${r.b.no}</td><td class="code">${code(r.b)}</td></tr>`);
  }
  out.push('</tbody></table>');
  return out.join('');
}

function cell(side, which) {
  if (!side) return `<td class="ln"></td><td class="code empty ${which}"></td>`;
  return `<td class="ln">${side.no}</td><td class="code ${which}">${code(side)}</td>`;
}

function code(side) {
  return side.html !== undefined ? side.html : esc(side.text);
}

function skipRow(item, span) {
  return `<tr class="r-skip" data-run="${item.run}"><td colspan="${span}">⋯ ${item.skip} unchanged line${item.skip === 1 ? '' : 's'} — click to expand</td></tr>`;
}

export function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
