# dsh-recall (0.2.2-compat.3)

A compatibility fork of `dsh-recall@0.2.2` for the **current DeepSeek Harness
0.2.x Host Service surface** (verified against `dsh 0.2.1-rc.5`).

Everything the 0.2.2 plugin does is preserved:

- the `recall` tool: three-layer retrieval (official FTS5 literal / self-built
  trigram+bigram fuzzy / local bge-small-zh int8 semantic) with progressive
  disclosure (`detail:{sessionId}`, `detail:{sessionId, seq}`,
  `detail:{sessionId, browse:true}`) and same-topic event aggregation;
- the compaction anchor: after a real `/compact`, one lightweight anchor
  (summary + up to 3 original fragments) is injected for 3 assemblies;
- silent degradation: semantics → fuzzy → literal, never an error;
- the invisible ToolView (“回忆中…” → “回忆完成”);
- fully offline operation: the ONNX model and the onnxruntime-web WASM runtime
  ship in the package, so there are **zero npm runtime dependencies**.

Added in this fork:

- **Settings → “Recall 记忆”** page with the live memory report (sessions,
  indexed memories, semantic coverage bar, index size, embedding backlog,
  model availability, last recall, index paths) and the runtime settings
  (semantic layer, warm-up pace, compaction anchor) that apply immediately.

## Settings page and memory report

The Host serves the page's data over two same-origin routes, both guarded by
the browser connection's admission (the local peer cookie):

| Route | Purpose |
|---|---|
| `GET /recall/stats` | memory report + current settings + last-recall metrics |
| `POST /recall/settings` | merge `{ semantic, warmup, anchor }` edits |

The first report also primes the index (a throttled reconcile), so the numbers
are real even before the `recall` tool has ever run. Settings live in
`<dsh home>/storages/recall-settings.json` and are re-read per recall and per
warm-up tick, so a switch takes effect without restarting `dsh web`.

The routes are registered inside `ctx.inject(['webServer', 'connection'], …)`:
the Loader activates entries concurrently, and on a cold `dsh web` boot the
webserver and browser-connection rows can finish mounting *after* this plugin
applies. Reading `ctx.get('webServer')` once at apply time silently skipped the
routes (the Settings page then showed HTTP 404 until a plugin reload). The
Cordis dependency injection keeps the callback pending until both services
exist, so the page works on every boot — and the bundle still loads fine in
compositions that never mount a Web server.

After installing or updating the **client half**, refresh the Web page once
(the browser caches the served client module); Host code changes need a
`dsh web` restart, or a disable/enable toggle of the `recall` plugin.

## Why a fork was needed

`dsh-recall@0.2.2` (and 0.3.0) were built against the 0.1.x Host Services and
fail or degrade silently on 0.2.x. This fork changes only the integration
surface:

| 0.2.2 usage | 0.2.x reality | Fix in this package |
|---|---|---|
| `ctx.sessions.list()` → objects with `.events` | `Session` instances | `header` + `session.snapshotEvents()` |
| `sessionPersistence.listSnapshots()` | removed | `sessionPersistence.list()` |
| `sessionPersistence.inspect(id)` → `{ meta, events }` | removed | `sessionQuery.readSession(id)`, fallback `open(id, 'read').read()` |
| `filterEvents(..., { range: { gte, lte } })` | `SessionResultRange` is `{ from, to }` | `{ range: { from, to } }` |
| `readEvent(...).session.header` | `window.session` **is** the header | read `window.session` directly |
| `defineTool()` from `@deepseek-ai/dsh-tools@^0.1.0-rc.6` | 0.2.x registry; dependency range unsatisfiable | tool authored directly against the enforced JSON-Schema subset |
| Client ToolView inspected `block.kind` | slot supplies `phase` + that phase’s node | switch on `props.phase === 'result'`, read `block.isError` |

The result format, ranking, token budget, scope rules and tool description are
unchanged from 0.2.2.

## Install

From this checkout:

```sh
dsh plugin --profile web add <absolute-path-to-this-package>
```

or install the bundle through the Plugin Manager (`install_bundle` with this
directory as the target), then restart `dsh web`.

The bundle patch inserts the `recall` row and switches the official
`session-query-sqlite` row from `openAt: never` to a durable FTS index at
`<dsh home>/storages/session-search.db`. The fuzzy/semantic index lives at
`<dsh home>/storages/recall-index.db`.

## Configuration

The Settings page owns the three runtime switches; the row config only seeds
them on first run (and stays useful for headless deployments):

```yaml
- id: recall
  name: dsh-recall
  config:
    semantic: false   # keep literal + fuzzy only (skips the ONNX model)
    warmup: gentle    # slower background embedding warm-up
    anchor: false     # disable the post-compaction anchor
```

Seeds are written once to `<dsh home>/storages/recall-settings.json`; later
edits come from the Settings page and win over the row config.

## Layout

| File | Role |
|---|---|
| `lib/index.js` | tool registration, scope resolution, hybrid ranking, session/event aggregation, compaction anchor, warm-up, settings document, stats routes |
| `lib/fuzzy-index.js` | self-built SQLite index (trigram FTS + bigram rerank + vectors), `node:sqlite` only, plus the memory report |
| `lib/semantic.js`, `lib/embed-worker.js` | worker-thread ONNX embedding (bge-small-zh-v1.5, int8) |
| `lib/tokenizer.js` | pure-JS BERT WordPiece tokenizer |
| `lib/vendor/` | vendored onnxruntime-web entry + WASM + tokenizer.json |
| `models/model_merged.onnx` | merged int8 model (~23 MB), bundled |
| `lib/client.js` | the quiet ToolView and the “Recall 记忆” Settings page |

## License

MIT. Model: BAAI/bge-small-zh-v1.5 (MIT), onnx-community int8 export;
onnxruntime-web (MIT). Original plugin: dsh-recall by Relistencode (MIT).
