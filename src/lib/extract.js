// HTML → comparable forms: readable text, one-node-per-line HTML, and an SEO summary.
// Everything goes through DOMParser, which never runs scripts or loads resources.

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'hr', 'legend', 'li', 'main', 'nav', 'ol', 'option', 'p', 'section', 'summary', 'table', 'tbody', 'tfoot',
  'thead', 'title', 'tr', 'ul',
]);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'map']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'pre', 'textarea']);
const HEADING_PREFIX = { h1: '# ', h2: '## ', h3: '### ', h4: '#### ', h5: '##### ', h6: '###### ' };

export function parseHtml(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

// Visible text, one block element per line. Headings keep a markdown-style
// prefix and list items a bullet so structural changes remain visible.
export function extractText(html) {
  const doc = parseHtml(html);
  const lines = [];
  let cur = '';
  const flush = () => {
    const t = cur.replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
    cur = '';
  };
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { cur += node.nodeValue; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.localName;
    if (SKIP.has(tag) || isHidden(node)) return;
    if (tag === 'br') { flush(); return; }
    if (tag === 'pre' || tag === 'textarea') {
      flush();
      for (const l of node.textContent.split(/\r?\n/)) if (l.trim()) lines.push(l.trimEnd());
      return;
    }
    const block = BLOCK.has(tag);
    if (block) flush();
    if (HEADING_PREFIX[tag]) cur += HEADING_PREFIX[tag];
    else if (tag === 'li') cur += '- ';
    else if ((tag === 'td' || tag === 'th') && cur.trim()) cur += ' | ';
    for (const child of node.childNodes) walk(child);
    if (block) flush();
  };
  walk(doc.documentElement);
  flush();
  return lines.join('\n');
}

function isHidden(el) {
  if (el.hasAttribute('hidden')) return true;
  const style = el.getAttribute('style');
  return !!style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}

// Re-serialises the document with one node per line so minified markup diffs
// line by line. `collapseScripts` replaces inline script/style bodies (but not
// JSON-LD) with a placeholder, hiding nonces and app state that churn on every load.
export function formatHtml(html, { collapseScripts = false } = {}) {
  const doc = parseHtml(html);
  const out = [];
  const dt = doc.doctype;
  if (dt) out.push(`<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${dt.systemId ? ` "${dt.systemId}"` : ''}>`);

  const walk = (node, depth) => {
    const pad = '  '.repeat(depth);
    switch (node.nodeType) {
      case Node.ELEMENT_NODE: {
        const tag = node.localName;
        out.push(`${pad}<${tag}${serializeAttrs(node)}>`);
        if (VOID.has(tag)) return;
        if (RAW_TEXT.has(tag)) {
          const text = node.textContent;
          if (text.trim()) {
            const isCode = tag === 'script' || tag === 'style';
            const isJsonLd = tag === 'script' && /ld\+json/i.test(node.getAttribute('type') || '');
            if (collapseScripts && isCode && !isJsonLd) out.push(`${pad}  /* … ${text.length} chars … */`);
            else for (const l of text.replace(/\r\n?/g, '\n').split('\n')) if (l.trim()) out.push(`${pad}  ${l.trimEnd()}`);
          }
        } else {
          for (const child of node.childNodes) walk(child, depth + 1);
        }
        out.push(`${pad}</${tag}>`);
        return;
      }
      case Node.TEXT_NODE: {
        const t = node.nodeValue.replace(/\s+/g, ' ').trim();
        if (t) out.push(pad + escapeText(t));
        return;
      }
      case Node.COMMENT_NODE: {
        const parts = node.nodeValue.replace(/\r\n?/g, '\n').split('\n');
        out.push(`${pad}<!--${parts[0]}${parts.length === 1 ? '-->' : ''}`);
        for (let i = 1; i < parts.length; i++) out.push(`${pad}${parts[i]}${i === parts.length - 1 ? '-->' : ''}`);
        return;
      }
      default:
    }
  };
  walk(doc.documentElement, 0);
  return out.join('\n');
}

function serializeAttrs(el) {
  let s = '';
  for (const { name, value } of el.attributes) {
    s += value === '' ? ` ${name}` : ` ${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
  }
  return s;
}

function escapeText(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Key on-page SEO signals as [label, value] rows, in a fixed order so two
// summaries line up row for row.
export function summarize(html, baseUrl) {
  const doc = parseHtml(html);
  const q = (sel) => doc.querySelector(sel);
  const attr = (sel, name) => (q(sel)?.getAttribute(name) || '').trim();
  const meta = (name) => attr(`meta[name="${name}" i]`, 'content');
  const prop = (name) => attr(`meta[property="${name}" i]`, 'content');
  const clean = (s) => s.replace(/\s+/g, ' ').trim();

  const words = extractText(html).split(/\s+/).filter(Boolean).length;

  let internal = 0, external = 0, nofollow = 0;
  const host = safeHost(baseUrl);
  for (const a of doc.querySelectorAll('a[href]')) {
    try {
      const u = new URL(a.getAttribute('href'), baseUrl);
      if (!/^https?:$/.test(u.protocol)) continue;
      if (u.host === host) internal++; else external++;
      if (/\bnofollow\b/i.test(a.getAttribute('rel') || '')) nofollow++;
    } catch { /* unparseable href */ }
  }

  const ldTypes = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json" i]')) {
    try {
      const j = JSON.parse(s.textContent);
      const nodes = Array.isArray(j) ? j : j?.['@graph'] || [j];
      for (const n of nodes) if (n?.['@type']) ldTypes.push([].concat(n['@type']).join('/'));
    } catch { ldTypes.push('(invalid JSON)'); }
  }

  return [
    ['Title', clean(q('title')?.textContent || '')],
    ['Meta description', meta('description')],
    ['Meta robots', meta('robots')],
    ['Canonical', attr('link[rel="canonical" i]', 'href')],
    ['Language', doc.documentElement.getAttribute('lang') || ''],
    ['OG title', prop('og:title')],
    ['OG description', prop('og:description')],
    ['H1', [...doc.querySelectorAll('h1')].map((h) => clean(h.textContent)).join(' ‖ ')],
    ['H2 count', String(doc.querySelectorAll('h2').length)],
    ['Words (visible text)', String(words)],
    ['Links internal / external', `${internal} / ${external}`],
    ['Links rel=nofollow', String(nofollow)],
    ['Images', String(doc.querySelectorAll('img').length)],
    ['Hreflang links', String(doc.querySelectorAll('link[rel="alternate" i][hreflang]').length)],
    ['JSON-LD types', ldTypes.join(', ')],
    ['HTML bytes', String(new TextEncoder().encode(html).length)],
  ];
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return ''; }
}
