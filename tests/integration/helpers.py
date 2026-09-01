"""集成回归公共设施：本地凭据、实验室实例生命周期、/cc/api 客户端、UI 公共步骤。

设计约定（见本目录 README.md）：
- 密钥只从 .env（已 gitignore）读取，绝不写进仓库任何文件。
- 实验实例固定 127.0.0.1:3081（scripts/lab-port.patch.yml 覆盖），DSH_HOME 指向
  .lab-home/ 隔离副本，与用户 3080 实例互不可见。
- 停止实例时必须同时清掉监听 3081 的 node 孤儿进程：进程树层面的 terminate
  只杀 bash 包装层，底下的 dsh node 进程会存活并占住端口（EADDRINUSE 实证）。

@module tests.integration.helpers
"""

import json
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
LAB_HOME = REPO_ROOT / '.lab-home'
ARTIFACTS = LAB_HOME / 'it-artifacts'

PORT = 3081
BASE = f'http://127.0.0.1:{PORT}'
API = BASE + '/cc/api'
HOST_HEADER = {'Host': f'127.0.0.1:{PORT}'}


def load_credentials():
    """读取 .env（已 gitignore）为凭据字典；缺失时抛 FileNotFoundError，由用例转为 SkipTest。

    纯标准库实现：KEY=VALUE 逐行解析，空行与 # 注释跳过，值两端引号剥掉。
    返回键名映射回原 camelCase 字段，LabServer / resolve_git_bash 零改动。
    """
    path = HERE / '.env'
    if not path.exists():
        raise FileNotFoundError(
            f'缺少 {path}。复制 .env.example 为 .env '
            '并填入真实中转配置（该文件已 gitignore，不会进仓库）。'
        )
    raw = {}
    for line in path.read_text('utf-8').splitlines():
        text = line.strip()
        if not text or text.startswith('#') or '=' not in text:
            continue
        key, _, value = text.partition('=')
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key in ENV_KEYS:
            raw[ENV_KEYS[key]] = value
    missing = sorted(env for env, field in ENV_KEYS.items() if field not in raw and env != 'GIT_BASH')
    if missing:
        raise FileNotFoundError(f'.env 缺少必填键：{", ".join(missing)}')
    return raw


# .env 大写下划线键 → 凭据字典字段名；GIT_BASH 可选，其余由 LabServer 直接取用。
ENV_KEYS = {
    'BASE_URL': 'baseUrl',
    'AUTH_TOKEN': 'authToken',
    'API_TIMEOUT_MS': 'apiTimeoutMs',
    'MODEL': 'model',
    'SMALL_FAST_MODEL': 'smallFastModel',
    'SONNET_MODEL': 'sonnetModel',
    'OPUS_MODEL': 'opusModel',
    'HAIKU_MODEL': 'haikuModel',
    'GIT_BASH': 'gitBash',
}


def resolve_git_bash(creds):
    """定位 Git Bash：凭据 gitBash 字段优先，其次常见安装位置自动探测。

    System32 的 bash.exe 是 WSL 入口，跑不了本脚本，探测时按路径含 git 过滤。
    """
    override = creds.get('gitBash')
    if override and Path(override).exists():
        return override
    candidates = []
    found = shutil.which('bash')
    if found:
        candidates.append(found)
    candidates += [
        'C:/Program Files/Git/bin/bash.exe',
        'C:/Program Files/Git/usr/bin/bash.exe',
        str(Path.home() / 'AppData' / 'Local' / 'Programs' / 'Git' / 'bin' / 'bash.exe'),
    ]
    for candidate in candidates:
        if candidate and 'git' in candidate.lower() and Path(candidate).exists():
            return candidate
    raise FileNotFoundError(
        '未找到 Git Bash。安装 Git for Windows，或在 .env 加 '
        'GIT_BASH=<bash.exe 路径>。'
    )


def api(path, method='GET', body=None, timeout=30):
    """/cc/api 请求。Host 必须显式回环（运行时入口校验 Host）。"""
    headers = dict(HOST_HEADER)
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def _listening_pids():
    """netstat 解析 3081 的 LISTENING 进程 pid；Windows 自带命令，无第三方依赖。"""
    result = subprocess.run(['netstat', '-ano', '-p', 'tcp'], capture_output=True, text=True)
    pids = set()
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[3] == 'LISTENING' and parts[1].endswith(f':{PORT}'):
            pids.add(parts[4])
    return sorted(pids)


def kill_port_listeners():
    """强杀占用 3081 的残留进程（上一次实例的 node 孤儿）。"""
    pids = _listening_pids()
    for pid in pids:
        subprocess.run(['taskkill', '/F', '/PID', pid], capture_output=True)
    if pids:
        wait_port_free()
    return pids


def wait_port_free(grace_ms=0):
    """轮询直到 3081 不再监听（可选先等待 grace_ms 让进程退出）。"""
    if grace_ms:
        time.sleep(grace_ms / 1000)
    deadline = time.time() + 10
    while time.time() < deadline:
        if not _listening_pids():
            return
        time.sleep(0.3)


def wait_idle(session_id, timeout=150):
    """轮询会话直到空闲（status=idle 且无任务行）且已产出至少一条回复。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        snap = api(f'/sessions/{session_id}')
        if snap['session']['status'] == 'idle' and not snap.get('tasks'):
            if any(e['kind'] == 'assistant' for e in snap['events']):
                return snap
        time.sleep(1)
    raise TimeoutError(f'会话 {session_id} 未在 {timeout}s 内空闲')


def dismiss_onboarding_mask(page):
    """关闭宿主 GUI 的「添加 API Key」引导遮罩（新 browser profile 每次都会出现）。"""
    page.wait_for_selector('.cc-dock', timeout=20000)
    page.wait_for_timeout(1500)
    for _ in range(6):
        if page.locator('[class*="_mask_"]').count() == 0:
            return
        clicked = False
        for label in ['稍后配置', '跳过', '以后再说', '取消', '开始使用']:
            candidate = page.get_by_text(label, exact=True)
            if candidate.count() > 0:
                try:
                    candidate.first.click(timeout=2000)
                    clicked = True
                    break
                except Exception:
                    pass
        if not clicked:
            page.keyboard.press('Escape')
        page.wait_for_timeout(800)


class LabServer:
    """一个隔离的 dsh web 实例：DSH_HOME=.lab-home，webserver 覆盖到 127.0.0.1:3081。

    bash 单引号里的 Windows 反斜杠路径按实测形式传递（/c/... 形式反而找不到 profile）。
    """

    def __init__(self):
        self.creds = load_credentials()
        self.git_bash = resolve_git_bash(self.creds)
        self.proc = None

    def start(self, timeout_s=40):
        kill_port_listeners()
        env = self.creds
        patch = REPO_ROOT / 'scripts' / 'lab-port.patch.yml'
        script = '; '.join([
            f"export DSH_HOME='{LAB_HOME}'",
            f"export ANTHROPIC_BASE_URL='{env['baseUrl']}'",
            f"export ANTHROPIC_AUTH_TOKEN='{env['authToken']}'",
            f"export API_TIMEOUT_MS='{env.get('apiTimeoutMs', '3000000')}'",
            f"export ANTHROPIC_MODEL='{env['model']}'",
            f"export ANTHROPIC_SMALL_FAST_MODEL='{env['smallFastModel']}'",
            f"export ANTHROPIC_DEFAULT_SONNET_MODEL='{env['sonnetModel']}'",
            f"export ANTHROPIC_DEFAULT_OPUS_MODEL='{env['opusModel']}'",
            f"export ANTHROPIC_DEFAULT_HAIKU_MODEL='{env['haikuModel']}'",
            f"exec dsh --profile web --patch '{patch}' --no-open",
        ])
        self.proc = subprocess.Popen(
            [self.git_bash, '-lc', script],
            cwd=str(REPO_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            try:
                api('/config', timeout=2)
                return
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                time.sleep(0.5)
        raise TimeoutError(f'实验室实例 {timeout_s}s 内未就绪')

    def stop(self):
        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None
        kill_port_listeners()
        wait_port_free(1500)
