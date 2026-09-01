"""工具结果回流与子代理模型/结果展示的端到端回归。

覆盖三处真实缺陷：
- 主线程工具卡结果缺失时永远转圈：回合结束后未拿到结果的行必须落到
  「无结果」终态，且正常链路下每个 tool_use 都必须有 tool_result。
- 子代理模型不展示：Agent 调用带 model 参数（如 haiku）时，任务行要显示。
- 子代理最终结果不可见：派发后不等待（Flow A），CLI 以 <task-notification>
  把 <result> 注回主线程——它必须成为 Agent 卡的结果（替换内部 launch ack），
  刷新页面后依然挂在卡上（回放路径）。

前置：pnpm build 已产出最新 lib/；.env 已配置。

@module tests.integration.test_result_model_e2e
"""

import time
import unittest

from playwright.sync_api import sync_playwright

import helpers

PROMPT = (
    '请严格按顺序执行三步，不要省略：'
    '1) 用 Bash 执行 echo RESULT_FLOW_OK；'
    '2) 用 Grep 在 src 目录搜索 sendTaskMessage（output_mode 用 files_with_matches）；'
    '3) 调用 Agent 工具启动一个 general-purpose 子代理，description 为“模型回归子代理”，'
    'model 参数必须填 haiku，run_in_background 填 true；'
    '子代理的任务：先用 Bash 执行 sleep 12，然后只回复 MODEL_PROBE_OK，不做任何其他事。'
    '启动子代理之后：不要用 TaskOutput 等待，不要查询子代理状态，'
    '立即回复 MAIN_CONTINUES 并结束回合。等子代理自己完成即可。'
)


class ResultModelE2E(unittest.TestCase):
    """一个会话跑完三条链路；用例方法按名字序共享同一现场。"""

    server = None
    playwright = None
    browser = None
    page = None
    session_id = None
    agent_use_id = None
    agent_row_model = None
    agent_row_seen = False

    @classmethod
    def setUpClass(cls):
        try:
            cls.server = helpers.LabServer()
            cls.server.start()
        except FileNotFoundError as cause:
            raise unittest.SkipTest(str(cause)) from cause
        created = helpers.api('/sessions', 'POST', {
            'name': 'result-model-it', 'cwd': str(helpers.REPO_ROOT),
        })
        cls.session_id = created['session']['id']
        helpers.api(f'/sessions/{cls.session_id}/messages', 'POST',
                    {'text': PROMPT, 'images': []})
        cls._watch_running_phase()
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)
        cls.page = cls.browser.new_page(viewport={'width': 1600, 'height': 1000})
        cls.page_errors = []
        cls.page.on('pageerror', lambda error: cls.page_errors.append(str(error)))

    @classmethod
    def _watch_running_phase(cls):
        """轮询运行窗口：只认子代理任务行，记下它的 model 与 toolUseId。"""
        deadline = time.time() + 300
        while time.time() < deadline:
            snap = helpers.api(f'/sessions/{cls.session_id}')
            tasks = snap.get('tasks') or []
            for row in tasks:
                if row.get('type') == 'subagent' or row.get('subagentType') is not None:
                    cls.agent_row_seen = True
                    cls.agent_use_id = row.get('toolUseId') or cls.agent_use_id
                    cls.agent_row_model = row.get('model')
            if cls.agent_row_seen and not tasks and snap['session']['status'] == 'idle':
                return
            time.sleep(1.0)
        raise AssertionError('300 秒内会话未回到空闲（子代理未完成）')

    @classmethod
    def tearDownClass(cls):
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
        page.wait_for_selector('.cc-tool', timeout=30000)

    def test_010_row_carried_model(self):
        # 子代理任务行必须带出模型：任务行先带输入别名 haiku，sidechain 读取
        # 把它升级为 CLI 解析后的线上值（glm-5.3-flash）。两态都算通过。
        self.assertTrue(self.agent_row_seen, "运行窗口内从未见到子代理任务行")
        self.assertIsNotNone(self.agent_row_model,
                             "子代理任务行没有 model 字段（别名捕获未生效）")
        self.assertTrue(
            self.agent_row_model == 'haiku' or self.agent_row_model.startswith('glm-5.3-flash'),
            f'子代理任务行 model 应为别名 haiku 或解析值 glm-5.3-flash: {self.agent_row_model}')

    def test_020_every_tool_use_got_result(self):
        # 服务端真相：回合结束后，任何 tool_use 都不允许缺 tool_result
        #（这正是用户截图里工具卡永远转圈的服务端根源之一）。
        snap = helpers.api(f'/sessions/{self.session_id}')
        events = snap['events']
        uses = {e['toolUseId'] for e in events if e['kind'] == 'tool_use'}
        results = {e['toolUseId'] for e in events if e['kind'] == 'tool_result'}
        self.assertTrue(uses, '回合没有产生任何 tool_use')
        missing = uses - results
        self.assertEqual(missing, set(), f'这些工具调用没有结果事件: {missing}')

    def test_021_nested_transcript_carries_report(self):
        # 子代理的最终报告必须出现在嵌套转录里（sidechain 终读修复：
        # 终态帧之后子代理才落盘的最后一条 assistant 消息不能被丢掉）。
        snap = helpers.api(f'/sessions/{self.session_id}')
        events = snap['events']
        self.assertTrue(self.agent_use_id, "未拿到 Agent 调用的 toolUseId")
        nested = [e for e in events
                  if e['kind'] == 'subagent' and e.get('parentToolUseId') == self.agent_use_id
                  and e.get('event', {}).get('kind') == 'assistant']
        self.assertTrue(nested, 'Agent 卡下没有任何嵌套 assistant 事件')
        last_text = nested[-1]['event']['text']
        self.assertIn('MODEL_PROBE_OK', last_text,
                      f'嵌套转录的最后一条 assistant 不是子代理报告: {last_text[:200]}')

    def test_030_page_shows_no_eternal_spinner(self):
        # 页面真相：回合结束后不允许任何工具行停留在 running 态。
        self._open_session()
        self.page.wait_for_timeout(1500)
        spinning = self.page.locator('.cc-tool[data-state="running"]')
        self.assertEqual(spinning.count(), 0,
                         f'{spinning.count()} 个工具行在回合结束后仍显示运行中')

    def test_031_agent_card_shows_report_after_reload(self):
        # 回放路径：刷新后报告仍挂在 Agent 卡上（展开卡片后做卡片级断言，
        # 不接受主页 assistant 摘要里的假阳性）。
        self._open_session()
        card = self.page.locator('.cc-tool[data-tool="Agent"]').first
        card.wait_for(timeout=20000)
        card.locator('.cc-tool-row').first.click()
        self.page.wait_for_timeout(800)
        body = card.inner_text()
        self.assertIn('MODEL_PROBE_OK', body, '刷新后 Agent 卡上看不到子代理最终报告')
        self.assertEqual(len(self.page_errors), 0, f"页面报错: {self.page_errors}")


if __name__ == '__main__':
    unittest.main()
