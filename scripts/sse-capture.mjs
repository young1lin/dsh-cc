/**
 * Capture /cc/api/events SSE frames to a JSONL file (lab verification aid).
 * Usage: node scripts/sse-capture.mjs <outFile> <durationMs>
 */
import { appendFileSync, writeFileSync } from 'node:fs'

const out = process.argv[2]
const duration = Number(process.argv[3] ?? 120000)
const port = process.argv[4] ?? '3101'
writeFileSync(out, '')
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), duration)
const response = await fetch('http://127.0.0.1:' + port + '/cc/api/events', { signal: controller.signal })
const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
try {
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const line = frame.split('\n').find(l => l.startsWith('data: '))
      if (line) appendFileSync(out, line.slice(6) + '\n')
    }
  }
} catch {
  // aborted or stream closed
} finally {
  clearTimeout(timer)
}
