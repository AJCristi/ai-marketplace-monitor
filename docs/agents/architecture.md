---
orphan: true
---

# Architecture for agents

Read [AGENTS.md](../../AGENTS.md) for working rules and
[development.md](development.md) for verification commands. This is a navigation
map; follow the linked implementation for current behavior.

## Locate the change

Paths below are relative to `src/ai_marketplace_monitor/`.

| Area | Start with | Responsibility |
| --- | --- | --- |
| Entry points | `cli.py` | Typer CLI, logging, default config seeding, monitor and web UI startup/shutdown |
| Orchestration | `monitor.py` | Synchronous Playwright lifecycle, scheduling, config reload, search/evaluate/notify flow |
| Configuration | `config.py`, `utils.py`, `config.toml` | TOML loading and merging, config dataclasses, validation, packaged defaults |
| Marketplace | `marketplace.py`, `facebook.py`, `listing.py` | Base interfaces, Facebook search and parsing, listing data |
| AI | `ai.py` | Provider configs, prompts, evaluation, response handling |
| Notifications | `user.py`, `notification.py`, provider modules | User routing, notification status and delivery; providers include email, Telegram, ntfy, Pushbullet, and Pushover |
| Shared state | `utils.py`, `region.py` | Disk cache, counters, events, waiting, keyword matching, regions |
| HTTP and WebSocket API | `webui/server.py` | FastAPI routes, static assets, auth dependencies, log streaming, CSV export |
| Config editor backend | `webui/config_api.py`, `webui/secrets_redact.py` | Editable-file contract, validation, redaction/restoration, conflict handling, atomic save |
| Web authentication | `webui/auth.py`, `webui/config_auth.py` | Password/session handling, rate limiting, credential extraction |
| Console | `webui/static/app.js`, `console-model.js`, `fields.js`, `index.html`, `app.css` | UI, event model, form schemas and defaults, layout and styling |
| Log and export data | `webui/log_handler.py`, `webui/found_export.py` | Thread-to-event-loop log bridge, redacted records, cached-listing CSV serialization |
| Matches library | `matches.py`, `match_store.py`, `photos.py`, `recheck.py`, `webui/static/matches.js` | Durable SQLite matches and WebP galleries, exact-ID sightings/history, shared personal state, and monitor-thread re-check jobs; see [Matches](../matches.md) |
| Image matching | `image_matching.py`, `webui/static/related.js` | Budgeted MiMo photo comparisons, monitor-thread jobs, saved connection evidence and reviews; settings live in `MonitorConfig` |

## Configuration is shared across layers

`Config` loads the packaged `config.toml` first, then supplied files in order;
later values override earlier values through `merge_dicts`. `MarketplaceMonitor`
prepends the user's default config, when present, to files passed through the CLI.
Validation also resolves references and expands regions and notification settings.

The web editor exposes only the last supplied file as `primary`. Its context includes
inherited configuration. Reads mask secrets; writes check the supplied base modification
time, restore masks, validate the merged configuration, and replace the file using a
temporary file in the same directory. Preserve that ordering in `ConfigFileService.write`.

For a new or changed config field, inspect its Python dataclass/validation, packaged
defaults, `fields.js`, form conversion in `app.js`, and config API context. Update
only the affected layers and documentation. Test inheritance and serialization when
they matter; a visually correct form can still save the wrong TOML type or override.

The frontend uses vendored `toml-edit-js` JavaScript/WASM to edit TOML and CodeMirror
for raw editing. Preserve comments and formatting through the existing editor.
Vendored assets live under `webui/static/vendor/`; inspect their license/version
metadata before an intentional upgrade.

## Monitor and server run on different threads

The monitor uses synchronous Playwright. Uvicorn has its own asyncio loop in a daemon
thread. `LogBroadcastHandler` schedules delivery with `loop.call_soon_threadsafe`.
`MarketplaceMonitor.request_search` sets a threading event that the monitor consumes
at a safe point, and `request_item_search` queues one saved search the same way; the HTTP handler must not perform Playwright work directly.
During a search, `search_item` sends AI ratings to a single worker thread so they
overlap the browser opening the next listing. Results are applied on the monitor
thread in listing order. `cancel_search` sets an event that the marketplace loop
checks before each listing.

Structured records produced by `aimm_event` are consumed by the console model.
Changes to event names or fields need review of the producer, log serializer, and
JavaScript consumer, with relevant Python and Node tests.

## Security and persistence boundaries

- Loopback UI access is open by design. Non-loopback startup requires credentials;
  `AIMM_WEBUI_LOCAL_ONLY` is an explicit deployment exception. Keep exposure decisions
  in the existing auth path. See [web UI documentation](../webui.md).
- Authenticated mutations use session and CSRF checks. HTTP, WebSocket, and export
  access need their existing authentication coverage when changed.
- Config masking and log redaction are separate mechanisms. New secret fields must
  be checked against both, including error messages and round trips through the UI.
- Cached listings, AI results, notification state, and counters support later runs.
  Changes to cache keys or payloads must consider existing data. CSV export derives
  rows from this cache and sanitizes spreadsheet formula prefixes.

Designs under `docs/superpowers/` and `docs/telegram_support_prd.md` provide historical
context. Confirm claims against current code and tests before using them as requirements.
