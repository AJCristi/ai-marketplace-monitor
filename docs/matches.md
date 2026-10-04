---
orphan: true
---

# Matches library

Open **Monitor → Matches** to browse listings that passed a saved search, including
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

## Storage and limitations

Matches use the existing diskcache, with separate `matches` and `match-state` tags.
Clearing `ai-inquiries` preserves them; **`--clear-cache all` clears the library
and its personal states**. Listing photo links can expire.

“New” is measured against the last time this browser opened Matches and stored
locally when browser storage is available. It is not shared between devices.
Legacy notification records do not identify the originating search; those use the
available cached listing name, or show an unknown search if details are missing.
Historical AI joins for these legacy records retain the CSV export's hash-based
behavior. New matches store their rating per search explicitly.
