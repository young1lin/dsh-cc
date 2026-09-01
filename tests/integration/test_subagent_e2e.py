"""子代理链路端到端回归：两级展示、进入输入、非阻塞、完成即移除。

对应本次改动的四项需求，全部走真实 GLM 中转 + 真实 claude 子进程。
前置：pnpm build 已产出最新 lib/；Git Bash、Python playwright 可用；
tests/integration/.env 已配置。

@module tests.integration.test_subagent_e2e
"""

import unittest

from playwright.sync_api import sync_playwright

import helpers

PROMPT = (
    '请严格执行：调用 Agent 工具启动一个 general-purpose 子代理，description 为“集成回归子代理”。'
    '子代理依次使用 Glob 查 package.json、Read 读取它、Bash 执行 '
    'node -e "setTimeout(()=>console.log(\'WAIT_DONE\'),30000)"，然后回复 SUBAGENT_DONE。'
    'Agent 必须显式 run_in_background:false。启动后主线程不要等待，立即回复 MAIN_CONTINUES。'
)
NESTED_NOTE = '原任务完成后，请在最终回复里追加 USER_NOTE_OK。'


class SubagentE2E(unittest.TestCase):
    """一个会话跑完整条子代理链路；用例方法按名字序共享同一现场。"""

    server = None
    playwright = None
    browser = None
    page = None
    session_id = None

    @classmethod
    def setUpClass(cls):
        try:
            cls.server = helpers.LabServer()
            cls.server.start()
        except FileNotFoundError as cause:
            raise unittest.SkipTest(str(cause)) from cause
        created = helpers.api('/sessions', 'POST', {
            'name': 'subagent-it', 'cwd': str(helpers.REPO_ROOT),
        })
        cls.session_id = created['session']['id']
        helpers.api(f'/sessions/{cls.session_id}/messages', 'POST',
                    {'text': PROMPT, 'images': []})
        deadline = __import__('time').time() + 150
        import time
        while time.time() < deadline:
            snap = helpers.api(f'/sessions/{cls.session_id}')
            if snap.get('tasks'):
                assert len(snap['tasks']) == 1, f'主任务栏出现嵌套泄漏: {snap["tasks"]}'
                break
            time.sleep(0.5)
        else:
            raise AssertionError('子代理任务从未出现在任务栏')
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

    def _open_session(self):
        page = self.page
        page.goto(helpers.BASE, wait_until='domcontentloaded')
        helpers.dismiss_onboarding_mask(page)
        page.click('.cc-dock')
        page.wait_for_selector('.cc-rail', timeout=20000)
        snap = helpers.api(f'/sessions/{self.session_id}')
        row = page.locator('.cc-session', has_text=snap['session']['name'][:18]).first
        row.wait_for(timeout=20000)
        row.click()
        page.wait_for_selector('.cc-tasks .cc-task-row', timeout=30000)

    def test_010_rail_has_single_backgrounded_agent(self):
        self._open_session()
        rows = self.page.locator('.cc-tasks .cc-task-row')
        self.assertEqual(rows.count(), 1, '主任务栏应只有深度 1 子代理一行')

    def test_020_detail_modal_composer_sends_message(self):
        page = self.page
        page.locator('.cc-tasks .cc-task-row').click()
        page.wait_for_selector('.cc-subagent-dialog-input', timeout=10000)
        page.locator('.cc-subagent-dialog-input').fill(NESTED_NOTE)
        page.get_by_role('button', name='发送给子代理').click()
        page.wait_for_function(
            "document.querySelector('.cc-subagent-dialog-input').value === ''", timeout=30000)

    def test_031_main_thread_not_blocked(self):
        # 30 秒子命令远未结束时，主线程必须已经能看到“启动即回复”的正文。
        # 模型可能转述而不是原样复述 MAIN_CONTINUES 标记（实测转述过），
        # 所以断言语义：子代理仍在跑，且主线程已有非空回复行。
        page = self.page
        page.wait_for_selector('.cc-assistant', timeout=45000)
        first_text = page.locator('.cc-assistant').first.inner_text().strip()
        self.assertTrue(first_text, '主线程在子代理运行期间没有任何回复')
        self.assertEqual(page.locator('.cc-tasks .cc-task-row').count(), 1, '子代理应仍在运行')

    def test_032_nested_tools_stream_into_modal(self):
        page = self.page
        page.wait_for_selector('.cc-subagent-dialog-flow .cc-tool', timeout=90000)
        titles = page.locator('.cc-subagent-dialog-flow .cc-tool-title').all_inner_texts()
        self.assertTrue(any(name in titles for name in ['Glob', 'Read', 'Bash']), titles)
        self.assertEqual(page.locator('.cc-tasks .cc-task-row').count(), 1, '嵌套 Bash 不得泄漏进主任务栏')

    def test_040_rail_removed_on_completion(self):
        self.page.wait_for_selector('.cc-tasks', state='detached', timeout=210000)

    def test_050_durable_nested_card_without_leaks(self):
        page = self.page
        # 完成即清空：详情弹窗挂在 running 行上，会随任务行一起卸载；还在才手动关。
        if page.locator('.cc-subagent-dialog-input').count() > 0:
            page.get_by_role('button', name='关闭', exact=True).first.click()
            page.wait_for_selector('.cc-subagent-dialog-input', state='detached', timeout=10000)
        agent = page.locator('.cc-tool[data-tool="Agent"]').first
        agent.wait_for(timeout=30000)
        if page.locator('.cc-subagent-transcript').count() == 0:
            agent.locator('.cc-tool-row').click()
        page.wait_for_selector('.cc-subagent-transcript', timeout=15000)
        titles = page.locator('.cc-subagent-transcript .cc-tool-title').all_inner_texts()
        for name in ['Glob', 'Read', 'Bash']:
            self.assertIn(name, titles)
        self.assertNotIn('工具', titles, '无 identity 的占位行不应渲染')
        body = page.locator('.cc-overlay').inner_text()
        self.assertNotIn('<task-notification>', body, '内部完成通知不得进入转录')

    def test_060_user_rows_carry_rewind_action(self):
        actions = self.page.locator('.cc-user-wrap').first.locator('.cc-user-actions button')
        self.assertGreaterEqual(actions.count(), 3, '首轮用户行应有 复制/复制回合/回退')

    def test_070_final_api_state_consistent(self):
        final = helpers.api(f'/sessions/{self.session_id}')
        self.assertEqual(final['tasks'], [], '完成后任务行必须清空')
        child = [e for e in final['events'] if e['kind'] == 'subagent']
        tools = [e['event'].get('name') for e in child if e['event']['kind'] == 'tool_use']
        for name in ['Glob', 'Read', 'Bash']:
            self.assertIn(name, tools)
        self.assertTrue(any(
            e['kind'] == 'user' and e.get('nativeMessageId') for e in final['events']),
            '回退锚点缺失')
        self.assertFalse(self.page_errors, f'浏览器报错: {self.page_errors}')


if __name__ == '__main__':
    unittest.main()
