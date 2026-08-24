/**
 * Mid-turn live-replay acceptance probe: a page that joins a session AFTER
 * its turn started (the switch-away-and-back case) must be handed the folded
 * in-flight turn by GET /sessions/:id, and SSE delta frames must carry the
 * per-session sequence counter.
 *
 * Run against the lab server (pnpm build + restart with lab-port.patch.yml):
 *   node scripts/live-replay-probe.mjs [port]
 */
const port = process.argv[2] ?? '3081'
const base = `http://127.0.0.1:${port}/cc/api`
const failures = []

const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : ' — ' + detail}`)
  if (!ok) failures.push(name)
}

// One SSE reader that starts collecting only once the turn is running, i.e.
// the page that "switches back" mid-turn and missed the earlier frames.
async function readFrames(signal, onFrame) {
  const response = await fetch(`${base}/events`, { signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const line = frame.split('\n').find(l => l.startsWith('data: '))
      if (line) onFrame(JSON.parse(line.slice(6)))
    }
  }
}

const created = await fetch(`${base}/sessions`, { method: 'POST', body: JSON.stringify({}) })
  .then(r => r.json())
if (!created.session) {
  console.error('FAIL: could not create session:', JSON.stringify(created))
  process.exit(1)
}
const id = created.session.id
console.log('session:', id)
let cleanup = () => {}
try {
  const controller = new AbortController()
  const deltas = []
  const frameTask = readFrames(controller.signal, frame => {
    if (frame.t === 'delta' && frame.sessionId === id) deltas.push(frame)
  }).catch(() => {})
  cleanup = () => {
    controller.abort()
    void frameTask
    fetch(`${base}/sessions/${id}`, { method: 'DELETE' }).catch(() => {})
  }

  // A prompt that reliably thinks for a while before answering.
  const sent = await fetch(`${base}/sessions/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '先思考 1 加到 100 等于多少，一步步想，然后用一句话回答。' }),
  }).then(r => r.json())
  check('message accepted', sent.ok === true, JSON.stringify(sent))

  // Poll until the server fold exists (turn started) — this is the moment a
  // "switched back" page would fetch the session.
  let snapshot
  let sawStreamedText = false
  for (let i = 0; i < 120; i++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const body = await fetch(`${base}/sessions/${id}`).then(r => r.json())
    if (!body.live) { failures.push('GET /sessions/:id has no live field'); break }
    if (body.live.turn) {
      if (!snapshot) snapshot = body.live
      if (body.live.turn.blocks.some(block => block.text.length > 0)) sawStreamedText = true
    }
    // Result events are broadcast-only (never persisted), so completion is
    // the session leaving the busy status, not a transcript row.
    if (body.session.status !== 'busy') break
  }
  check('mid-turn snapshot carries a folded turn',
    snapshot !== undefined && Array.isArray(snapshot.turn.blocks),
    snapshot === undefined ? 'no fold appeared within 60s' : JSON.stringify(snapshot).slice(0, 200))
  if (snapshot) {
    check('snapshot has a positive seq counter',
      typeof snapshot.seq === 'number' && snapshot.seq > 0,
      `seq=${snapshot?.seq}`)
  }
  check('folded turn carries streamed text', sawStreamedText, 'no block accumulated text mid-turn')

  // Wait for the turn to finish, then verify the fold is gone and the frames
  // that streamed carry seqs.
  let done = false
  for (let i = 0; i < 240 && !done; i++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const body = await fetch(`${base}/sessions/${id}`).then(r => r.json())
    done = body.session.status !== 'busy'
  }
  check('turn completed', done, 'session stayed busy beyond 120s')
  const final = await fetch(`${base}/sessions/${id}`).then(r => r.json())
  check('fold cleared after result', final.live && final.live.turn === null,
    JSON.stringify(final.live))

  await new Promise(resolve => setTimeout(resolve, 1000))
  const withSeq = deltas.filter(frame => typeof frame.seq === 'number')
  check('SSE delta frames carry seq', deltas.length > 0 && withSeq.length === deltas.length,
    `${withSeq.length}/${deltas.length} frames carry seq`)
  const seqs = withSeq.map(frame => frame.seq)
  const monotonic = seqs.every((seq, i) => i === 0 || seq > seqs[i - 1])
  check('delta seq is monotonic', monotonic, seqs.join(','))
} finally {
  cleanup()
}

if (failures.length > 0) {
  console.error(`LIVE REPLAY PROBE FAILED (${failures.length})`)
  process.exit(1)
}
console.log('LIVE REPLAY PROBE OK')
