# 补验：普通分支（main）标签形态 + 非仓库会话隐藏标签。一次性脚本，只扫最近若干行。
import time
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:3090'

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE, wait_until='domcontentloaded')
    page.wait_for_selector('.cc-dock', timeout=15000)
    time.sleep(1.0)
    if page.locator('[class*="_mask_"]').count() > 0:
        page.get_by_text('稍后配置').click()
        time.sleep(0.5)
    page.click('.cc-dock')
    page.wait_for_selector('.cc-session', timeout=15000)
    for want in ['dsh-cc', 'Temp']:
        head = page.locator('.cc-project-row', has_text=want).first
        if head.count() > 0:
            head.dispatch_event('click')
            time.sleep(0.6)
    seen = []
    rows = page.locator('.cc-session').all()
    for row in rows[:14]:
        try:
            row.dispatch_event('click')
        except Exception:
            continue
        time.sleep(0.7)
        tag = page.locator('.cc-branch-tag')
        label = tag.inner_text() if tag.count() > 0 else '<no tag>'
        status = page.locator('.cc-status').inner_text().replace('\n', ' | ')
        seen.append((label, status[:110]))
        if label == 'main':
            break
    for label, status in seen:
        print('tag:', repr(label), '|', status)
    print('pageerror:', errors if errors else 'none')
    browser.close()
