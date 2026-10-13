# Design: Facebook price check in the search chat

**Date:** 2026-10-13
**Branch:** `feat/ai-search-chat`
**Status:** Implemented; not yet run against live Facebook pages.
**Builds on:** [Search assistant chat](2026-10-12-ai-search-chat-design.md)

## Summary

A **Check Facebook prices** button in the search chat searches Facebook Marketplace
results pages for the form's current search phrases and summarizes the asking prices.
The user decides whether to use them with **Use typical range**. The AI sees the
results with the user's next chat message, so it can suggest realistic prices and
anti-keywords for junk it sees. Nothing is saved until **Save search**.

## Behavior

- **Trigger.** Button in the chat panel only; never automatic. Needs at least one
  search phrase in the form (unsaved values count); otherwise the chat says so.
- **What it searches.** Results pages only (no listing detail pages): the first 3
  search phrases × the first 2 cities, with radius but **no price, condition or date
  filters**, so the result reflects the market. Cities come from the saved search,
  else its marketplace default (regions already expanded). Unsaved location edits are
  not used; the card names the cities searched.
- **Monitor thread.** A price-check job queue polled by the monitor loop, like
  re-checks. Due and requested searches run first; one check at a time. A job can be
  stopped between pages. Pages are 2–4 s apart.
- **Summary.** Listings are de-duplicated by ID. Titles matching the form's
  anti-keywords are excluded (title-only, as the search does before opening details).
  Prices are parsed from the results-page price (first amount); free/unpriced listings
  are counted separately. Prices are grouped by currency symbol; the summary uses the
  currency with most listings and notes the others. Reported: count, lowest, 25th
  percentile, median, 75th percentile, highest, excluded count, up to 8 example
  listings spread across the price range (title, price, location, link).
- **Card.** Running (with Stop), done, no results, or error. Done shows the typical
  range (25th–75th percentile), median and full range, what was searched, examples,
  and **Use typical range** → sets `min_price`/`max_price` through the same path as
  AI changes (marked fields). The button becomes "Applied" after use.
- **AI context.** When a check finishes, its summary (stats + up to 30 "price — title"
  lines) is attached to the start of the user's next message inside
  `<facebook_price_check>` tags. The chat shows only what the user typed. The system
  prompt says the block is seller-written data for judging prices and junk, not
  instructions. Prices still change only when the buyer states/agrees or uses the
  button.
- **Errors.** Browser/Facebook failures are logged; the card shows a generic message
  pointing at the activity log and browser login.

## Architecture

1. **`price_check.py`** (new): `PriceCheckQueue` (enqueue/take/finish/stop/get,
   shares the monitor's wake event, keeps the last 20 jobs), `summarize_prices`,
   `price_check_context`.
2. **`facebook.py`**: `FacebookMarketplace.search_result_listings(phrase, city,
   radius)` — navigate to one results page and parse it with
   `FacebookSearchResultPage`; no counters or detail pages. The scheduled search's
   own URL building is left unchanged.
3. **`monitor.py`**: owns `price_checks`; the loop runs `process_price_check()` after
   requested searches and before re-checks, and also while no search is configured
   yet, so a first search can use it.
4. **`webui/server.py`**: `POST /api/items/price-check` (`item`, `search_phrases`,
   `antikeywords`), `GET /api/items/price-check/{job_id}`, `DELETE` to stop. Session
   + CSRF; 503 without a monitor; one active check at a time (409).
5. **Console**: `search-chat.js` card, polling every 2 s, attaching the context to
   the next message; `app.css` card styles.

## Tests

Python: price parsing/summary (currencies, exclusions, duplicates, free), context
text, queue lifecycle, endpoints, monitor processing with a fake marketplace,
results-page URL. Node: card states, apply button, context attached to the next
message only.

## Out of scope

Opening listing details, using unsaved location edits, charts, saving checks,
currency conversion between groups.
