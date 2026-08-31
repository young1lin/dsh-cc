/**
 * One-shot probe: print the dialogKind the CLI actually emits for
 * AskUserQuestion. Run: node scripts/dialog-probe.mjs
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

const q = query({
  prompt: [{
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '现在立刻调用 AskUserQuestion 工具（必须调用，不要用文字回答）问我：测试选 A 还是 B？提供两个选项：A、B。然后等我回答。' }] },
    session_id: '',
    parent_tool_use_id: null,
  }],
  options: {
    cwd: process.cwd(),
    permissionMode: 'auto',
    supportedDialogKinds: ['ask_user_question', 'question', 'ask_user_question_dialog'],
    onUserDialog: async (request) => {
      console.log('DIALOG RECEIVED kind=' + request.dialogKind)
      console.log('PAYLOAD: ' + JSON.stringify(request.payload).slice(0, 500))
      return { behavior: 'cancelled' }
    },
  },
})
for await (const m of q) {
  if (m.type === 'system') console.log('system:', m.subtype)
  if (m.type === 'assistant') {
    for (const b of m.message.content) {
      if (b.type === 'tool_use') console.log('tool_use:', b.name)
    }
  }
  if (m.type === 'result') { console.log('result:', m.subtype); break }
}
q.close()
process.exit(0)
