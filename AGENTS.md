# Agent guide

AI Marketplace Monitor is a Python application that searches Facebook Marketplace,
optionally rates listings with AI, and sends notifications. Its embedded FastAPI
server serves a plain JavaScript console; there is no frontend build pipeline.

## Start here

- Inspect `git status --short` and the current branch before editing. Preserve
  existing changes; if they conflict with the task, stop and ask how to proceed.
- Read nearby code and tests before choosing an implementation. Resolve the target
  ref, expected behavior, and a runnable verification path before substantial work.
- Use [the architecture map](docs/agents/architecture.md) to find the relevant
  modules and [the development guide](docs/agents/development.md) for commands and
  test selection. Human contribution guidance is in [CONTRIBUTING.md](CONTRIBUTING.md).
- Treat source, `pyproject.toml`, `tasks.py`, and CI configuration as the authority
  when descriptive documentation disagrees. Update affected guidance with the code.

## Working rules

- Make the smallest correct change. Prefer the standard library, native platform
  features, and installed dependencies over new abstractions or dependencies.
- Follow existing patterns. Avoid speculative compatibility layers and broad
  refactors. Explain any necessary new dependency.
- This workspace uses Windows PowerShell. Use Windows paths in shell commands;
  PowerShell 5.1 does not support `&&`. Run dependent commands separately and check
  their exit status. The project also runs on Linux and macOS; keep code portable.
- Use `uv` for Python dependencies and the existing Node test runner for JavaScript.
  Do not introduce npm/Bun project scaffolding for the static console.
- Delegate only when requested or when applicable instructions explicitly call for
  parallel agent work; keep routine lookups and mechanical checks local.

## Protect runtime data and contracts

- `Path.home() / ".ai-marketplace-monitor"` contains runtime configuration and cache
  data. Importing `utils.py` opens that cache. Do not clear it, read credentials into
  tool output, or use it as test data. Prefer temporary config files and caches.
- Never print, commit, or move secrets. Use placeholders in examples. Do not start
  the live monitor or send real notifications as routine verification; use fixtures
  and mocked external services unless live operation is part of the authorized task.
- Preserve config merge order, validation, masked-secret restoration, stale-write
  detection, and atomic writes. Config changes often affect both Python validation
  and JavaScript forms; see the architecture guide.
- Keep synchronous Playwright work on the monitor thread. Web requests should
  signal the monitor through its existing callback/event boundary.
- Preserve exposed-server authentication, CSRF checks, and log redaction. Do not
  enable open network access to make a test or preview easier.

## Verification and delivery

- Extend existing coverage for a distinct behavior or failure mode. Non-trivial
  logic needs a small runnable regression check; avoid tests of constants or mocks.
- Choose checks from the development guide. Reuse successful results while their
  inputs remain unchanged, and distinguish focused checks from full CI coverage.
- Browser acceptance is optional unless requested, required by acceptance criteria,
  or needed for a concrete browser uncertainty. Existing Playwright fixture tests
  still belong to the Python suite.
- Check for formatter, hook, lockfile, or generated-document changes after checks.
  Do not stage unrelated changes or overwrite another contributor's work.
- Never commit automatically. Before proposing a commit, inspect `git status` and
  `git diff`, propose an atomic Conventional Commit (`type(scope): subject`, lower-case
  imperative subject, at most 72 characters, no trailing period), and wait for explicit
  approval. Never force push to `main` or `master`.
- Report what changed, checks and their outcomes, and remaining limitations. Do not
  claim live/browser behavior from unit tests. Keep verbose logs out of the response.
