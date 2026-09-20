# Contributing

Thanks for taking an interest. This is a small codebase with a strict shape; the checks below keep it that way.

## Setup

```bash
# Node 24 is required (see .nvmrc; `nvm use` on macOS/Linux)
npm install
cp .env.example .env    # only needed to run against real APIs — tests never read it
```

## Before you open a pull request

```bash
npm run check           # lint + typecheck + tests + coverage floor (the same as CI)
```

`npm run format` applies Biome's formatting and import ordering.

## Ground rules

- **Respect the layers.** Packages import only downward (`config → infra → core → sources → tools → mcp/agent/evals → cli`). `src/architecture.test.ts` fails the build on a wrong-way import, an import cycle, or one data source importing another. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Validate at the boundary.** Anything from an upstream API or from a model goes through a Zod schema before it touches the store.
- **Tools are read-only.** They read the local snapshot and never call upstream APIs or write data.
- **Never edit a shipped migration.** Add a new entry to `infra/db/migrations.ts`.
- **Tests must be hermetic.** No real network, no real `.env`, no real database — the test setup already pins an in-memory database. Use `vi.stubGlobal('fetch', …)` for HTTP.
- **Fix the cause, then pin it with a test.** A bug fix ships with the test that would have caught it.
- **Docs are part of the change.** If behavior, configuration or a command changes, update the README and, where relevant, `docs/ARCHITECTURE.md` and `CHANGELOG.md` in the same pull request.

## Adding a data source

Follow the five steps in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#adding-a-source). The architecture test will tell you if anything ended up in the wrong place.

## Licensing of contributions

By submitting a contribution you agree that it is licensed under the project's [MIT License](LICENSE) and that you have the right to submit it. Copyright in your contribution remains yours. Do not remove or alter the SPDX/copyright header of existing files, and add the same two-line header to every new source file — `src/ownership.test.ts` fails the build when one is missing.

## Commit messages

Imperative mood, subject under ~72 characters, and a body explaining *why* when the change isn't obvious (`Advance the watermark only on a complete run`, not `fix bug`).

## Evals

`npm run eval` calls the Anthropic API and costs tokens, so it is not run in CI. Run it, and note the score in the pull request, when you change tool descriptions, tool schemas or the system prompt.
