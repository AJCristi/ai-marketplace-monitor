---
orphan: true
---

# Development and verification for agents

Run commands from the repository root. Read [AGENTS.md](../../AGENTS.md) first;
[architecture.md](architecture.md) maps code ownership and shared contracts.

## Setup

Python requirements and dependency sets live in [pyproject.toml](../../pyproject.toml);
`uv.lock` records resolution. Use the supported Python range there, with
[the CI matrix](../../.github/workflows/tests.yml) defining tested versions.

```powershell
uv sync --all-extras
uv run inv --list
```

Check each command's result before continuing. Do not regenerate the lockfile merely
to inspect the project. If `uv` is unavailable, check the existing environment before
installing anything. For an already-provisioned Windows environment:

```powershell
.\.venv\Scripts\python.exe -m invoke --list
```

Direct module commands such as `python -m pytest` or `python -m sphinx` can use that
same interpreter if the modules are installed. Invoke tasks themselves call `uv`
internally, so invoking a task through Python does not remove its `uv` requirement.
Report missing tools or dependencies as setup blockers rather than successful checks.

Only install Playwright browsers when a check needs them:

```powershell
uv run playwright install chromium
```

The HTML parsing tests use local fixture files, but still launch a real browser.
They do not need Facebook credentials. Linux CI uses Playwright's `--with-deps` setup;
do not copy Linux system-package commands into PowerShell.

## Choose checks for the changed behavior

| Change | Relevant existing coverage |
| --- | --- |
| CLI/config loading | `tests/test_cli.py`, `tests/test_aimm.py` |
| Facebook parsing/filtering | `tests/test_facebook.py`, `tests/test_facebook_keyword_filtering.py`, `tests/test_facebook_sort_by.py` |
| AI prompts | `tests/test_ai.py` (live provider evaluation is skipped) |
| Notifications | `tests/test_notification.py` |
| Config editing/masked secrets | `tests/test_webui_config_api.py`, `tests/test_webui_secrets_redact.py`, Node form tests |
| Credentials/sessions | `tests/test_webui_config_auth.py`, `tests/test_webui_auth.py` |
| Monitor controls/events | `tests/test_webui_monitor_control.py`, `tests/test_webui_log_handler.py`, Node console tests |
| CSV export | `tests/test_found_export.py` |
| Shared utilities | `tests/test_utils.py` |

For example, a focused config service check is:

```powershell
uv run pytest tests/test_webui_config_api.py tests/test_webui_secrets_redact.py
```

Frontend tests use Node's built-in runner and the checked-in assets. No package
installation or bundling step is needed; Node 22 is available in this workspace.

```powershell
node --test tests/test_webui_console.mjs tests/test_webui_forms.mjs
```

These tests cover model/form behavior, including real TOML WASM parsing and editing;
they do not establish browser rendering, focus behavior in an actual browser, or
end-to-end login. Run browser acceptance when the task requires that evidence.

Use the existing `config_file` and `temp_cache` fixtures in `conftest.py`, or `tmp_path`,
and patch the cache reference used by the code under test. Importing the application
can open its default user cache; temporary fixtures are not global process isolation.
Mock external AI, Facebook, SMTP, and notification I/O. For Telegram's synchronous
wrappers around async operations, follow nearby notification tests to avoid nested
`asyncio.run` calls in an already-running test event loop.

## Broader completion checks

[tasks.py](../../tasks.py) defines the local commands;
[noxfile.py](../../noxfile.py) and CI define the matrix. For relevant Python changes,
the local equivalents are:

```powershell
uv run inv tests
uv run inv mypy
uv run pre-commit run --all-files
```

The test task includes doctests and coverage collection. It explicitly overrides the
coverage failure threshold to zero; a passing test run does not imply 100% coverage.
The separate coverage report uses the threshold from `pyproject.toml`.

CI runs pre-commit, then Nox tests and typing on Ubuntu/macOS and its Python matrix.
The Node tests are additional local coverage: they are not currently invoked by that
workflow or `inv tests`. Do not claim a local run covers the OS/Python matrix.

Pre-commit can rewrite files and update `uv.lock`; `inv lint` can also apply Ruff fixes.
Inspect resulting changes. In a shared dirty worktree, use scoped hooks for the files
you changed and report that the whole-repo check was deferred if it could affect
unrelated work:

```powershell
uv run pre-commit run --files AGENTS.md docs/agents/architecture.md docs/agents/development.md
```

Reuse relevant passing checks. Broaden checks after corrections only when the impact
cannot be bounded or repository policy requires it. Do not lower thresholds or alter
unrelated tests to turn a failing baseline green.

## Documentation and task side effects

For Sphinx source changes, build without regenerating API source files:

```powershell
uv run sphinx-build -b html docs docs/_build
```

Review warnings as well as the exit status. `inv docs` first runs `sphinx-apidoc -f`,
which can overwrite generated `.rst` sources. Use it only when regeneration is intended.
The agent reference pages use MyST's `orphan` metadata because they are reached from
the root guide rather than the user-documentation table of contents.

`inv clean*` tasks contain Unix `rm`/`find` commands and are not a Windows cleanup
recipe. Avoid them for routine verification. `inv release` uploads to PyPI, and
`inv version` changes version files; neither is a test or an ordinary completion step.
