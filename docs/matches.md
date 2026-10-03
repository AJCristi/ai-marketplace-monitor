---
orphan: true
---

# Matches library

Open **Monitor → Matches** to browse listings that passed a saved search, including
listings with no notification recipient or a failed delivery. Existing notified
listings are included when their cache records are available. Missing details or
AI ratings appear as missing; they are not reconstructed from guesses.

Filter by search, rating, status or text, and group by search or date found.
Filters stay in the URL, for example `#/monitor/matches?item=office_chair`.
The CSV button continues to export **notified listings**, independently of these
filters. It does not export the entire Matches library.

Shortlist, contacted and dismissed states are shared across searches and devices.
Dismiss hides a listing; use **Dismissed → Restore** to bring it back. **Move to…**
adds personal filing labels without changing the listing's rating. These labels
count in search groups and carry a “filed by you” marker. Original matches remain
under their searches.

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
