/**
 * Probe 2: no dialog declaration (like the 3081 engine), force the tool,
 * then inspect what control traffic arrives via debug logging.
 * Run: node scripts/dialog-probe2.mjs
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

const q = query({
  prompt: [{
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '现在立刻调用 AskUserQuestion 工具（必须调用，不要用文字回答）问我：测试选 A 还是 B？提供两个选项：A、B。然后等我回答后再总结。' }] },
    session_id: '',
    parent_tool_use_id: null,
  }],
  options: {
    cwd: 'D:/dev/dsh-cc',
    permissionMode: 'auto',
    supportedDialogKinds: ['ask_user_question', 'question', 'ask_user_question_dialog'],
    onUserDialog: async (request) => {
      console.log('DIALOG kind=' + request.dialogKind)
      console.log('PAYLOAD=' + JSON.stringify(request.payload).slice(0, 600))
      return { behavior: 'cancelled' }
    },
    canUseTool: async (toolName, input) => {
      console.log('CANNOTOOL ' + toolName + ' input=' + JSON.stringify(input).slice(0, 200))
      return { behavior: 'allow', updatedInput: input }
    },
  },
})
for await (const m of q) {
  if (m.type === 'system') console.log('system:', m.subtype)
  if (m.type === 'assistant') {
    for (const b of m.message.content) {
      if (b.type === 'tool_use') console.log('tool_use:', b.name, JSON.stringify(b.input).slice(0, 150))
    }
  }
  if (m.type === 'result') { console.log('result:', m.subtype); break }
}
q.close()
process.exit(0)
