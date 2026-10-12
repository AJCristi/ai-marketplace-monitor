# Design: Search assistant chat (Web UI)

**Date:** 2026-10-12
**Branch:** `feat/ai-search-chat`
**Status:** Implemented. MiMo's web search fields are taken from a working
open-source integration; not yet verified with a live call.
**Replaces:** the one-line input from [Fill a new search with AI](2026-10-12-ai-fill-search-design.md)

## Summary

The search form (new and existing searches) gets a chat panel on the right. The user
describes what they want; the AI asks short questions only when the request is vague,
and every reply that settles something updates the form immediately. Nothing is saved
until **Save**, so config validation, stale-write detection and atomic writes are
unchanged. An optional **Search the web** tickbox lets the AI use its provider's own
web search when it cannot place the item from its own knowledge.

## Behavior

- **Panel.** Right of the form, sticky while the form scrolls. Below ~1000px it stacks
  above the form. Search forms only (`prefix === 'item'`), new and existing.
- **First message = old fill request.** A specific request ("iphone 13 pro 256gb under
  600, no cracks") fills the form with no questions. A vague one ("a bike") gets 1–3
  short questions per turn, limited to things that map to fields: budget, condition,
  must-haves (`keywords`), deal-breakers (`antikeywords`), variants (`search_phrases`),
  category.
- **Existing searches.** Same panel; the AI receives the current values, so "make this
  stricter" or "add 2019 models" edits them.
- **Applied automatically.** Each reply may change fields; they are applied on arrival
  and marked with the existing `ai-filled` style until edited. Marks accumulate across
  turns. The status line in the chat says which fields changed.
- **Which fields change.** The AI receives the current form values each turn (including
  hand edits) and returns only the fields the latest message requires, with full new
  values. All returned fields are applied — the chat is the user's own instruction, so
  "max 500" after a hand edit still works. The prompt forbids changing fields the
  conversation did not ask about. *(Changed from "hand edits are never touched" in the
  proposal: a hard lock would make the chat refuse explicit requests.)*
- **Fields.** Same eight as the fill spec: `search_phrases`, `description`, `keywords`,
  `antikeywords`, `category`, `condition`, `min_price`, `max_price`. Location, notify,
  schedule, AI and rating fields are never touched. Prices only when the buyer states or
  agrees to them.
- **Not saved.** Conversations live in memory for the form session, like match chat.
  Leaving the form drops them. Stop and Clear behave as in match chat.
- **Web search tickbox.** Shown only when the search's AI backend supports it (see
  below), off by default, with the hint "Billed by your AI provider." When on, the AI
  decides whether to search; the prompt says to search only when the item, its variants
  or typical sellers' wording are unclear.

## Web search per backend

The backend's own search only; no new API keys. `AIBackend.supports_web_search()`
(default `False`) drives the tickbox; `chat(..., web_search=False)` adds the tool.

| Backend | Support | Request |
| --- | --- | --- |
| Anthropic | yes | `tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 2}]`. Basic variant: accepted by every Claude model, including the older default. On `stop_reason == "pause_turn"`, append the assistant content and continue, at most 2 times. Only text deltas are streamed. |
| OpenAI-compatible, host `api.xiaomimimo.com` (MiMo) | yes | `tools=[{"type": "web_search", "force_search": false, "max_keyword": 2, "limit": 3}]`. Requires a pay-as-you-go key and the Web Search plugin enabled in the MiMo console. |
| OpenAI, model name contains `search` | yes | `web_search_options={}`. These models always search. |
| Other OpenAI models, Gemini, DeepSeek, Ollama, Cloudflare | no | Tickbox hidden. Regular OpenAI models need the Responses API — later iteration. |

Provider errors (plugin disabled, unsupported model) are logged; the chat shows the
usual "failed to answer. See the log." message.

## Architecture

1. **`ai.py`**
   - `SEARCH_CHAT_PROMPT` replaces `SEARCH_SUGGESTION_PROMPT`: field rules from the fill
     prompt, question rules above, and the reply format — short plain text, then
     optionally `<search>{json}</search>` with only the changed keys. Current form values
     and buyer messages are data, not instructions.
   - `parse_search_suggestion` keeps validating the JSON inside the block.
   - `supports_web_search()` and the `web_search` parameter on `AIBackend.chat`,
     `OpenAIBackend.chat`, `AnthropicBackend.chat`.
2. **`webui/server.py`**
   - `GET /api/items/suggest?item=<name>` → `{"backend": name, "web_search": bool}`.
     `parse_search_suggestion` now accepts replies without search phrases, since a
     turn may change only one field.
     Empty `item` = new search (existing `chat_backend("")` fallback).
   - `POST /api/items/suggest` body `{"item", "messages", "fields", "web_search"}`;
     `messages` checked with `valid_chat_messages`; `fields` limited to the eight keys and
     a size cap; `web_search: true` on an unsupported backend is a 400. Streams NDJSON
     like match chat: `{"text"}` chunks, then after the reply one `{"fields": {...}}`
     event when a `<search>` block parses, or `{"warning": "..."}` when it does not.
     Session + CSRF as now.
3. **Console**
   - New `webui/static/search-chat.js` (pattern of `chat.js`, reuses `chatEvents`):
     panel HTML, send/stop/clear, hides `<search>…` (also while partially streamed),
     calls back with fields on the `fields` event.
   - `app.js`: remove `fillHtml`/`fillWithAi`; item forms render a two-column layout with
     the chat outside `#section-form` so form re-renders keep the conversation;
     `applySearchSuggestion` applies all returned keys and unions `aiFilled`.
   - `app.css`: layout and panel styles, reusing match-chat classes where possible.

## Tests

- Python: endpoint validation (body shape, fields, unsupported `web_search`); stream
  with a mocked backend → text chunks then `fields`; bad block → `warning`; GET
  capabilities; request options per backend with mocked clients (Anthropic tool +
  `pause_turn` continuation, MiMo tool, OpenAI search model, others unchanged).
- Node: `<search>` hiding incl. partial blocks; applying suggestions (overwrite,
  `aiFilled` union, ignored keys).
- Lint, type-check, full test suite.

## Docs

`docs/webui-guide.md` (chat replaces Fill with AI, web search notes incl. MiMo plugin),
`docs/agents/architecture.md` AI row, fill spec marked superseded.

## Out of scope

OpenAI Responses API search for regular models, Gemini native grounding, third-party
search APIs, saving conversations, per-turn undo, Facebook-results-based suggestions.
