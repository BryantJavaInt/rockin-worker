# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- OpenTelemetry tracing: spans for sync runs and pages, HTTP client calls, tool executions and agent turns (GenAI semantic conventions, including token and cache usage). Exported over OTLP/HTTP only when an endpoint is configured; best-effort, privacy-preserving (no prompt, completion or tool-output content, no query strings), and free when disabled.
- Remote MCP over streamable HTTP (`serve --http`): stateless, POST-only, bearer-token authentication (constant-time, env-only, fail-closed, 24-character minimum), `Host`/`Origin` validation against DNS rebinding, body-size cap, `/healthz`, graceful shutdown.
- Semantic search: an `EmbeddingProvider` port with a Voyage AI implementation, float32 vectors stored in SQLite, an incremental indexer (`embed`, `sync --embed`, automatic in worker mode) and hybrid ranking that fuses lexical and semantic results with Reciprocal Rank Fusion. Optional: without a key, index or provider it degrades to lexical ranking with an explanatory note. Tools may now be asynchronous.
- Ranked full-text search (FTS5, Porter stemming, BM25) over repository name/description/topics and Notion titles, replacing substring matching, with a substring fallback. GitHub sync now also stores description, language, topics and URL.
- Resumable backfill: a sync pass that exceeds the page budget saves its cursor and resumes on the next run, so large accounts finish in several runs instead of never advancing. Deletions are now detected with the pass start time instead of a set of seen keys, which also works across runs (`SyncAdapter.keyOf` is removed; `prune` takes the pass start time).
- `sync --full` prunes records deleted upstream (optional `keyOf`/`prune` on `SyncAdapter`), only after a complete, error-free, uncapped run and never on an empty upstream response.
- Worker mode: `sync --every 15m` with jitter and non-overlapping cycles; failing cycles are logged and do not stop the worker. `core/duration` and `core/sync/watch` are new pure, tested modules.
- Graceful shutdown: SIGINT/SIGTERM finish the current cycle and close the MCP transport and database.
- MCP tools declare an output schema and return typed `structuredContent` alongside the text content; a contract test checks every tool.
- Prompt caching for the agent (system prompt and tool definitions), with cache read/write token accounting.

### Changed
- `describeError` moved from `core` to `infra` (it is a generic utility, and `infra` may not depend on `core`).
- **Breaking:** `github_searchByName` / `notion_searchByName` are now `github_search` / `notion_search`, since they search more than names. Migration v4 rebuilds `notion_pages` with a surrogate integer key.
- The HTTP client handles GitHub primary rate limits (`403` + `X-RateLimit-Reset`) and gives up on any server-directed wait longer than `maxRetryWaitMs` (default 60 s) instead of blocking. `isRetryable` now receives the whole `Response`.

## [2.0.0] — 2026-09-20

### Added
- Notion as a second source, built on the same engine as GitHub.
- Generic sync engine (`core/sync/engine.ts`): incremental watermark sync, per-page transactions, `--full` resync, structured JSONL run log.
- Tool-use agent loop (`ask`) and end-to-end evals with tool-routing, grounding and prompt-injection cases.
- Unified CLI: `sync`, `ask`, `tool`, `serve`. `tool` takes flags (`--limit 5`) so it behaves the same in bash, PowerShell and cmd; unknown flags are rejected rather than silently ignored.
- Versioned SQLite migrations (`PRAGMA user_version`), WAL mode, indexes for the tool queries.
- Environment validation (Zod) and typed HTTP errors.
- Dockerfile (multi-stage, non-root), CI (lint, typecheck, build, coverage, Docker smoke test), Dependabot, Biome.
- Authorship metadata: SPDX + copyright header on every source file, structured `author`/`homepage`/`bugs` in `package.json`, `CITATION.cff`, `.github/CODEOWNERS`, OCI authorship labels on the Docker image, and `version`/`--version` (also credited in `help` and in the MCP server info). `src/ownership.test.ts` keeps all of it consistent with `LICENSE`.
- MIT license, `CONTRIBUTING.md` and `SECURITY.md` (with a short threat model).
- Layered package structure (`config`, `infra`, `core`, `sources`, `tools`, `mcp`, `agent`, `evals`, `cli`) with an architecture test that enforces dependency direction, forbids cycles and keeps sources isolated.

### Changed
- **Breaking:** the project is now ESM and Node ≥ 24; source moved from a flat `src/` + `lib/` to layered packages (see docs/ARCHITECTURE.md); scripts and tool names changed (`github_getTopItems`, …).
- Tools return `lastSyncAt` from the last successful *sync run* instead of inferring it from a result row, and explain empty results (`note`).
- Upserts are a single atomic `INSERT … ON CONFLICT DO UPDATE`.
- HTTP client honors `Retry-After`, times out hung requests, and retries network errors.
- GitHub pagination follows the `Link` header (previously fetched one extra empty page).
- MCP tools carry `readOnlyHint` annotations.

### Security
- Updated transitive dependencies of the MCP SDK (`hono`, `qs`, `fast-uri`) and `vitest` to clear all `npm audit` advisories (1 high, 5 moderate). CI now fails on high/critical advisories in shipped dependencies. The advisories affected HTTP code paths this stdio-only server does not run, but they are fixed regardless.

### Fixed
- `.env.example` used inline comments, which `docker run --env-file` would have appended to token values; comments now sit on their own lines.
- The watermark advanced even when the page budget ran out, permanently skipping older records.
- Records edited within the same timestamp tick as the previous sync could be missed (`<=` cutoff → `<`).
- `searchByName` treated `%` and `_` in the query as SQL wildcards, so a model-supplied `%` matched everything.
- Tests wrote to the developer's real `data.db`; they now run against an isolated in-memory database.
- `dotenv` logged to stdout, which would have corrupted the MCP stdio protocol.

## [1.0.0]
- GitHub sync → SQLite → two tools, exposed over MCP.
