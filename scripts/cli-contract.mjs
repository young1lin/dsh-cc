/**
 * CLI 契约探针：把 dsh-cc 依赖的 CLI 行为对着**真进程**断言一遍。
 *
 * 存在的理由：`engine.ts` 里曾有一条注释白纸黑字写着「verified against the
 * 0.3.220 payload」，三条断言全错（说 CLI 会丢弃回合中途的消息 —— 实际上它
 * 自己就有队列，还会把整批合并成一个回合），整个宿主侧队列子系统建在上面。
 * 没有任何东西能在 SDK / CLI 换版时告诉你哪条假设破了。这个脚本就是那个东西。
 *
 * 这不是测试框架，是一次性探针 —— 和 client-smoke.mjs / sse-capture.mjs 同级。
 * 升级 `@anthropic-ai/claude-agent-sdk` 之后跑它；红了就说明某条不变量变了，
 * 去 AGENTS.md 的「排队的不变量」那节对照修。
 *
 * 用法：
 *   node scripts/cli-contract.mjs              # 用 settings.json 里生效的预设
 *   node scripts/cli-contract.mjs --preset glm # 指定预设
 *   node scripts/cli-contract.mjs --keep       # 保留探针会话的转录，便于人工看
 *
 * 环境：预设里的 env 叠加到 process.env 上；预设缺失时直接用 process.env。
 * 测试只允许走中转（见 AGENTS.md），脚本不会替你选账号直连。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 探针在这个目录下起会话；用仓库自己的临时目录，不碰用户项目。 */
const PROBE_CWD = join(ROOT, '.contract-probe')

/**
 * 读 dsh-cc 自己的设置层，取出一个预设的 env。
 * @param {string} wanted - 预设 id；空串表示用 `activePresetId`。
 * @returns {{ id: string, env: Record<string, string> } | undefined} 预设，或 undefined。
 */
function readPreset(wanted) {
  const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'claude-code', 'settings.json')
  if (!existsSync(file)) return undefined
  let settings
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  const presets = Array.isArray(settings.presets) ? settings.presets : []
  const id = wanted || settings.activePresetId || ''
  const hit = presets.find(preset => preset.id === id)
  if (hit === undefined || typeof hit.env !== 'object' || hit.env === null) return undefined
  return { id: hit.id, env: hit.env }
}

/** 最小可推流：push 塞消息，close 收尾。 */
class Pushable {
  #queue = []
  #wake
  #closed = false

  /** @param {unknown} value - 要投递的值。 */
  push(value) {
    if (this.#closed) return
    this.#queue.push(value)
    const wake = this.#wake
    this.#wake = undefined
    wake?.()
  }

  /** 关流。 */
  close() {
    this.#closed = true
    const wake = this.#wake
    this.#wake = undefined
    wake?.()
  }

  /** @returns {AsyncIterator<unknown>} 迭代器。 */
  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        for (;;) {
          const value = this.#queue.shift()
          if (value !== undefined) return { value, done: false }
          if (this.#closed) return { value: undefined, done: true }
          await new Promise(resolve => { this.#wake = resolve })
        }
      },
    }
  }
}

const checks = []

/**
 * 记一条断言。
 * @param {string} name - 断言名，红了要能凭它定位到代码。
 * @param {boolean} ok - 是否成立。
 * @param {string} detail - 实际观察到的东西。
 */
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * 造一条用户消息，形状与 `engine.ts` 的 send() 一致。
 * @param {string} text - 正文。
 * @returns {Record<string, unknown>} SDK 用户消息。
 */
function userMessage(text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
    uuid: randomUUID(),
  }
}

const args = process.argv.slice(2)
const presetId = (() => {
  const at = args.indexOf('--preset')
  return at >= 0 ? (args[at + 1] ?? '') : ''
})()
const keep = args.includes('--keep')

const preset = readPreset(presetId)
if (preset === undefined) {
  console.log('! 没读到预设，直接用当前 process.env（确认它指向中转，不是账号直连）')
} else {
  console.log(`使用预设 ${preset.id}（${Object.keys(preset.env).length} 个键）`)
}
const env = { ...process.env, ...(preset?.env ?? {}) }
if ((env.ANTHROPIC_BASE_URL ?? '') === '') {
  console.error('拒绝运行：ANTHROPIC_BASE_URL 为空 —— 契约探针只允许走中转，不碰账号配额。')
  process.exit(2)
}

// The probe cwd is created here, not assumed: the run below deletes it on the
// way out, so every run starts from nothing and a missing directory would fail
// the spawn rather than the contract.
mkdirSync(PROBE_CWD, { recursive: true })

const input = new Pushable()
const session = query({
  prompt: input,
  options: {
    cwd: PROBE_CWD,
    env,
    permissionMode: 'auto',
    includePartialMessages: false,
  },
})

/** 收到的所有帧，按到达顺序。 */
const frames = []
/** 每条提交消息的 lifecycle 状态序列，按 command_uuid 归集。 */
const lifecycle = new Map()

const first = userMessage('请从 1 数到 40，每个数字单独一行，只输出数字，不要任何解释。')
const second = userMessage('【契约探针·第二条】只回复两个字：苹果')
const third = userMessage('【契约探针·第三条】只回复两个字：香蕉')

let results = 0
let pushedFollowUps = false
const deadline = setTimeout(() => {
  console.error('探针超时（180s）—— 网关慢或 CLI 卡住，本次结果不可判定。')
  session.close()
  process.exit(2)
}, 180_000)

input.push(first)

for await (const message of session) {
  frames.push(message)
  const type = String(message?.type ?? '')

  if (type === 'command_lifecycle') {
    const uuid = message.command_uuid
    if (!lifecycle.has(uuid)) lifecycle.set(uuid, [])
    lifecycle.get(uuid).push(message.state)
    continue
  }
  if (type === 'system' && message.subtype === 'init' && results === 0) {
    const caps = Array.isArray(message.capabilities) ? message.capabilities : []
    check('init 带 capabilities 数组', Array.isArray(message.capabilities), JSON.stringify(caps))
    check('能力位 msg_lifecycle_v1（队列状态的唯一来源）',
      caps.includes('msg_lifecycle_v1'), caps.includes('msg_lifecycle_v1') ? '' : '缺失 → engine 会回落到「推流即投递」')
    check('能力位 interrupt_receipt_v1（停止时对账 still_queued）',
      caps.includes('interrupt_receipt_v1'), '')
    continue
  }
  if (type === 'result') {
    results += 1
    if (results === 1) {
      // 第一回合刚结束：排队的两条应当在这一刻同时被取走并合并。
      continue
    }
    break
  }
  // 第一条的首个 assistant 帧之后再插队，确保确实落在回合中途。
  if (type === 'assistant' && !pushedFollowUps) {
    pushedFollowUps = true
    input.push(second)
    input.push(third)
  }
}
clearTimeout(deadline)
input.close()
session.close()

// ---- 断言 ----

const states = uuid => (lifecycle.get(uuid) ?? []).join('→')

check('回合中途推入的消息不会被丢弃，CLI 自己入队',
  states(second.uuid).startsWith('queued') && states(third.uuid).startsWith('queued'),
  `第二条=${states(second.uuid) || '(无帧)'} 第三条=${states(third.uuid) || '(无帧)'}`)

check('排队的消息最终会 started（不会烂在队列里）',
  states(second.uuid).includes('started') && states(third.uuid).includes('started'), '')

const resultFrames = frames.filter(f => f?.type === 'result')
check('两条排队消息合并成一个回合（而不是各跑一个）',
  resultFrames.length === 2,
  `result 帧数=${resultFrames.length}（1=第一条，2=合并批次；出现 3 说明 coalescing 没了）`)

const userEchoes = frames.filter(f => f?.type === 'user' && !('isReplay' in f)
  && Array.isArray(f.message?.content)
  && f.message.content.some(block => block?.type === 'text'))
check('CLI 不回显用户提交的消息（转录行必须由 dsh-cc 自己发）',
  userEchoes.length === 0,
  `观察到 ${userEchoes.length} 条文本用户回显`)

const lastResult = resultFrames[resultFrames.length - 1]
check('合并批次只结算一次费用',
  typeof lastResult?.total_cost_usd === 'number',
  `num_turns=${lastResult?.num_turns} cost=${lastResult?.total_cost_usd}`)

check('SDK 运行时仍提供 cancelAsyncMessage（撤回的唯一通道）',
  typeof session.cancelAsyncMessage === 'function',
  typeof session.cancelAsyncMessage)

if (!keep && existsSync(PROBE_CWD)) {
  try {
    rmSync(PROBE_CWD, { recursive: true, force: true })
  } catch {
    // 目录被占用就留着，下次跑会覆盖。
  }
}

const failed = checks.filter(entry => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 条契约成立`)
if (failed.length > 0) {
  console.log('破掉的契约：')
  for (const entry of failed) console.log(`  - ${entry.name}`)
  console.log('\n对照 AGENTS.md「排队的不变量」一节修 engine.ts。')
  process.exit(1)
}
process.exit(0)
