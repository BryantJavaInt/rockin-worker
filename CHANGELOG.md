# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows [Semantic Versioning](https://semver.org/).

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
