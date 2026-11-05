// Local smoke test for this package: fuzzy index + semantic worker, no Host.
//   node smoke.mjs
import { FuzzyIndex } from './lib/fuzzy-index.js'
import { Embedder } from './lib/semantic.js'

const header = { version: 4, id: 'session-a', createdAt: 1780000000000, cwd: 'C:\\work\\proj' }
const events = [
  { type: 'user/message', seq: 0, time: 1780000000001, data: { role: 'user', content: [{ type: 'text', text: '我们决定把插件的索引放在 storages 目录下。' }] } },
  { type: 'assistant/message', seq: 1, time: 1780000000002, data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，使用 recall-index.db。' }] } } },
  { type: 'user/message', seq: 2, time: 1780000000003, data: { role: 'user', content: [{ type: 'text', text: '另外压缩锚点注入三轮后过期。' }] } },
]
const headerB = { version: 4, id: 'session-b', createdAt: 1780000001000, cwd: 'C:\\work\\other' }
const eventsB = [
  { type: 'user/message', seq: 0, time: 1780000001001, data: { role: 'user', content: [{ type: 'text', text: 'hello world, deployment notes for the recall plugin' }] } },
]

const index = new FuzzyIndex(':memory:').open()
const reindexed = await index.reconcile({
  live: () => [
    { header, events },
    { header: headerB, events: eventsB },
  ],
  snapshots: () => Promise.resolve([]),
  inspect: () => Promise.reject(new Error('no persisted sessions in this test')),
})
console.log('reconcile:', JSON.stringify(reindexed), 'stats:', JSON.stringify(index.stats()))

const zhHits = index.search({ query: '索引放哪里', limit: 10 })
console.log('fuzzy zh hits:', zhHits.length, zhHits[0] && { seq: zhHits[0].seq, score: zhHits[0].score.toFixed(3) })
const scoped = index.search({ query: 'deployment', limit: 10, sessionId: 'session-b' })
console.log('scoped hit sessions:', [...new Set(scoped.map((h) => h.session_id))].join(','))
const cwdScoped = index.search({ query: '锚点', limit: 10, cwd: 'C:\\work\\other' })
console.log('cwd-scoped hits (expect 0):', cwdScoped.length)
const page = index.browse('session-a', 0, 2)
console.log('browse:', page.rows.map((r) => `${r.seq}:${r.type}`).join(','), 'next:', page.nextFromSeq)
const pending = index.pendingVectors(10)
console.log('pending vectors:', pending.length)

// Semantic layer: real model + worker thread.
const embedder = new Embedder()
console.log('model available:', embedder.available)
if (embedder.available) {
  const t0 = Date.now()
  await embedder.ensureLoaded()
  const vecs = await embedder.embedBatch(['索引放在哪个目录', '压缩锚点过期'])
  console.log('embedded dims:', vecs[0].length, 'norm:', Math.hypot(...vecs[0]).toFixed(4), 'ms:', Date.now() - t0)
  index.storeVectors(pending.slice(0, vecs.length).map((p, i) => ({ rowid: p.rowid, vec: vecs[i] })))
  console.log('coverage:', index.vectorCoverage().toFixed(2))
  const q = await embedder.embed('索引放在哪个目录')
  const sem = index.semanticSearch(q, 3, { sessionId: 'session-a' })
  console.log('semantic hits:', sem.length, sem[0] && { seq: sem[0].seq, score: sem[0].score.toFixed(3) })
  await embedder.dispose()
}
index.close()
console.log('SMOKE OK')
