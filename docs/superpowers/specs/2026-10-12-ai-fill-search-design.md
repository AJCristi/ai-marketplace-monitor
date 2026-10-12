# Design: Fill a new search with AI (Web UI)

**Date:** 2026-10-12
**Branch:** `feat/ai-fill-search`
**Status:** v1 implemented

## Summary

On the **New search** form, the user types a short request such as `iphone 13 pro`
or `iphone, good battery, under 600` and clicks **Fill with AI**. The configured AI
backend turns it into suggested form values. The form is filled for review; nothing is
saved until the user clicks **Save**, so the existing config validation still applies.

v1 uses only the AI's own knowledge: no browser work and no web search.

## Goal (definition of done)

- New-search form has a request input and a **Fill with AI** button.
- `POST /api/items/suggest` returns validated suggestions from the configured AI.
- Suggestions fill **empty** fields only; fields the user already set are kept.
  Filled fields are visibly marked until edited.
- Clear errors when no AI is configured, the backend cannot chat, or the reply is
  not usable JSON.
- Python tests cover the endpoint and reply parsing with a mocked backend; Node tests
  cover filling the form. Lint, type-check and tests pass.

## Fields

| Field | Filled by AI | Notes |
| --- | --- | --- |
| `search_phrases` | yes | 2–5 phrases sellers actually use |
| `description` | yes | Improves later AI rating |
| `keywords` | yes | Plain terms only (list = OR); broad, so good listings are not filtered out |
| `antikeywords` | yes | Accessories, parts, locked, box only, wanted ads |
| `min_price`, `max_price` | only if the request states a price | AI price knowledge is stale and regional |
| `condition` | only if the request states one | Must be a `Condition` value |
| `category` | yes, when obvious | Must be a `Category` value |

Never touched: location, region, radius, notify, schedule, AI backend, rating and
prompt fields. Those are user preferences, not facts about the item.

Boolean keyword expressions are not requested; a plain list keeps the output safe
for `is_substring` without parsing.

## Architecture

1. **`ai.py`**
   - `SEARCH_SUGGESTION_PROMPT`: system prompt asking for one JSON object with only
     the keys above.
   - `parse_search_suggestion(text) -> dict`: extract the JSON object (tolerating
     code fences or surrounding text), keep allowed keys, coerce and validate types,
     drop invalid values (`Condition` / `Category` enums, non-empty strings, prices as
     positive numbers). Raises `ValueError` when nothing usable remains.
2. **`POST /api/items/suggest`** in `webui/server.py`
   - Body: `{"request": str}` (non-empty, length-capped). Session + CSRF, like chat.
   - Backend: reuse `config.chat_backend(<unsaved name>)`. With no saved item it
     falls back to the default marketplace's AI list, then the first enabled agent.
   - Collects `backend.chat(...)` output (non-streaming response), parses it, returns
     `{"fields": {...}, "backend": name}`.
   - 503 when the monitor/AI is unavailable or the backend has no chat support
     (Cloudflare); 502 when the reply cannot be parsed. Provider errors are logged;
     the response hides their details.
3. **Console (`app.js`)**
   - Request input + button at the top of the "What to look for" section, new
     searches only.
   - On success, merge into `state.form.fields` / `state.form.changes` for keys the
     user has not set, re-render the form, mark the filled fields, report the result in the status line.

## Out of scope (later iterations)

- **"Use Facebook Marketplace listings" checkbox**: queue a results-page preview on
  the monitor thread; if a search is running, wait for it, then fill once. Supplies
  real variants, junk terms and local prices.
- **"Search the web" checkbox** via the Exa REST search API (`exa_api_key` secret,
  masked and redacted), provider-independent. MiMo's built-in `web_search` tool is
  the fallback option.
- Clarifying questions for vague requests, editing existing searches, streaming.
