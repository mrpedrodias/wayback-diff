# Wayback Diff

Chrome extension that compares any web page against its [Wayback Machine](https://web.archive.org/) captures — or two captures against each other — as a side-by-side diff of the **readable text**, the **HTML**, and a table of **on-page SEO signals**.

One click on the toolbar icon captures the page you're on, lists every capture the Wayback Machine holds for that URL, and diffs the newest capture against the live page. From there you can pick any two versions.

No build step, no bundler, no accounts: plain Manifest V3 with a single vendored dependency ([jsdiff](https://github.com/kpdecker/jsdiff)).

---

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder (`~/Workspace/wayback-diff`).
3. Pin **Wayback Diff** from the puzzle-piece menu so the icon is on the toolbar.

To pick up code changes, hit the ↻ reload button on the extension's card in `chrome://extensions`, then reload any open viewer tabs.

`npm run zip` packs `manifest.json`, `icons/` and `src/` into `wayback-diff.zip` if you want to hand the extension to someone else.

## Using it

- **Toolbar icon** (or `Alt+Shift+W`) on any http(s) page → a viewer tab opens next to it. The default comparison is **A = newest capture**, **B = live page**.
- **A / B selectors** list the live page first, then captures grouped by year. ◀ ▶ step to the older / newer capture; ⇄ swaps sides. Changing either side re-runs the comparison.
- **Text** — visible text only, one line per block element. Headings keep a `#`-style prefix and list items a `-` so structural changes still show. Changed lines get word-level highlights.
- **HTML** — the markup, pretty-printed one node per line so that minified pages diff line by line (untick **Pretty-print HTML** to diff the raw bytes). **Collapse scripts** hides inline `<script>`/`<style>` bodies — the nonces and app state that churn on every load — while keeping JSON-LD.
- **Summary** — title, meta description, meta robots, canonical, `lang`, Open Graph title/description, H1s, H2 count, word count, internal/external/nofollow link counts, images, hreflang links, JSON-LD types and byte size for both sides, with changed rows highlighted.
- **Only changes** folds unchanged runs (click a fold to expand); **Context** is the number of unchanged lines kept around each change. **Ignore whitespace** compares lines with whitespace collapsed. **Split / Unified** switches layout.
- ▲ ▼ (or `p` / `n`, `k` / `j`) jump between changes.
- **Refresh live** re-captures the page from its original tab. If that tab has navigated away or been closed, the extension asks for permission to read that site directly and fetches the page itself.
- The URL box accepts any address, so you can diff captures of a page you're not currently on. Snapshot-vs-snapshot never touches the live site.
- The viewer's own URL carries `url`, `a`, `b` and `mode`, so it can be reloaded, bookmarked or shared with someone who has the extension.

### What "live" means

Two live variants are captured when you click the icon:

| Variant | What it is | Compare it with a capture when… |
|---|---|---|
| **Live — page source** | The HTML the server returned, re-fetched from inside the tab with your cookies | …you want an apples-to-apples diff — Wayback stores server responses, not rendered DOMs |
| **Live — rendered DOM** | `document.documentElement.outerHTML` after JavaScript ran | …you want to see what JS injects (tags, personalisation, consent banners) |

Comparing **page source ↔ rendered DOM** of the same live page is a quick way to see everything client-side scripts add or change.

Each side's line under the selectors shows the HTTP status, size, and — for captures — a link to open that capture in the Wayback Machine, plus a warning when Wayback served the *nearest* capture instead of the exact timestamp or replayed an archived redirect.

## How it works

- **Capture listing** — the [CDX API](https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server) with `filter=statuscode:200` and `collapse=digest`, so consecutive captures whose content hash didn't change are folded into one: the list is effectively "versions that differ". The newest 1,500 are loaded; a notice says if older ones were cut off.
- **Capture content** — `https://web.archive.org/web/<timestamp>id_/<url>`. The `id_` flag returns the archived response byte-for-byte, without the Wayback toolbar or rewritten URLs. Wayback redirects inexact timestamps to the nearest capture; the resolved timestamp is read back from the final URL.
- **Live capture** — `chrome.scripting.executeScript` runs a function in the page (allowed by the one-off `activeTab` grant the click gives) that returns the rendered DOM and `fetch(location.href)` from the page's own origin. Results are parked in `chrome.storage.session` (newest six pages kept) and read by the viewer.
- **Diffing** — lines are diffed with jsdiff (`diffArrays` over per-line keys, so whitespace-insensitive mode still displays the originals), removals are paired with the insertions that replace them and given `diffWords` highlights, and long unchanged runs are folded at render time. Everything renders as one table, so the two columns stay aligned even when lines wrap.
- **Text extraction / formatting** — `DOMParser` (never executes scripts or loads resources), skipping `script`, `style`, `noscript`, `template`, `svg`, `iframe`, and elements hidden via `hidden` or inline `display:none`.

### Permissions

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Read the page you clicked on — only that tab, only after your click |
| `storage` | Keep captures for the viewer (session) and your option toggles (local) |
| `https://web.archive.org/*` | CDX API and capture bodies (no CORS headers, so a host permission is required) |
| optional `http(s)://*/*` | Requested per-site, and only if you press **Refresh live** after the original tab is gone |

## Development

```
manifest.json          MV3 manifest
src/background.js      service worker: toolbar click → capture → open viewer; re-capture on request
src/viewer/            the viewer page (viewer.html / .css / .js)
src/lib/wayback.js     CDX listing, id_ fetches, timestamp helpers
src/lib/extract.js     text extraction, HTML pretty-printer, SEO summary
src/lib/diffview.js    row model, inline highlights, split/unified renderers
src/vendor/diff.js     jsdiff UMD build (committed; regenerate with `npm run vendor`)
scripts/make-icons.mjs draws icons/*.png with no dependencies (`npm run icons`)
scripts/e2e-smoke.py  headless Playwright end-to-end check (see below)
```

`npm install` is only needed to refresh the vendored jsdiff (`npm run vendor`) — the extension itself loads straight from the checkout.

`scripts/e2e-smoke.py` is a headless end-to-end check (`~/Workspace/.venv/bin/python scripts/e2e-smoke.py [url]`): it loads a throwaway copy of the extension in Chromium via Playwright, simulates the toolbar click, and walks the viewer through every mode. The copy gets `tabs` + `<all_urls>` added because `activeTab` can only be granted by a real click, and Playwright runs with `bypass_csp` so its own helpers work on extension pages.

## Limitations

- Wayback rate-limits bursts of requests; the viewer reports a 429 and you can retry after a moment.
- Very large pages diff in well under a second, but a diff that would take more than 8 s is abandoned with a message rather than freezing the tab.
- The `id_` body is decoded using the archived `Content-Type`; captures of very old pages with a wrong or missing charset may show mojibake.
- "Live — page source" re-fetches the URL from inside the page, so sites that vary content per request (A/B tests, rotating honeypot fields, nonces) will show those differences — **Collapse scripts** and the Text view are the quick way past that noise.
