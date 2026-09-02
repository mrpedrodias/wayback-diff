"""Headless end-to-end smoke test for the extension.

Loads a throwaway copy of the extension in Chromium via Playwright, simulates the
toolbar click on a live page, and drives the viewer through its modes, printing
what rendered at each step. Exits non-zero if a step fails.

    ~/Workspace/.venv/bin/python scripts/e2e-smoke.py [url]

The copy gets `tabs` + `<all_urls>` added because `activeTab` can only be granted by
a real click; `bypass_csp` lets Playwright's own helpers run on extension pages.
"""
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

SRC = Path(__file__).resolve().parent.parent
TARGET = sys.argv[1] if len(sys.argv) > 1 else 'https://www.mariehaynes.com/'


def main():
    tmp = Path(tempfile.mkdtemp(prefix='wayback-diff-e2e-'))
    ext = tmp / 'ext'
    shutil.copytree(SRC, ext, ignore=shutil.ignore_patterns('node_modules', '.git', '*.zip'))
    manifest = json.loads((ext / 'manifest.json').read_text())
    manifest['permissions'].append('tabs')
    manifest['host_permissions'].append('<all_urls>')
    (ext / 'manifest.json').write_text(json.dumps(manifest))

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(tmp / 'profile'), headless=True, channel='chromium', bypass_csp=True,
            args=[f'--disable-extensions-except={ext}', f'--load-extension={ext}'],
        )
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker')
        ext_id = sw.url.split('/')[2]
        base = f'chrome-extension://{ext_id}/src/viewer/viewer.html'

        page = ctx.new_page()
        page.goto(TARGET, wait_until='domcontentloaded')
        time.sleep(1)
        sw.evaluate("""async () => {
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            chrome.action.onClicked.dispatch(tab);
        }""")
        time.sleep(2)
        tabs = sw.evaluate('async () => (await chrome.tabs.query({})).map(t => t.url)')
        viewer_url = next((u for u in tabs if u.startswith(base)), None)
        assert viewer_url, f'viewer tab did not open: {tabs}'
        print('click flow ok →', viewer_url)

        # Playwright doesn't surface chrome-extension:// tabs, so drive a copy.
        v = ctx.new_page()
        v.on('pageerror', lambda e: print('  [pageerror]', e))
        v.goto(viewer_url)

        def state(label):
            info = v.evaluate("""() => ({
                notice: document.getElementById('notice').innerText,
                a: document.getElementById('meta-a').innerText,
                b: document.getElementById('meta-b').innerText,
                stats: document.getElementById('stats').innerText,
                rows: document.querySelectorAll('#out tr').length,
            })""")
            print(f'--- {label}\n' + json.dumps(info, indent=1, ensure_ascii=False))
            return info

        v.wait_for_selector('#out table, #notice.error:not([hidden])', timeout=90000)
        time.sleep(0.5)
        assert 'Live' in state('text: newest capture vs live')['b']

        v.click('.tab[data-mode="html"]')
        v.wait_for_selector('#out table.diff', timeout=60000)
        assert state('html')['rows'] > 0

        v.click('.tab[data-mode="summary"]')
        v.wait_for_selector('#out table.summary')
        assert 'signals' in state('summary')['stats']

        v.click('.tab[data-mode="text"]')
        v.wait_for_selector('#out table.diff')
        v.click('#next-hunk')
        v.click('.layout[data-layout="unified"]')
        state('text unified, after next')

        v.click('.step[data-side="b"][data-dir="older"]')
        v.wait_for_function("() => document.getElementById('meta-b').innerText.includes('Snapshot')", timeout=90000)
        v.wait_for_selector('#out table.diff', timeout=90000)
        time.sleep(0.3)
        assert 'Snapshot' in state('snapshot vs snapshot')['b']

        v.click('#refresh-live')
        v.wait_for_function("() => document.getElementById('meta-b').innerText.includes('Live')", timeout=60000)
        time.sleep(0.5)
        assert 'Live' in state('after refresh live')['b']

        v.goto(f'{base}?url=https://example.com/never-archived-{int(time.time())}')
        v.wait_for_selector('#notice:not([hidden])', timeout=60000)
        assert 'no successful' in state('no captures')['notice']

        ctx.close()
    shutil.rmtree(tmp, ignore_errors=True)
    print('all steps passed')


if __name__ == '__main__':
    main()
