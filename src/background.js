// Service worker. Clicking the toolbar icon captures the live page (raw source +
// rendered DOM) from the active tab, parks it in session storage and opens the
// viewer. The viewer can later ask for a fresh capture of the same tab.

const MAX_CAPTURES = 6; // session storage is capped at 10 MB; keep the newest few pages

chrome.action.onClicked.addListener(async (tab) => {
  const url = stripHash(tab.url || '');
  let capture;
  if (/^https?:\/\//i.test(url)) {
    try {
      capture = await captureTab(tab.id);
    } catch (e) {
      capture = { url, error: `Could not read the page: ${errorMessage(e)}` };
    }
  } else {
    capture = { url, error: 'Only http(s) pages can be captured. Enter a URL to compare snapshots.' };
  }
  await storeCapture(capture);

  const params = new URLSearchParams({ url: capture.url || url, tab: String(tab.id) });
  await chrome.tabs.create({
    url: `${chrome.runtime.getURL('src/viewer/viewer.html')}?${params}`,
    index: tab.index + 1,
    openerTabId: tab.id,
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'capture-tab') return false;
  captureTab(msg.tabId)
    .then(storeCapture)
    .then((capture) => sendResponse({ ok: true, capture }))
    .catch((e) => sendResponse({ ok: false, error: errorMessage(e) }));
  return true; // async response
});

async function captureTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: grabPage });
  if (!result) throw new Error('empty result from page');
  result.url = stripHash(result.url);
  result.tabId = tabId;
  return result;
}

// Runs inside the page (serialised by executeScript, so it must be self-contained).
// `dom` is the rendered document; `source` is the server response for the same URL,
// re-fetched with the page's cookies so it matches what Wayback would have archived.
async function grabPage() {
  const dt = document.doctype;
  const doctype = dt
    ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${dt.systemId ? ` "${dt.systemId}"` : ''}>\n`
    : '';
  const out = {
    url: location.href,
    title: document.title,
    capturedAt: Date.now(),
    dom: doctype + document.documentElement.outerHTML,
    source: null,
    sourceStatus: null,
    sourceError: null,
  };
  try {
    const res = await fetch(location.href, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    out.sourceStatus = res.status;
    out.source = await res.text();
  } catch (e) {
    out.sourceError = String(e && e.message || e);
  }
  return out;
}

async function storeCapture(capture) {
  const key = `live:${capture.url}`;
  const all = await chrome.storage.session.get(null);
  const others = Object.keys(all)
    .filter((k) => k.startsWith('live:') && k !== key)
    .sort((a, b) => (all[a].capturedAt || 0) - (all[b].capturedAt || 0));
  const evict = others.slice(0, Math.max(0, others.length - (MAX_CAPTURES - 1)));
  if (evict.length) await chrome.storage.session.remove(evict);
  try {
    await chrome.storage.session.set({ [key]: capture });
  } catch (e) {
    // Quota exceeded: drop everything else and retry once.
    await chrome.storage.session.remove(others);
    await chrome.storage.session.set({ [key]: capture });
  }
  return capture;
}

function stripHash(url) {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

function errorMessage(e) {
  return (e && e.message) || String(e);
}
