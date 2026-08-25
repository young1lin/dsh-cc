/**
 * Probe 3: answer AskUserQuestion through the canUseTool deny-message path
 * and see whether the model treats it as the user's answer.
 * Run: node scripts/dialog-probe3.mjs
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

const q = query({
  prompt: [{
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '现在立刻调用 AskUserQuestion 工具（必须调用）问我：测试选 A 还是 B？选项 A、B。等我回答后总结我的选择。' }] },
    session_id: '',
    parent_tool_use_id: null,
  }],
  options: {
    cwd: 'C:/PythonProject/dev/dsh-cc',
    permissionMode: 'auto',
    canUseTool: async (toolName, input) => {
      if (toolName === 'AskUserQuestion') {
        console.log('CANNOTOOL AskUserQuestion -> deny with answer message')
        return { behavior: 'deny', message: '用户回答：选 A' }
      }
      return { behavior: 'allow', updatedInput: input }
    },
  },
})
for await (const m of q) {
  if (m.type === 'assistant') {
    for (const b of m.message.content) {
      if (b.type === 'text') console.log('ASSISTANT:', b.text.slice(0, 200))
      if (b.type === 'tool_use') console.log('tool_use:', b.name)
    }
  }
  if (m.type === 'user') {
    for (const b of (Array.isArray(m.message.content) ? m.message.content : [])) {
      if (b.type === 'tool_result') console.log('TOOL_RESULT:', JSON.stringify(b.content).slice(0, 200))
    }
  }
  if (m.type === 'result') { console.log('result:', m.subtype); break }
}
q.close()
process.exit(0)
