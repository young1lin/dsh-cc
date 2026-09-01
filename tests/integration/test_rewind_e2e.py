"""会话回退端到端回归：锚点、弹窗、编辑重发语义、旧会话替换。

前置同 test_subagent_e2e；全部走真实 GLM 中转。

@module tests.integration.test_rewind_e2e
"""

import time
import unittest

from playwright.sync_api import sync_playwright

import helpers

# 每次运行一个唯一标签：CLI 自动标题取 MSG1 首行，固定文本会让上次运行的
# fork 残留行在本轮“同名唯一”断言里复活；摘要清理也只可能命中本轮。
RUN_TAG = time.strftime('%m%d-%H%M%S')
MSG1 = f'【回退回归{RUN_TAG}】只回复两个字：收到'
MSG2 = f'【回退回归{RUN_TAG}】只回复两个字：确认'


class RewindE2E(unittest.TestCase):
    server = None
    playwright = None
    browser = None
    page = None
    session_id = None
    auto_name = None

    @classmethod
    def setUpClass(cls):
        try:
            cls.server = helpers.LabServer()
            cls.server.start()
        except FileNotFoundError as cause:
            raise unittest.SkipTest(str(cause)) from cause
        # 自动命名让每次运行都取 MSG1 首行当标题；先清掉上次运行的同摘要残留，
        # 否则“同名唯一行”断言会被脏数据击穿。
        for stale in helpers.api('/sessions')['sessions']:
            if stale.get('cwd', '').endswith('dsh-cc') and stale.get('summary') == MSG1:
                try:
                    helpers.api(f"/sessions/{stale['id']}", 'DELETE')
                except Exception:
                    pass
        created = helpers.api('/sessions', 'POST', {
            'name': 'rewind-it', 'cwd': str(helpers.REPO_ROOT),
        })
        cls.session_id = created['session']['id']
        helpers.api(f'/sessions/{cls.session_id}/messages', 'POST', {'text': MSG1, 'images': []})
        helpers.wait_idle(cls.session_id)
        helpers.api(f'/sessions/{cls.session_id}/messages', 'POST', {'text': MSG2, 'images': []})
        snap = helpers.wait_idle(cls.session_id)
        cls.auto_name = snap['session']['name']
        anchors = [e['nativeMessageId'] for e in snap['events']
                   if e['kind'] == 'user' and e['text'] == MSG2]
        assert anchors and anchors[0], '第二条消息缺少回退锚点'
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)
        cls.page = cls.browser.new_page(viewport={'width': 1600, 'height': 1000})
        cls.page_errors = []
        cls.page.on('pageerror', lambda error: cls.page_errors.append(str(error)))

    @classmethod
    def tearDownClass(cls):
        # 不 stop 掉 playwright 驱动，同一进程里下一个类的 sync_playwright
        # 启动会撞上“asyncio loop”错误（实测三个类同跑时第三必炸）。
        for closer in ('browser', 'playwright', 'server'):
            thing = getattr(cls, closer, None)
            if thing is not None:
                try:
                    thing.close() if closer == 'browser' else thing.stop()
                except Exception:
                    pass

    def test_010_open_dialog_from_last_user_row(self):
        page = self.page
        page.goto(helpers.BASE, wait_until='domcontentloaded')
        helpers.dismiss_onboarding_mask(page)
        page.click('.cc-dock')
        page.wait_for_selector('.cc-rail', timeout=20000)
        row = page.locator('.cc-session', has_text=self.auto_name[:18]).first
        row.wait_for(timeout=20000)
        row.click()
        page.wait_for_selector('.cc-user-wrap', timeout=20000)
        self.assertEqual(page.locator('.cc-user-wrap').count(), 2, '应有两轮用户消息')
        actions = page.locator('.cc-user-wrap').last.locator('.cc-user-actions button')
        self.assertGreaterEqual(actions.count(), 3, '最后一行应有回退按钮')
        actions.nth(actions.count() - 1).click()
        page.wait_for_selector('.cc-rewind-hint', timeout=10000)
        hint = page.locator('.cc-rewind-hint').inner_text()
        self.assertIn(MSG2, hint, '弹窗必须引用锚消息')

    def test_020_apply_restores_composer_text(self):
        page = self.page
        page.get_by_role('button', name='回退', exact=True).click()
        deadline = __import__('time').time() + 30
        import time
        value = ''
        while time.time() < deadline:
            value = page.locator('.cc-main textarea').input_value()
            if value == MSG2:
                break
            time.sleep(0.5)
        self.assertEqual(value, MSG2, '锚文本必须填回输入框（编辑重发语义）')

    def test_030_old_session_replaced_by_fork(self):
        sessions = helpers.api('/sessions')['sessions']
        ids = {s['id'] for s in sessions}
        self.assertNotIn(self.session_id, ids, '原会话应被删除')
        mine = [s for s in sessions if s['name'] == self.auto_name]
        self.assertEqual(len(mine), 1, f'同名应只剩回退后的新行: {[s["id"] for s in mine]}')
        new_id = mine[0]['id']
        self.assertNotEqual(new_id, self.session_id, '新行必须是 fork 的新 id')
        final = helpers.api(f'/sessions/{new_id}')
        texts = [e.get('text', '') for e in final['events']]
        self.assertTrue(any(MSG1 in t for t in texts), '第一轮必须保留')
        self.assertFalse(any(MSG2 in t for t in texts), '被回退的轮次必须消失')
        self.assertFalse(self.page_errors, f'浏览器报错: {self.page_errors}')


if __name__ == '__main__':
    unittest.main()
