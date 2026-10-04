---
orphan: true
---

# Matches library

Open **Matches** in the top bar to browse listings that passed a saved search, including
listings with no notification recipient or a failed delivery. Existing notified
listings are included when their cache records are available. Missing details or
AI ratings appear as missing; they are not reconstructed from guesses.

Use **View matches** on a saved search to jump directly to its results.
Filter by search, rating, status, price drops or text, and group by search or date found.
**Price dropped** shows known current prices below the previous re-check price
(or the price when first found if there is no previous re-check price).
Filters stay in the URL, for example `#/monitor/matches?item=office_chair`.
This browser remembers your filters, sorting and grouping when you return to
Matches. A URL with explicit filters takes precedence. **Clear filters** resets
the search, rating, status, price-drop and text filters while keeping sorting and grouping.

Use **Previous** and **Next**, or the left/right arrow keys in the match list or
details, to review loaded matches in group order. Navigation reveals hidden rows
and stops at the first or last loaded match; use **Load more matches** for the
next page. Arrow keys keep their normal behavior in editable fields.

**Export CSV** exports every match that meets the active filters, in the selected
sort order, including results beyond the loaded page and matches without a
notification. It uses the latest known price and keeps each search's rating in
its own row. The export in **All activity** still contains notified listings.

Use **Copy link** beside **Open on Facebook** to share a listing. If browser
clipboard access is unavailable, the link is shown for manual copying.

Shortlist, contacted and dismissed states are shared across searches and devices.
Dismiss hides a listing; use **Dismissed → Restore** to bring it back. **Move to…**
adds personal filing labels without changing the listing's rating. These labels
count in search groups and carry a “filed by you” marker. Original matches remain
under their searches.

## Seller credibility

Each match shows a separate **Seller: Established / Caution / Unknown** label.
Open the match for the supporting reasons, the time evidence was collected, and
a link to the seller's Marketplace profile when it is available.

This assessment runs automatically, without an AI request. It uses explicit
account join year and seller rating/review count from the listing's seller panel:

- **Established:** joined at least two calendar years ago, with a rating of at
  least 4/5 from at least five reviews.
- **Caution:** joined this calendar year, or a rating below 3/5 from at least five
  reviews. The reasons explain which signal applies; this does not mean “fake.”
- **Unknown:** missing, ambiguous, insufficient, or outdated evidence. A private
  profile, missing reviews, nickname, or meme avatar is not evidence of fraud.

Evidence is shared by profile URL, never by seller name. It expires for assessment
after 30 days. Existing cached listings are refreshed when encountered by a search;
use **Re-check now** to collect or refresh evidence for an older match. An old match
that is never encountered or re-checked remains Unknown. Unrecognized layouts or
rating languages also remain Unknown; rating parsing currently supports explicit
English labels. This version reads the seller panel only, without visiting profile
timelines, downloading avatars, or collecting friends or posts.

The label does not verify identity or guarantee a safe transaction. It does not
change listing scores, filters, notifications, or personal states.

## Re-checks

**Re-check now** opens a listing again and applies its search's current filters
and AI threshold. **Check against another search** adds a match under that search
only if it passes. Ratings remain associated with the search that produced them.
Re-checks never send notifications or write notification history.

Jobs contain at most 25 listings, run on the monitor thread between searches, and
wait 5–15 seconds between listing checks. A due scheduled search runs first. Stop
finishes the current listing before stopping the job. Browser reloads recover
pending job progress; restarting the monitor process discards pending jobs.
Match records and saved personal states survive process restarts.

Failed re-checks leave the original match in the library. The current Facebook
parser cannot reliably distinguish a removed listing from a parsing/login error,
so these cases show “couldn’t re-check” rather than claiming the listing is sold.
Ambiguous prices or currency units also produce an error instead of a false pass.
An error stops the rest of that job so a login challenge does not trigger more
page loads.

## Returning listings and history

Matches recognizes returning listings by marketplace and exact listing ID. **Last seen**
and **Search sightings** count each saved-search execution once, even when phrases or
locations overlap. A known ID is recorded when it appears in fetched search results,
including when local filters reject it or notification deduplication skips it. A sighting
is not a new pass or a fresh AI evaluation. Listings absent from results are not assumed
sold or removed. Reposts with different IDs remain separate listings.

The detail panel's **History** shows collected price/title/description changes and
search-specific evaluations and re-checks. Unchanged sightings update statistics without
adding duplicate snapshots. Descriptions may come from the detail cache; returning
listings do not force new page loads or AI calls. **Last seen** sorting brings recently
observed listings to the top; **New** continues to mean a newly found match.

Deleted searches retain their historical matches and appear as removed searches in the
filter. To re-check one, choose an available search. Personal states survive new sightings.

## Related listings from photos

**Find related listings** on a saved listing compares its saved primary photo with
up to eight candidate saved listings across searches. **Recheck** downloads current
saved photo URLs and requests fresh analysis. Both buttons work when automatic
checks are off. The monitor processes image work between searches, one model call
per step; due searches and listing re-checks take priority.

In **Settings → Image matching and more**, choose a vision AI section, set a daily
USD budget, and optionally enable **Automatic image matching**. Automatic checking
starts with existing saved matches and picks up newly saved listings and changed
photo URLs. It is off by default. The default budget is zero, so configure a
positive limit before either automatic or manual analysis can run. Turning off
automation stops its queued work at the next safe point and preserves findings.

For Xiaomi MiMo V2.6 Pro, configure an OpenAI-compatible AI section:

```toml
[ai.mimo]
provider = "openai"
model = "mimo-v2.6-pro"
base_url = "https://api.xiaomimimo.com/v1"
api_key = "${MIMO_API_KEY}"

[monitor]
image_matching_ai = "mimo"
image_matching = false
image_matching_daily_budget = 1.0 # Example; choose your own limit
```

Set the API key in the monitor's environment or the existing masked AI-provider
editor. Image comparisons do not change ordinary rating or notification state.
Searches keep their existing AI selection; choose their `ai` lists explicitly if
text ratings should use a different provider. Image matching sends resized saved
photos to the selected vision
provider; it does not visit seller profiles or look up vehicle owners.

Connections distinguish **reused photo**, **possibly the same item**, and
**matching plate**. The detail panel shows the two photos, evidence, and
Confirm/Dismiss controls. Those controls review the connection in both directions;
they do not merge, dismiss, re-rate, or suppress notifications for either listing.
Unreadable plates and conflicting independent plate readings cannot create a
plate-match flag. Model suggestions do not prove fraud, ownership or identity.

### Cost, caching and limits

- Automatic and manual checks share a persistent budget that resets at midnight
  UTC. Usage is estimated from provider token counts and configured rates. Defaults
  are $0.435 input and $0.87 output per million tokens, matching MiMo V2.6 Pro's
  published overseas pricing on October 4, 2026. Update the advanced rates when
  pricing or provider changes; this is not a provider billing cap.
- Each request reserves estimated maximum cost before sending. Successful usage
  replaces that reservation; failed requests or responses without usage keep it
  counted because billing may have occurred. SDK retries are disabled. Budget-limited
  automatic jobs become eligible again the next UTC day or when the limit increases.
- Photo observations and comparisons are cached by image content, endpoint, model,
  and prompt version. Normal checks reuse these results. Fresh rechecks consume
  budget again. Failed analysis is visible and requires a manual retry, apart from
  the budget-resume behavior above.
- If the provider rejects the image request (including unsupported image or JSON
  inputs), a manual check returns an error in the listing's results. An automatic
  check records a visible skip and monitoring continues. Check the model name,
  base URL and image/JSON support in Settings, then retry manually. Authentication,
  rate-limit and server failures remain provider errors, not capability diagnoses.
- Downloads accept Facebook image CDNs only, follow at most three redirects,
  and are limited to 5 MiB and 20 million pixels. Resized JPEGs omit original metadata;
  downloaded image data is cached for 24 hours. Photo links may expire. Re-check
  the listing itself to obtain a fresh photo URL.
- Candidate selection uses cached visual fingerprints, extracted plate readings,
  categories, titles and recency. Eight candidates per check is deliberately bounded,
  not an exhaustive duplicate search. Only the primary photo is available: a plate
  hidden in another gallery photo will not be detected. Plate normalization supports
  Latin letters and digits without guessing ambiguous characters.
- Findings and reviews survive restart; pending jobs do not. Clearing all cache
  also clears findings, observations, reviews and the local budget ledger.

Provider contracts: [image inputs](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding),
[JSON output](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/structured-output),
and [pricing](https://mimo.mi.com/docs/en-US/price/pay-as-you-go).

## Storage and limitations

The library lives in `~/.ai-marketplace-monitor/matches.sqlite3`, independently of the
search/AI cache. **`--clear-cache all` preserves the library**, listing snapshots, history,
and personal states. It still clears the existing notification deduplication cache, so
later searches may send notifications again under the existing notification rules.
Photo URLs can expire; image files are not archived in the library. Image matching
downloads photos into a temporary cache for up to 24 hours when a check needs them.

On first use, existing cached matches and notified listings are imported transactionally.
Import is safe to retry and runs before CLI cache clearing. The original cache records
are left intact, but subsequent Matches reads and writes use SQLite. Imported records
keep available dates and ratings; missing data remains missing. Earlier sighting counts
are unknown, and the UI shows when repeat tracking began. A failed import or database
write reports an error instead of silently falling back to disposable storage.

Back up the library with the monitor stopped by copying `matches.sqlite3`. If making a
backup while the monitor runs, use SQLite's backup API rather than copying an open
WAL database. Storage grows with matches and meaningful history; there is no automatic
retention cleanup or permanent-delete action in this version.

“New” is measured against the last time this browser opened Matches and stored
locally when browser storage is available. It is not shared between devices.
Legacy notification records do not identify the originating search; those use the
available cached listing name, or show an unknown search if details are missing.
Historical AI joins for these legacy records retain the CSV export's hash-based
behavior. New matches store their rating per search explicitly.
