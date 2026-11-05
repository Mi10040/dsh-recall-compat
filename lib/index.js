// dsh-recall host entry: registers the `recall` tool on ctx.tools.
//
// The tool searches the ORIGINAL text of every DSH session through the
// official `ctx.sessionQuery` service (FTS5, auto-indexed from the persisted
// JSONL logs — including history shadowed by compaction). Results are grouped
// per session with the surrounding context window, like searching chat
// records and opening the relevant messages.
//
// Compatibility: this fork of dsh-recall@0.2.2 targets the DSH 0.2.x Host
// Service surface. Differences from the published 0.2.2 entry:
//   * `ctx.sessions.list()` yields Session instances — the plugin reads their
//     header + `snapshotEvents()` instead of the removed `.events` property.
//   * session persistence exposes `list()` / `stat()` / `open()`, not the
//     removed `listSnapshots()` / `inspect()`; persisted logs are read through
//     `sessionQuery.readSession()` with an `open(..., 'read').read()` fallback.
//   * `SessionEventResultFilter` sequence ranges are `{ from, to }`, not
//     `{ gte, lte }`.
//   * `readEvent()` returns `{ session: SessionHeader, events }` — the header
//     is no longer nested under `window.session.header`.
//   * the tool definition is authored directly (no `@deepseek-ai/dsh-tools`
//     import), so the bundle has zero npm runtime dependencies.
//
// Registered per Cordis plugin convention: named exports { name, inject,
// apply } — the loader mounts this package through a patch row
// `- id: recall / name: dsh-recall`.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FuzzyIndex, defaultIndexPath, recallIndexPath, stripText } from './fuzzy-index.js'
import { Embedder, QUERY_PREFIX } from './semantic.js'

export const name = 'recall'

export const inject = ['tools', 'sessions']

/** Semantic index is used only once at least this fraction of docs are embedded. */
const SEMANTIC_READY_COVERAGE = 0.9

/** Same-topic event merge: adjacent hits whose TEXT-BLOCK distance (doc_texts
 *  rowid gap — NOT seq, which spans tool calls/reasoning/chunks) is ≤ this
 *  value merge into one event. Measured on real data: p50 gap = 3, 61% of
 *  consecutive same-topic mentions are ≤ 5 text blocks apart (one question →
 *  answer → follow-up chain). */
const EVENT_GAP = 5

/** Coarse recall shows at most this many events per session (token budget:
 *  3 event snippets keep the coarse call ~600–800 tokens, far below the old
 *  full-context windows). */
const MAX_EVENTS_PER_SESSION = 3

// Extract human-readable text from one session event for context windows.
function eventText(event) {
  if (!event || !event.data) return ''
  const d = event.data
  if (event.type === 'user/message') {
    const c = d.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .filter(Boolean)
        .join(' ')
    }
    return ''
  }
  if (event.type === 'assistant/message') {
    const m = d.message
    const c = m && m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .filter(Boolean)
        .join(' ')
    }
    return ''
  }
  if (event.type === 'tool/call') {
    return `[tool:${d.name}] ${typeof d.arguments === 'string' ? d.arguments : ''}`
  }
  return `[${event.type}]`
}

function normText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

// ── persisted settings (edited by the Settings page, live without a reload) ──

/** Settings the Settings page can change at runtime. */
const SETTINGS_DEFAULTS = { semantic: true, warmup: 'fast', anchor: true }

/** `<dsh home>/storages/recall-settings.json`, beside the index. */
function settingsFile() {
  const index = recallIndexPath()
  const dir = index === ':memory:' ? dirname(defaultIndexPath()) : dirname(index)
  return join(dir, 'recall-settings.json')
}

/** Read the settings document, falling back to defaults for absent fields. */
function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    if (!raw || typeof raw !== 'object') return { ...SETTINGS_DEFAULTS }
    return {
      semantic: typeof raw.semantic === 'boolean' ? raw.semantic : SETTINGS_DEFAULTS.semantic,
      warmup: raw.warmup === 'gentle' ? 'gentle' : 'fast',
      anchor: typeof raw.anchor === 'boolean' ? raw.anchor : SETTINGS_DEFAULTS.anchor,
    }
  } catch {
    return { ...SETTINGS_DEFAULTS }
  }
}

/** Merge a patch into the settings document and return the stored values. */
function writeSettings(patch) {
  const next = { ...readSettings() }
  if (typeof patch.semantic === 'boolean') next.semantic = patch.semantic
  if (patch.warmup === 'fast' || patch.warmup === 'gentle') next.warmup = patch.warmup
  if (typeof patch.anchor === 'boolean') next.anchor = patch.anchor
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/** Seed the settings document from the plugin row's config on first run. */
function seedSettings(config) {
  if (existsSync(settingsFile())) return
  writeSettings({
    semantic: config.semantic !== false,
    warmup: config.warmup === 'gentle' ? 'gentle' : 'fast',
    anchor: config.anchor !== false,
  })
}

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

/** The official full-text index the literal-search fallback reads. */
function ftsIndexFile() {
  const home = dirname(dirname(defaultIndexPath()))
  return join(home, 'storages', 'session-search.db')
}

// ── corpus adapters: current Host Services → the shapes the fuzzy index wants ──

/**
 * Live sessions as `{ header, events }` records. Session instances expose
 * their immutable header plus an ascending snapshot of the whole log
 * (`snapshotEvents()` includes inherited fork history, which must stay
 * searchable).
 */
function liveSessions(ctx) {
  let sessions
  try {
    sessions = ctx.sessions.list()
  } catch {
    return []
  }
  const out = []
  for (const session of Array.isArray(sessions) ? sessions : []) {
    try {
      out.push({ header: session.header, events: session.snapshotEvents() })
    } catch {
      // a session being torn down can refuse a snapshot; skip it
    }
  }
  return out
}

/** Persisted session snapshots (`{ header, revision, ... }`), newest state only. */
async function persistedSnapshots(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.list !== 'function') return []
  try {
    return await persistence.list()
  } catch {
    return []
  }
}

/**
 * Read one complete logical session log. `sessionQuery.readSession()` is the
 * live-preferred, provider-independent path; a plain read handle is the
 * fallback for compositions without a query backend.
 */
async function readSessionLog(ctx, sessionId) {
  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery && typeof sessionQuery.readSession === 'function') {
    const snapshot = await sessionQuery.readSession(sessionId)
    if (snapshot && snapshot.session && Array.isArray(snapshot.events)) {
      return { meta: snapshot.session, events: snapshot.events }
    }
  }
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.open !== 'function') {
    throw new Error('sessionPersistence service unavailable')
  }
  const handle = await persistence.open(sessionId, 'read')
  try {
    const result = await handle.read()
    return { meta: handle.header, events: result && Array.isArray(result.events) ? result.events : [] }
  } finally {
    try {
      await handle.close()
    } catch {
      // close is best-effort
    }
  }
}

/**
 * Run one recall search: normalize the query, call searchSessions with
 * optional workspace filtering, then enrich each hit with the session title
 * and a bounded context window around its strongest match.
 */
async function runRecall(sessionQuery, args, exec, services = {}) {
  const query = normText(args && args.query)
  if (query === '') return { ok: false, error: 'query is required' }
  const limit = Math.min(Math.max(Number.isFinite(args.limit) ? args.limit : 10, 1), 50)
  const contextN = Math.min(Math.max(Number.isFinite(args.context) ? args.context : 3, 0), 10)
  const signal = exec && exec.signal ? exec.signal : undefined

  // Second stage (progressive disclosure): drill into one session's original
  // text. When present, everything else (scope filters) is bypassed — the
  // target session is explicitly user-provided.
  const detail = args.detail && typeof args.detail === 'object' ? args.detail : null
  if (detail) return runDetail(sessionQuery, query, limit, contextN, detail, services)

  // Scope resolution. The DEFAULT is the current session only — an agent must
  // never broaden the search on its own; cross-session/cross-project recall
  // happens only when the user explicitly asks (scope=workspace | all).
  const scopeArg = typeof args.scope === 'string' ? args.scope : ''
  const scope = scopeArg === 'session' || scopeArg === 'workspace' || scopeArg === 'all' ? scopeArg : null
  const agentSession = exec && exec.agent && exec.agent.session ? exec.agent.session : null
  const sessionId = agentSession ? agentSession.id : null
  const agentCwd = agentSession && agentSession.header ? agentSession.header.cwd : null
  const explicitCwd = typeof args.workspace === 'string' && args.workspace.trim() !== '' ? args.workspace.trim() : null

  // The same scope expressed twice: id/cwd filters for the fuzzy index and
  // sessionFilters for the official literal search.
  let fuzzySessionId = null
  let fuzzyCwd = null
  const sessionFilters = []
  if (scope === 'all') {
    // no session filters — every session is searched
  } else if (scope === 'workspace') {
    const cwd = explicitCwd || agentCwd
    if (cwd) {
      sessionFilters.push({ kind: 'cwd', values: [cwd] })
      fuzzyCwd = cwd
    }
  } else if (scope === 'session') {
    if (sessionId) {
      sessionFilters.push({ kind: 'id', values: [sessionId] })
      fuzzySessionId = sessionId
    } else {
      const cwd = explicitCwd || agentCwd
      if (cwd) {
        sessionFilters.push({ kind: 'cwd', values: [cwd] })
        fuzzyCwd = cwd
      }
    }
  } else {
    // default: current session, falling back to the current workspace
    if (sessionId) {
      sessionFilters.push({ kind: 'id', values: [sessionId] })
      fuzzySessionId = sessionId
    } else {
      const cwd = explicitCwd || agentCwd
      if (cwd) {
        sessionFilters.push({ kind: 'cwd', values: [cwd] })
        fuzzyCwd = cwd
      }
    }
  }

  // ── fuzzy index path (primary; degrades to the official literal search) ──
  if (services.fuzzy) {
    try {
      await services.fuzzy.reconcile({
        live: services.live,
        snapshots: services.snapshots,
        inspect: services.inspect,
      })
    } catch (error) {
      services.fuzzy = null
    }
  }
  if (services.fuzzy) {
    try {
      // Semantic layer: incremental warm-up (worker-thread, host stays
      // responsive), then — once coverage is complete — semantic hits merged
      // with the fuzzy hits. Any semantic failure silently degrades to
      // fuzzy-only.
      let semHits = []
      if (services.embedder && services.embedder.available && services.semanticEnabled !== false) {
        try {
          await services.embedder.ensureLoaded()
          const pending = services.fuzzy.pendingVectors(services.semanticBudget ?? 48)
          if (pending.length > 0) {
            const vecs = await services.embedder.embedBatch(pending.map((p) => p.text))
            services.fuzzy.storeVectors(pending.map((p, i) => ({ rowid: p.rowid, vec: vecs[i] })))
          }
          if (services.fuzzy.vectorCoverage() >= SEMANTIC_READY_COVERAGE) {
            const qVec = await services.embedder.embed(QUERY_PREFIX + query)
            semHits = services.fuzzy.semanticSearch(qVec, limit * 3, { sessionId: fuzzySessionId, cwd: fuzzyCwd })
          }
        } catch {
          // semantic unavailable: fuzzy-only below
        }
      }
      const fuzzyHits = services.fuzzy.search({ query, limit: limit * 3, sessionId: fuzzySessionId, cwd: fuzzyCwd })
      const hits = mergeHits(semHits, fuzzyHits, limit)
      if (hits.length > 0) {
        const groups = await buildGroups(sessionQuery, hits, { limit, contextN, query })
        return { ok: true, query, total: groups.length, groups }
      }
    } catch {
      // fuzzy search failed: degrade to the official literal search below
    }
  }

  // ── official literal search (phase-1 path, also the degradation target) ──
  let page
  try {
    page = await sessionQuery.searchSessions({ query, sessionFilters: sessionFilters.length ? sessionFilters : undefined, limit }, { signal })
  } catch (error) {
    return { ok: false, error: `search failed: ${error && error.message ? error.message : String(error)}` }
  }

  const hits = (page && Array.isArray(page.items) ? page.items : []).filter((h) => h && h.header && h.bestMatch)
  const groups = []
  for (const hit of hits) {
    const group = {
      sessionId: hit.header.id,
      snippet: normText(hit.bestMatch.snippet),
      context: [],
    }
    if (hit.header.cwd) group.cwd = hit.header.cwd
    if (Number.isFinite(hit.header.createdAt)) group.createdAt = hit.header.createdAt
    if (Number.isFinite(hit.bestMatch.time)) group.hitTime = hit.bestMatch.time
    try {
      const title = await sessionQuery.readTitle(hit.header.id)
      if (title && typeof title.title === 'string' && title.title !== '') group.title = title.title
    } catch {
      // title unavailable; keep the group without one
    }
    groups.push(group)
  }
  return { ok: true, query, total: groups.length, groups }
}

/**
 * Second stage (progressive disclosure): drill into one session's ORIGINAL
 * text. Three shapes:
 *   detail:{sessionId}                  — all hits inside that session (light)
 *   detail:{sessionId, seq, before, after} — exact original window around one seq
 *   detail:{sessionId, browse, fromSeq, pageSize} — page through the session
 * The target session is explicit user-provided, so no scope filter applies.
 */
async function runDetail(sessionQuery, query, limit, contextN, detail, services) {
  const sessionId = typeof detail.sessionId === 'string' && detail.sessionId !== '' ? detail.sessionId : null
  if (!sessionId) return { ok: false, error: 'detail.sessionId is required' }
  let title = null
  try {
    const t = await sessionQuery.readTitle(sessionId)
    if (t && typeof t.title === 'string' && t.title) title = t.title
  } catch {
    // title unavailable
  }

  // ── browse: page through the session's text blocks ──────────────────────
  if (detail.browse === true) {
    const fromSeq = Number.isFinite(detail.fromSeq) ? Math.max(0, Math.floor(detail.fromSeq)) : 0
    const pageSize = Math.min(Math.max(Number.isFinite(detail.pageSize) ? detail.pageSize : 20, 1), 50)
    if (services.fuzzy) {
      try {
        await services.fuzzy.reconcile({ live: services.live, snapshots: services.snapshots, inspect: services.inspect })
      } catch {
        services.fuzzy = null
      }
    }
    if (services.fuzzy) {
      try {
        const { rows, nextFromSeq } = services.fuzzy.browse(sessionId, fromSeq, pageSize)
        const group = { sessionId, context: rows.map((r) => contextRow(r.seq, r.type, r.time, r.text)) }
        if (title) group.title = title
        if (nextFromSeq !== null) group.nextFromSeq = nextFromSeq
        return { ok: true, query, total: 1, groups: [group] }
      } catch {
        // fall through to the official read
      }
    }
    try {
      const docs = await sessionQuery.filterEvents(sessionId, [
        { kind: 'seq', range: { from: fromSeq, to: fromSeq + pageSize - 1 } },
      ])
      const events = Array.isArray(docs) ? docs : []
      const group = { sessionId, context: events.map((d) => contextRow(d.seq, d.type, d.time, d.text)) }
      if (title) group.title = title
      if (events.length === pageSize) group.nextFromSeq = fromSeq + pageSize
      return { ok: true, query, total: 1, groups: [group] }
    } catch (error) {
      return { ok: false, error: `browse failed: ${error && error.message ? error.message : String(error)}` }
    }
  }

  // ── exact original-text window around one seq ───────────────────────────
  if (Number.isFinite(detail.seq)) {
    const seq = Math.floor(detail.seq)
    const before = Math.min(Math.max(Number.isFinite(detail.before) ? detail.before : contextN, 0), 10)
    const after = Math.min(Math.max(Number.isFinite(detail.after) ? detail.after : contextN, 0), 10)
    try {
      const window = await sessionQuery.readEvent({ sessionId, seq, before, after })
      const group = { sessionId }
      if (title) group.title = title
      // Current shape: `{ session: SessionHeader, events, startSeq, endSeq }`.
      const header = window && window.session ? window.session : null
      if (header && header.cwd) group.cwd = header.cwd
      if (header && Number.isFinite(header.createdAt)) group.createdAt = header.createdAt
      group.context = (window && Array.isArray(window.events) ? window.events : []).map((e) =>
        contextRow(e.seq, e.type, e.time, eventText(e)),
      )
      return { ok: true, query, total: 1, groups: [group] }
    } catch (error) {
      return { ok: false, error: `detail failed: ${error && error.message ? error.message : String(error)}` }
    }
  }

  // ── all hits inside one session (light list) ────────────────────────────
  try {
    const hits = await detailSessionHits(sessionQuery, query, limit, sessionId, services)
    const group = {
      sessionId,
      context: hits.map((h) => contextRow(h.seq, h.type || 'text', h.time, makeFuzzySnippet(h.text, query))),
    }
    if (title) group.title = title
    if (hits.length > 0) {
      if (hits[0].cwd) group.cwd = hits[0].cwd
      if (Number.isFinite(hits[0].created_at)) group.createdAt = hits[0].created_at
    }
    return { ok: true, query, total: 1, groups: [group] }
  } catch (error) {
    return { ok: false, error: `detail failed: ${error && error.message ? error.message : String(error)}` }
  }
}

/** One context row, omitting absent fields so the output schema stays clean. */
function contextRow(seq, type, time, text) {
  const row = { seq: Number.isFinite(seq) ? seq : 0, type: typeof type === 'string' ? type : 'text' }
  if (Number.isFinite(time)) row.time = time
  row.text = normText(text)
  return row
}

/** All hits inside one explicit session (semantic ∪ fuzzy, official fallback). */
async function detailSessionHits(sessionQuery, query, limit, sessionId, services) {
  if (services.fuzzy) {
    try {
      await services.fuzzy.reconcile({ live: services.live, snapshots: services.snapshots, inspect: services.inspect })
    } catch {
      services.fuzzy = null
    }
  }
  if (services.fuzzy) {
    try {
      let semHits = []
      if (services.embedder && services.embedder.available && services.semanticEnabled !== false) {
        try {
          await services.embedder.ensureLoaded()
          const pending = services.fuzzy.pendingVectors(services.semanticBudget ?? 48)
          if (pending.length > 0) {
            const vecs = await services.embedder.embedBatch(pending.map((p) => p.text))
            services.fuzzy.storeVectors(pending.map((p, i) => ({ rowid: p.rowid, vec: vecs[i] })))
          }
          if (services.fuzzy.vectorCoverage() >= SEMANTIC_READY_COVERAGE) {
            const qVec = await services.embedder.embed(QUERY_PREFIX + query)
            semHits = services.fuzzy.semanticSearch(qVec, limit * 3, { sessionId })
          }
        } catch {
          // semantic unavailable: fuzzy-only
        }
      }
      const fuzzyHits = services.fuzzy.search({ query, limit: limit * 3, sessionId })
      return mergeHits(semHits, fuzzyHits, limit)
    } catch {
      // fall through to the official search
    }
  }
  const page = await sessionQuery.searchEvents({ sessionId, query, limit })
  const items = (page && Array.isArray(page.items) ? page.items : []).filter((h) => h && Number.isFinite(h.seq))
  return items.map((h) => ({
    session_id: sessionId,
    seq: h.seq,
    type: h.type,
    time: h.time,
    text: typeof h.snippet === 'string' ? h.snippet : '',
    cwd: null,
    created_at: null,
    score: 1,
  }))
}

/**
 * Bounded snippet windowed around the first query fragment occurrence.
 */
function makeFuzzySnippet(text, query) {
  const maxChars = 240
  const clean = normText(text)
  const chars = Array.from(clean)
  if (chars.length <= maxChars) return clean
  const q = stripText(query)
  let at = -1
  if (q) {
    for (let len = Math.min(q.length, 24); len >= 2 && at < 0; len -= 1) {
      at = clean.indexOf(q.slice(0, len))
      if (at < 0) at = clean.indexOf(q.slice(q.length - len))
    }
  }
  const matchAt = at >= 0 ? at : 0
  const start = Math.max(0, matchAt - Math.floor(maxChars / 3))
  const prefix = start > 0 ? '…' : ''
  const end = Math.min(chars.length, start + maxChars - prefix.length - 1)
  const suffix = end < chars.length ? '…' : ''
  return `${prefix}${chars.slice(start, end).join('')}${suffix}`
}

/**
 * Merge semantic and fuzzy hits (both score-sorted 0..1) by doc rowid,
 * keeping the best score per doc. Returns up to limit*2 candidates.
 */
export function mergeHits(semHits, fuzzyHits, limit) {
  const byRowid = new Map()
  for (const h of fuzzyHits) byRowid.set(h.rowid, h)
  for (const h of semHits) {
    const existing = byRowid.get(h.rowid)
    if (!existing) byRowid.set(h.rowid, h)
    else if (h.score > existing.score) existing.score = h.score
  }
  return [...byRowid.values()].sort((a, b) => b.score - a.score).slice(0, limit * 2)
}

/**
 * Merge one session's hits into "events" — same-topic episodes. Consecutive
 * hits whose text-block distance (doc_texts rowid gap) is ≤ EVENT_GAP belong
 * to the same discussion and merge into one event; farther apart they start a
 * new event. Pure local heuristic — no LLM, no topic naming. Events are
 * sorted by their best hit's score, capped at MAX_EVENTS_PER_SESSION.
 * Returns [{ startSeq, endSeq, hitCount, snippet }] — the full event text is
 * one detail browse away (from startSeq until endSeq).
 */
export function buildEvents(hits, query) {
  const sorted = [...hits].sort((a, b) => a.rowid - b.rowid)
  const events = []
  let cur = null
  for (const h of sorted) {
    if (!cur || h.rowid - cur.last.rowid > EVENT_GAP) {
      cur = { hits: [h], last: h, best: h }
      events.push(cur)
    } else {
      cur.hits.push(h)
      cur.last = h
      if (h.score > cur.best.score) cur.best = h
    }
  }
  const out = events
    .map((e) => ({
      startSeq: e.hits[0].seq,
      endSeq: e.hits[e.hits.length - 1].seq,
      hitCount: e.hits.length,
      snippet: makeFuzzySnippet(e.best.text, query),
      _score: e.best.score,
    }))
    .sort((a, b) => b._score - a._score)
    .slice(0, MAX_EVENTS_PER_SESSION)
  for (const e of out) delete e._score
  return out
}

/**
 * Build coarse-recall output groups from score-sorted hits: best hit per
 * session, enriched with the session title and a short snippet — NO context
 * window (progressive disclosure: the second stage via detail drills into
 * the original text when needed). Hits of one session are additionally
 * aggregated into same-topic events (see buildEvents).
 */
async function buildGroups(sessionQuery, hits, { limit, contextN, query }) {
  const bySession = new Map()
  for (const hit of hits) {
    if (!bySession.has(hit.session_id)) bySession.set(hit.session_id, [])
    bySession.get(hit.session_id).push(hit)
  }
  const groups = []
  for (const [hitSessionId, sessionHits] of bySession) {
    if (groups.length >= limit) break
    const events = buildEvents(sessionHits, query)
    const best = events[0] || null
    const group = {
      sessionId: hitSessionId,
      snippet: best ? best.snippet : makeFuzzySnippet(sessionHits[0].text, query),
      context: [],
    }
    if (sessionHits[0].cwd) group.cwd = sessionHits[0].cwd
    if (Number.isFinite(sessionHits[0].created_at)) group.createdAt = sessionHits[0].created_at
    if (Number.isFinite(sessionHits[0].time)) group.hitTime = sessionHits[0].time
    if (events.length > 0) group.events = events
    try {
      const title = await sessionQuery.readTitle(hitSessionId)
      if (title && typeof title.title === 'string') group.title = title.title
    } catch {
      // title unavailable; keep the group without one
    }
    groups.push(group)
  }
  return groups
}

/** Background warm-up tick: embed a bounded batch, yield between chunks. */
async function warmupTick(embedder, fuzzy, warmup) {
  if (!embedder || !fuzzy) return
  try {
    await embedder.ensureLoaded()
    const budget = warmup === 'gentle' ? 16 : 64
    const pending = fuzzy.pendingVectors(budget)
    if (pending.length === 0) return
    const batchSize = 16
    for (let i = 0; i < pending.length; i += batchSize) {
      const chunk = pending.slice(i, i + batchSize)
      const vecs = await embedder.embedBatch(chunk.map((p) => p.text))
      fuzzy.storeVectors(chunk.map((p, j) => ({ rowid: p.rowid, vec: vecs[j] })))
      await new Promise((resolve) => setImmediate(resolve))
    }
  } catch {
    // silent: semantic warm-up failures never surface
  }
}

/**
 * Build the compaction anchor text for one compaction/summary event: the
 * LLM-written summary plus up to three key original fragments picked from
 * the shadowed seq range (pure-local heuristics — user messages first, then
 * the longest texts; no external LLM).
 */
export async function buildAnchorText(sessionQuery, sessionId, summaryEvent) {
  const data = summaryEvent && summaryEvent.data ? summaryEvent.data : {}
  const lines = []
  const summary = typeof data.summary === 'string' ? data.summary.trim() : ''
  if (summary) lines.push(`摘要:${summary.slice(0, 400)}`)
  const range = data.shadowedRange
  if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    try {
      const docs = await sessionQuery.filterEvents(sessionId, [
        { kind: 'seq', range: { from: range.start, to: range.end } },
      ])
      const candidates = (Array.isArray(docs) ? docs : [])
        .filter(
          (d) =>
            d &&
            (d.type === 'user/message' || d.type === 'assistant/message') &&
            typeof d.text === 'string' &&
            d.text.trim().length > 0,
        )
        .map((d) => ({ seq: d.seq, type: d.type, text: normText(d.text) }))
      candidates.sort((a, b) =>
        a.type === b.type ? b.text.length - a.text.length : a.type === 'user/message' ? -1 : 1,
      )
      for (const p of candidates.slice(0, 3)) {
        const who = p.type === 'user/message' ? '你' : '助手'
        lines.push(`[${who}#${p.seq}] ${p.text.slice(0, 160)}`)
      }
    } catch {
      // fragments unavailable; the summary alone still anchors the range
    }
  }
  lines.push('以上为本会话被压缩区间的摘要与关键原文片段。需要精确原文时用 recall 工具下钻:detail:{sessionId, seq} 或 detail:{sessionId, browse:true}。')
  return lines.join('\n')
}

// ── tool definition (authored directly; JSON Schema is the enforced subset) ──

const RECALL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      description: 'The text to search for. Plain words are best; the search is literal (no fancy syntax).',
    },
    scope: {
      type: 'string',
      enum: ['session', 'workspace', 'all'],
      description:
        'Search scope. Default "session" (current session only). "workspace" searches the current project directory (or the directory given in `workspace`); "all" searches every session. Broaden the scope ONLY when the user explicitly asks.',
    },
    workspace: {
      type: 'string',
      description:
        'Optional project directory to restrict a workspace-scoped search to (e.g. "F:\\\\AI\\\\DSH\\\\dsh-extension-hub"). Ignored for scope=session.',
    },
    limit: { type: 'integer', description: 'Maximum sessions to return (default 10, max 50).' },
    context: {
      type: 'integer',
      description: 'Events around the opened seq when using detail (default 3, max 10). Ignored by the coarse recall.',
    },
    detail: {
      type: 'object',
      additionalProperties: false,
      description:
        "Second stage: drill into one session's original text. detail:{sessionId} lists that session's hits; detail:{sessionId, seq, before, after} opens the exact original text window around a message; detail:{sessionId, browse:true, fromSeq, pageSize} pages through the session.",
      properties: {
        sessionId: { type: 'string', description: 'Session id from a previous coarse recall.' },
        seq: { type: 'integer', description: 'Message seq to open its exact original window.' },
        before: { type: 'integer', description: 'Events before seq (default 3, max 10).' },
        after: { type: 'integer', description: 'Events after seq (default 3, max 10).' },
        browse: { type: 'boolean', description: 'Page through the session starting at fromSeq.' },
        fromSeq: { type: 'integer', description: 'First seq of the browse page (default 0).' },
        pageSize: { type: 'integer', description: 'Browse page size (default 20, max 50).' },
      },
    },
  },
  required: ['query'],
}

const RECALL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    query: { type: 'string' },
    total: { type: 'number' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          createdAt: { type: 'number' },
          hitTime: { type: 'number' },
          snippet: { type: 'string' },
          events: {
            type: 'array',
            description:
              "Same-topic episodes aggregated from this session's hits (consecutive hits ≤ 5 text blocks apart merge). Read the whole event with detail:{sessionId, browse:true, fromSeq: startSeq} until seq endSeq.",
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                startSeq: { type: 'number' },
                endSeq: { type: 'number' },
                hitCount: { type: 'number' },
                snippet: { type: 'string' },
              },
              required: ['startSeq', 'endSeq'],
            },
          },
          nextFromSeq: {
            type: 'number',
            description: 'Browse mode only: first seq of the next page; absent when the log ended.',
          },
          context: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'number' },
                type: { type: 'string' },
                time: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['seq', 'type'],
            },
          },
        },
        required: ['sessionId'],
      },
    },
  },
  required: ['ok'],
}

const RECALL_DESCRIPTION = 'Search the original text of past conversations in DSH (like searching chat records in a messenger). Use it proactively whenever details from earlier turns are missing from your context — after context compaction, or when a decision, a setting, or a past discussion matters — and whenever the user mentions something from before. You do not need the user to ask for it.\n\nTWO STAGES (keeps tokens low): the default call is a light coarse recall — session titles, short snippets, and events (same-topic episodes: consecutive hits merged into [startSeq..endSeq] ranges, so repeated mentions of one topic arrive as one complete event instead of scattered fragments). Use it to locate the right session, then call again with detail:{sessionId} to list that session\'s hits, detail:{sessionId, seq} to open the exact original text around a message, or detail:{sessionId, browse:true, fromSeq: <event startSeq>} to read a whole event page by page until endSeq.\n\nSCOPE: by default this searches ONLY the current session. Do NOT broaden the scope on your own — searching other sessions or other projects happens only when the user explicitly asks (e.g. "check what the other window worked on", "look at the recall project", "search our history for ..."). Pass scope=workspace to search the current project or scope=all to search every session in those cases.\n\nPRESENTATION: the recall itself must be invisible. Never narrate the act of searching or remembering (\'let me recall\', \'I checked the history\', \'we discussed this before\') and never emit result scaffolding. Fold the recalled content directly into a normal, confident reply, exactly as if you always knew it — the user should not be able to tell that a search happened.'

function renderRecall(value) {
  if (!value || value.ok === false) {
    return [{ type: 'text', text: `Recall failed: ${value && value.error ? value.error : 'unknown error'}` }]
  }
  const lines = [`Recall "${value.query}": ${value.total} session(s) matched.`]
  for (const g of value.groups || []) {
    if (g.context && g.context.length > 0) {
      // detail stage: render the original text itself
      lines.push(`- ${g.title ? `${g.title} ` : ''}(${g.sessionId})`)
      for (const c of g.context) {
        lines.push(`  [${c.seq} ${c.type}] ${String(c.text || '').slice(0, 240)}`)
      }
      if (g.nextFromSeq !== undefined) lines.push(`  → next page from seq ${g.nextFromSeq}`)
    } else {
      lines.push(`- ${g.title ? `${g.title} ` : ''}(${g.sessionId}${g.cwd ? `, ${g.cwd}` : ''}) — ${g.snippet}`)
      if (g.events && g.events.length > 1) {
        lines.push(`  ${g.events.length} events: ${g.events.map((e) => `[${e.startSeq}..${e.endSeq}]×${e.hitCount}`).join(', ')}`)
      }
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Build the `recall` tool bound to one plugin fiber's context. */
function makeRecallTool(execute) {
  return {
    name: 'recall',
    description: RECALL_DESCRIPTION,
    parameters: RECALL_PARAMETERS,
    output: {
      schema: RECALL_OUTPUT_SCHEMA,
      render: (_args, value) => renderRecall(value),
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Recall conversation history',
      kind: 'other',
      rawInput: args && typeof args.query === 'string' ? args.query : undefined,
    }),
    async execute(args, exec) {
      try {
        return await execute(args && typeof args === 'object' ? args : {}, exec)
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) }
      }
    },
  }
}

export function apply(ctx, config = {}) {
  // Lazily-opened self-built fuzzy index (see lib/fuzzy-index.js). `fuzzy` is
  // null before first use, the index instance after a successful open, and
  // `false` after a failed open (retried on the next call).
  let fuzzy = null
  const getFuzzy = () => {
    if (fuzzy === null) {
      const candidate = new FuzzyIndex(recallIndexPath())
      try {
        candidate.open()
        fuzzy = candidate
      } catch {
        try {
          candidate.close()
        } catch {
          // already closed
        }
        fuzzy = false
      }
    }
    return fuzzy || null
  }

  // Semantic layer (optional; the Settings page can toggle it at runtime).
  seedSettings(config)
  let embedder = null
  let modelProbe = null
  const modelAvailable = () => {
    if (modelProbe === null) modelProbe = new Embedder().available
    return modelProbe
  }
  const getEmbedder = (enabled) => {
    if (!enabled) return null
    if (embedder === null) {
      const candidate = new Embedder()
      if (!candidate.available) return null
      embedder = candidate
    }
    return embedder
  }

  ctx.effect(() => () => {
    if (fuzzy) {
      try {
        fuzzy.close()
      } catch {
        // already closed
      }
    }
    fuzzy = null
    if (embedder) {
      embedder.dispose().catch(() => {})
      embedder = null
    }
  })

  // Background warm-up: a plain setTimeout chain (no service dependency —
  // inject is for REQUIRED services only; a missing timer service must not
  // block the plugin). Embedding runs in a worker thread, so the host event
  // loop stays responsive. Disposed with the plugin fiber.
  let warmupTimer = null
  const scheduleWarmup = () => {
    warmupTimer = setTimeout(async () => {
      try {
        const settings = readSettings()
        await warmupTick(getEmbedder(settings.semantic), getFuzzy(), settings.warmup)
      } catch {
        // warm-up failures never surface
      }
      scheduleWarmup()
    }, 30000)
  }
  scheduleWarmup()
  ctx.effect(() => () => {
    if (warmupTimer !== null) clearTimeout(warmupTimer)
  })

  // ── compaction anchor injection (automatic layer) ────────────────────────
  // After a compaction, inject ONE lightweight anchor (the LLM-written
  // summary + a few key original fragments) into the compacted session's
  // agent for the next few assemblies. The exact original text stays one
  // recall detail() drill-down away — progressive disclosure, not a memory
  // dump. Best-effort: any failure silently degrades to no anchor. The
  // Settings page can switch the layer off (checked per compaction).
  if (typeof ctx.on === 'function') {
    const anchors = new Map() // sessionId -> { text, rounds }
    ctx.on('session/disposed', (session) => {
      if (session) anchors.delete(session.id)
    })
    ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'compaction/summary') return
      if (readSettings().anchor === false) return
      const sessionId = session ? session.id : null
      if (!sessionId) return
      const sessionQuerySvc = ctx.get('sessionQuery')
      if (!sessionQuerySvc || typeof sessionQuerySvc.filterEvents !== 'function') return
      try {
        if (!anchors.has(sessionId)) {
          const agentsSvc = ctx.get('agents')
          const agent = agentsSvc && typeof agentsSvc.get === 'function' ? agentsSvc.get(sessionId) : null
          if (agent && agent.ctx && agent.ctx.systemPrompt && typeof agent.ctx.systemPrompt.context === 'function') {
            const entry = { text: '', rounds: 0 }
            anchors.set(sessionId, entry)
            agent.ctx.systemPrompt.context({
              name: 'recall-anchor',
              order: 500,
              text: () => {
                if (entry.rounds <= 0) return ''
                entry.rounds -= 1
                return entry.text
              },
            })
          }
        }
      } catch {
        // anchor registration is best-effort
      }
      buildAnchorText(sessionQuerySvc, sessionId, event)
        .then((text) => {
          const entry = anchors.get(sessionId)
          if (entry) {
            entry.text = text
            entry.rounds = 3
          }
        })
        .catch(() => {})
    })
  }

  const metrics = { calls: 0, errors: 0, lastAt: null, lastQuery: '', lastMs: null }
  const executeRecall = async (args, exec) => {
    const sessionQuery = ctx.get('sessionQuery')
    if (!sessionQuery) {
      return {
        ok: false,
        error: 'sessionQuery service unavailable (is @deepseek-ai/dsh-session-query-sqlite enabled in this profile?)',
      }
    }
    const settings = readSettings()
    const started = Date.now()
    const services = {
      fuzzy: ctx.get('sessions') ? getFuzzy() : null,
      embedder: getEmbedder(settings.semantic),
      semanticEnabled: settings.semantic,
      semanticBudget: settings.warmup === 'gentle' ? 16 : 48,
      live: () => liveSessions(ctx),
      snapshots: () => persistedSnapshots(ctx),
      inspect: (id) => readSessionLog(ctx, id),
    }
    try {
      const result = await runRecall(sessionQuery, args, exec, services)
      metrics.calls += 1
      metrics.lastAt = Date.now()
      metrics.lastQuery = String(args && args.query ? args.query : '').slice(0, 120)
      metrics.lastMs = Date.now() - started
      if (result && result.ok === false) metrics.errors += 1
      return result
    } catch (error) {
      metrics.errors += 1
      throw error
    }
  }

  ctx.effect(() => ctx.tools.register(makeRecallTool(executeRecall)))

  // ── Settings page transport ──────────────────────────────────────────────
  // The Web Client cannot call Host Services directly, so the pages read the
  // memory report and write settings over two same-origin routes guarded by
  // the browser connection's admission.
  //
  // Both services may mount AFTER this plugin on a cold `dsh web` boot (the
  // loader activates entries concurrently; the webserver/connection rows come
  // from later bundle layers), so registration must wait for them instead of
  // reading `ctx.get` once at apply time — the shipped connection plugin uses
  // the same `ctx.inject([...])` pattern for its own routes. Without those
  // services the recall tool still works; only the Settings page stays dark.
  const registerWhenMounted = (routeCtx) => {
    registerStatsRoutes(routeCtx, {
      getFuzzy,
      metrics,
      modelAvailable,
      readSettings,
      writeSettings,
      settingsFile,
    })
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer', 'connection'], registerWhenMounted)
  else registerWhenMounted(ctx)
}

/**
 * Serve the Settings page's memory report (`GET /recall/stats`) and runtime
 * settings edits (`POST /recall/settings`). Both require the local browser
 * peer's admission; without the connection service no route is registered.
 */
function registerStatsRoutes(ctx, hooks) {
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (!webServer || typeof webServer.register !== 'function') return
  if (!connection || typeof connection.admit !== 'function') return

  const admitted = (req) => {
    try {
      const outcome = connection.admit({ headers: req.headers })
      return !(outcome && 'rejection' in outcome)
    } catch {
      return false
    }
  }

  const send = (res, status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  // Prime the index for the report: the Settings page can be the first thing a
  // user opens, so the page reconciles the corpus itself (throttled; after the
  // first pass this is an incremental fingerprint check).
  let lastRefresh = 0
  let refreshing = null
  const refreshIndex = () => {
    if (refreshing !== null) return refreshing
    if (Date.now() - lastRefresh < 15000) return Promise.resolve()
    const fuzzy = hooks.getFuzzy()
    if (!fuzzy) return Promise.resolve()
    refreshing = (async () => {
      try {
        await fuzzy.reconcile({
          live: () => liveSessions(ctx),
          snapshots: () => persistedSnapshots(ctx),
          inspect: (id) => readSessionLog(ctx, id),
        })
        lastRefresh = Date.now()
      } catch {
        // a failed pass reports whatever is already indexed
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  const snapshot = () => {
    const settings = hooks.readSettings()
    const indexPath = recallIndexPath()
    let fuzzy = null
    try {
      fuzzy = hooks.getFuzzy()
    } catch {
      fuzzy = null
    }
    let index = { sessions: 0, docs: 0, vectors: 0, pending: 0, coverage: 1, lastDocTime: null, lastSeq: null }
    if (fuzzy) {
      try {
        index = { ...index, ...fuzzy.report() }
      } catch {
        // report unavailable: keep the empty shape
      }
    }
    return {
      now: Date.now(),
      settings,
      index: {
        path: indexPath,
        open: Boolean(fuzzy),
        bytes: fileSize(indexPath),
        walBytes: fileSize(`${indexPath}-wal`),
        settingsPath: hooks.settingsFile(),
        ...index,
      },
      fts: { path: ftsIndexFile(), bytes: fileSize(ftsIndexFile()) },
      runtime: {
        modelAvailable: hooks.modelAvailable(),
        semantic: settings.semantic,
        warmup: settings.warmup,
        anchor: settings.anchor,
      },
      recall: { ...hooks.metrics },
    }
  }

  const readBody = async (req, limit = 8192) => {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new Error('settings body too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: '/recall/stats',
      handler: async (req, res) => {
        if (!admitted(req)) return send(res, 401, { error: 'unauthorized' })
        if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
          return send(res, 405, { error: 'method not allowed' })
        }
        try {
          await refreshIndex()
          send(res, 200, snapshot())
        } catch (error) {
          send(res, 500, { error: error && error.message ? error.message : String(error) })
        }
      },
    }),
  )

  ctx.effect(() =>
    webServer.register({
      kind: 'exact',
      path: '/recall/settings',
      handler: async (req, res) => {
        if (!admitted(req)) return send(res, 401, { error: 'unauthorized' })
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
        try {
          const raw = await readBody(req)
          const patch = raw ? JSON.parse(raw) : {}
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new Error('invalid settings body')
          }
          hooks.writeSettings(patch)
          send(res, 200, snapshot())
        } catch (error) {
          send(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      },
    }),
  )
}
