# 实验室页面验证（一次性脚本，不入文档）：分支标签 + 订阅倒计时实时跳动。
# 倒计时走页面侧 fetch stub 喂合成 resets_at（只动测试浏览器，不动服务器与代码）。
import json, time
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:3090'
SESSIONS = BASE + '/cc/api/sessions'

STUB = """
window.__usageCalls = 0;
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.indexOf('/cc/api/sessions/') >= 0 && url.endsWith('/usage')) {
    window.__usageCalls += 1;
    const five = Date.now() + 125000;           // 2m05s -> "2m"，70 秒后跨到 "1m"
    const seven = Date.now() + 2 * 86400000 + 3600000;  // "2d 1h"
    return Promise.resolve(new Response(JSON.stringify({
      available: true,
      usage: {
        session: { total_cost_usd: 0.1234, model_usage: {} },
        subscription_type: 'pro',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42.5, resets_at: new Date(five).toISOString() },
          seven_day: { utilization: 61.0, resets_at: new Date(seven).toISOString() },
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  return realFetch(input, init);
};
"""

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script(STUB)
    page.goto(BASE, wait_until='domcontentloaded')
    page.wait_for_selector('.cc-dock', timeout=15000)
    time.sleep(1.5)
    page.screenshot(path='.lab-home/verify-page.png')
    if page.locator('[class*="_mask_"]').count() > 0:
        page.get_by_text('稍后配置').click()
        time.sleep(0.5)
        print('masks after dismiss:', page.locator('[class*="_mask_"]').count())
    page.click('.cc-dock')
    page.wait_for_selector('.cc-rail', timeout=15000)
    # 选中 cwd=dsh-cc 的会话：按标题定位侧栏行
    import urllib.request
    rows = json.load(urllib.request.urlopen(SESSIONS))['sessions']
    target = next(r for r in rows if r['cwd'].endswith('dsh-cc'))
    page.wait_for_selector('.cc-session', timeout=15000)
    page.screenshot(path='.lab-home/verify-rail.png')
    print('masks:', page.locator('[class*="_mask_"]').count())
    row = page.locator('.cc-session', has_text=target['name'][:20]).first
    row.dispatch_event('click')
    page.wait_for_selector('.cc-status', timeout=15000)
    page.wait_for_selector('.cc-branch-tag', timeout=15000)
    page.wait_for_selector('.cc-usage-meter-reset', timeout=15000)
    time.sleep(1.0)

    def strip_text():
        return page.locator('.cc-status').inner_text().replace('\n', ' | ')

    first = strip_text()
    page.screenshot(path='.lab-home/verify-status-t0.png')
    print('t0  status:', first)
    print('t0  branch tag:', page.locator('.cc-branch-tag').inner_text())
    print('t0  resets:', [e.inner_text() for e in page.locator('.cc-usage-meter-reset').all()])

    time.sleep(70)  # 跨过分钟边界
    second = strip_text()
    page.screenshot(path='.lab-home/verify-status-t1.png')
    print('t70 status:', second)
    print('t70 resets:', [e.inner_text() for e in page.locator('.cc-usage-meter-reset').all()])
    print('usage calls:', page.evaluate('window.__usageCalls'))
    print('console errors:', errors if errors else 'none')
    browser.close()
