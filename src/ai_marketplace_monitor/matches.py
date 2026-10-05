"""Persistent matches and personal state, independent of notification delivery."""

from __future__ import annotations

import json
import math
import re
from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4

from diskcache import Cache  # type: ignore

from .ai import AIResponse
from .listing import Listing
from .match_store import MatchStore, now
from .seller import assess_seller, profile_url
from .utils import CacheType


def default_state() -> dict[str, Any]:
    return {"shortlisted": False, "contacted": False, "dismissed": False, "filed_under": []}


@contextmanager
def library(local_cache: Cache) -> Iterator[MatchStore]:
    """Use the cache directory only as a location and a one-time migration source."""
    with MatchStore(Path(local_cache.directory) / "matches.sqlite3") as store:
        if not store.db.execute("SELECT 1 FROM metadata WHERE key='imported'").fetchone():
            for row in load_legacy_matches(local_cache):
                market, listing_id, item = row["marketplace"], row["listing_id"], row["item"]
                if store.listing(market, listing_id) is None:
                    store.save_listing(
                        market,
                        listing_id,
                        {
                            **row,
                            "price": row.get("snapshot_price")
                            or row["current_price"]
                            or row["price"],
                            "tracking_since": now(),
                            "imported": True,
                        },
                    )
                    store.event(
                        market,
                        listing_id,
                        "imported",
                        None,
                        {
                            "found_at": row["found_at"],
                            "historical_sightings": "unknown",
                        },
                    )
                if store.match(market, listing_id, item) is None:
                    store.save_match(market, listing_id, item, row)
            store.db.execute("INSERT INTO metadata VALUES ('imported', ?)", (now(),))
        yield store


def initialize_library(local_cache: Cache) -> None:
    with library(local_cache):
        pass


def has_match(local_cache: Cache, market: str, listing_id: str, item: str) -> bool:
    with library(local_cache) as store:
        return store.match(market, listing_id, item) is not None


def record_sighting(local_cache: Cache, listing: Listing, item: str, run: str) -> bool:
    """Known IDs only; search summaries prove a sighting, not a fresh detail fetch or pass."""
    with library(local_cache) as store:
        if store.listing(listing.marketplace, listing.id) is None:
            return False
        observed = store.observe(listing.marketplace, listing.id, item, run)
        store.snapshot(
            listing.marketplace,
            listing.id,
            {
                "title": listing.title,
                "price": listing.price,
                "location": listing.location,
                "image": listing.image,
                "url": listing.post_url,
                "description": listing.description,
                "seller": listing.seller,
                "condition": listing.condition,
                "seller_profile": listing.seller_profile,
            },
            "search result; details may be cached",
        )
        return observed


def record_match(
    local_cache: Cache,
    listing: Listing,
    item: str,
    rating: AIResponse,
    source: str = "matched",
    run: str | None = None,
) -> bool:
    with library(local_cache) as store:
        market, listing_id = listing.marketplace, listing.id
        fields = asdict(listing) | {"url": listing.post_url}
        if store.listing(market, listing_id) is None:
            store.save_listing(
                market,
                listing_id,
                fields
                | {
                    "state": default_state(),
                    "notified_users": [],
                    "tracking_since": now(),
                    "imported": False,
                },
            )
        else:
            store.snapshot(market, listing_id, fields, "collected details (may be cached)")
        previous = store.match(market, listing_id, item)
        ratings = rating_fields(rating)
        saved = previous or {
            "found_at": now(),
            "price": listing.price,
            "source": source,
            "recheck": None,
        }
        if (
            previous is None
            or saved.get("evaluation_status") != "passed"
            or any(saved.get(key) != value for key, value in ratings.items())
        ):
            store.event(
                market,
                listing_id,
                "matched" if previous is None else "rating",
                item,
                ratings | {"status": "passed"},
            )
        store.save_match(
            market, listing_id, item, saved | ratings | {"evaluation_status": "passed"}
        )
        if source != "recheck":
            store.observe(market, listing_id, item, run or uuid4().hex)
    # The normal detail cache still supports search acceleration and activity CSV.
    listing.to_cache(listing.post_url, local_cache)
    return previous is None


def record_delivery(local_cache: Cache, listing: Listing, user: str) -> None:
    with library(local_cache) as store:
        saved = store.listing(listing.marketplace, listing.id)
        if saved is not None and user not in saved["notified_users"]:
            saved["notified_users"].append(user)
            store.save_listing(listing.marketplace, listing.id, saved)


def record_failed_rating(
    local_cache: Cache, listing: Listing, item: str, rating: AIResponse
) -> None:
    """Retain an actual evaluation of a known listing without adding a match."""
    with library(local_cache) as store:
        if store.listing(listing.marketplace, listing.id) is None:
            return
        store.snapshot(
            listing.marketplace, listing.id, asdict(listing), "collected details (may be cached)"
        )
        saved = store.match(listing.marketplace, listing.id, item)
        ratings = rating_fields(rating)
        previous = saved
        if previous is None:
            last = store.db.execute(
                "SELECT data FROM history WHERE marketplace=? AND listing_id=? AND item=? "
                "AND kind='rating' ORDER BY id DESC LIMIT 1",
                (listing.marketplace, listing.id, item),
            ).fetchone()
            previous = json.loads(last[0]) if last else {}
        if previous.get("evaluation_status", previous.get("status")) != "below_threshold" or any(
            previous.get(key) != value for key, value in ratings.items()
        ):
            store.event(
                listing.marketplace,
                listing.id,
                "rating",
                item,
                ratings | {"status": "below_threshold"},
            )
        if saved is not None:
            store.save_match(
                listing.marketplace,
                listing.id,
                item,
                saved | ratings | {"evaluation_status": "below_threshold"},
            )


def record_recheck(
    local_cache: Cache,
    original: dict[str, Any],
    result: dict[str, Any],
    listing: Listing | None,
    rating: AIResponse | None,
) -> None:
    with library(local_cache) as store:
        market, listing_id, item = (
            original["marketplace"],
            original["listing_id"],
            original["item"],
        )
        saved = store.match(market, listing_id, item)
        if saved is None:
            raise ValueError("Match not found")
        saved["recheck"] = {
            "at": result["at"],
            "status": result["status"],
            "checked_item": result["item"],
            **{key: result.get(key) for key in ("old_score", "old_price", "reason", "threshold")},
        }
        if result["item"] == item and result["status"] != "error":
            saved["evaluation_status"] = result["status"]
        if rating is not None and result["item"] == item:
            saved.update(rating_fields(rating))
        store.save_match(market, listing_id, item, saved)
        if listing is not None:
            store.snapshot(
                market,
                listing_id,
                asdict(listing) | {"url": listing.post_url},
                "re-check details" if result.get("fresh_details") else "cached details",
            )
        if result["item"] != item:
            target = store.match(market, listing_id, result["item"])
            if target is None and result["status"] == "passed" and listing and rating:
                target = {
                    "found_at": now(),
                    "price": listing.price,
                    "source": "recheck",
                }
            if target is not None:
                target["recheck"] = saved["recheck"]
                if result["status"] != "error":
                    target["evaluation_status"] = result["status"]
                if rating is not None:
                    target.update(rating_fields(rating))
                store.save_match(market, listing_id, result["item"], target)
        store.event(market, listing_id, "recheck", result["item"], result)


def load_matches(local_cache: Cache) -> list[dict[str, Any]]:
    with library(local_cache) as store:
        listings = {
            (r[0], r[1]): json.loads(r[2]) for r in store.db.execute("SELECT * FROM listings")
        }
        sightings = {
            (r[0], r[1]): dict(r)
            for r in store.db.execute(
                "SELECT marketplace,listing_id,MIN(first_seen) AS first_seen,MAX(last_seen) AS last_seen,"
                "SUM(count) AS seen_count FROM sightings GROUP BY marketplace,listing_id"
            )
        }
        profiles: dict[str, dict[str, Any]] = {}
        for saved in listings.values():
            # Repair the old vehicle-parser shape in the read view only; preserve history.
            if (
                len(saved.get("condition") or "") > 100
                and (saved.get("description") or "").strip()
                == "Seller's description\n\n**unspecified**"
            ):
                saved["description"] = saved["condition"]
                saved["condition"] = ""
            evidence = saved.get("seller_profile")
            if isinstance(evidence, dict):
                url = profile_url(str(evidence.get("profile_url") or ""))
                if url and str(evidence.get("checked_at", "")) > str(
                    profiles.get(url, {}).get("checked_at", "")
                ):
                    profiles[url] = evidence
        rows = []
        for record in store.db.execute("SELECT * FROM matches"):
            market, listing_id, item, payload = record
            saved = json.loads(payload)
            detail = listings[(market, listing_id)]
            state = detail["state"]
            evidence = detail.get("seller_profile")
            if isinstance(evidence, dict):
                evidence = profiles.get(
                    profile_url(str(evidence.get("profile_url") or "")), evidence
                )
            rows.append(
                {
                    **detail,
                    **saved,
                    **{
                        key: detail.get(key) or ""
                        for key in (
                            "title",
                            "image",
                            "location",
                            "seller",
                            "condition",
                            "description",
                            "url",
                        )
                    },
                    "marketplace": market,
                    "listing_id": listing_id,
                    "item": item,
                    "key": f"{market}:{listing_id}",
                    "state": state,
                    "filed_under": list(dict.fromkeys([item, *state["filed_under"]])),
                    "notified_users": sorted(detail["notified_users"]),
                    "current_price": detail.get("price"),
                    "seller_assessment": assess_seller(evidence),
                    "first_seen": None,
                    "last_seen": None,
                    "seen_count": 0,
                    **sightings.get((market, listing_id), {}),
                    "tracking_since": detail["tracking_since"],
                    "imported": detail["imported"],
                }
            )
        return rows


def rating_fields(rating: AIResponse) -> dict[str, Any]:
    if rating.comment == AIResponse.NOT_EVALUATED:
        return {"score": None, "conclusion": None, "comment": None, "ai_name": None}
    return {
        "score": rating.score,
        "conclusion": rating.conclusion,
        "comment": rating.comment,
        "ai_name": rating.name,
    }


def update_state(
    local_cache: Cache, marketplace: str, listing_id: str, patch: dict[str, Any]
) -> dict[str, Any]:
    allowed = {"shortlisted", "contacted", "dismissed", "filed_under"}
    if not patch or patch.keys() - allowed:
        raise ValueError("Supply shortlisted, contacted, dismissed or filed_under")
    for name, value in patch.items():
        if name == "filed_under":
            if (
                not isinstance(value, list)
                or len(value) > 100
                or any(
                    not isinstance(item, str) or not item.strip() or len(item) > 200
                    for item in value
                )
            ):
                raise ValueError("filed_under must contain at most 100 search names")
            patch[name] = list(dict.fromkeys(value))
        elif type(value) is not bool:
            raise ValueError(f"{name} must be a boolean")
    with library(local_cache) as store:
        saved = store.listing(marketplace, listing_id)
        if saved is None:
            raise ValueError("Match not found")
        state = saved["state"] | patch
        state["updated_at"] = now()
        store.save_listing(marketplace, listing_id, saved | {"state": state})
    return state


def load_legacy_matches(local_cache: Cache) -> list[dict[str, Any]]:
    """Retain only the matched/notified subset of details and AI cache entries."""
    from .webui.found_export import _collect_needed, _fallback_url, _load_lookups

    notified, needed, hashes = _collect_needed(local_cache)
    stored: dict[tuple[str, str, str], dict[str, Any]] = {}
    for key in local_cache.iterkeys():
        if isinstance(key, tuple) and len(key) == 4 and key[0] == CacheType.MATCHED.value:
            value = local_cache.get(key)
            if isinstance(value, dict):
                stored[key[1:]] = value
                needed.add(key[1:3])
                if value.get("listing_hash"):
                    hashes.add(value["listing_hash"])
    details, ratings = _load_lookups(local_cache, needed, hashes)
    deliveries: dict[tuple[str, str], dict[str, Any]] = {}
    for market, listing_id, user, date, listing_hash, price in notified:
        entry = deliveries.setdefault(
            (market, listing_id),
            {"users": [], "found_at": "", "price": None, "listing_hash": None},
        )
        if user not in entry["users"]:
            entry["users"].append(user)
        if date and (not entry["found_at"] or date < entry["found_at"]):
            entry.update(found_at=date, price=price)
        if listing_hash and not entry["listing_hash"]:
            entry["listing_hash"] = listing_hash
    # Legacy notification keys have no search name. Use cached details when available;
    # never assign a made-up search to a listing whose details have gone away.
    identities = {key[:2] for key in stored}
    for identity, delivery in deliveries.items():
        if identity not in identities:
            detail = details.get(identity, {})
            rating = ratings.get(delivery["listing_hash"], {})
            score = rating.get("score")
            stored[(*identity, detail.get("name") or "")] = {
                "found_at": delivery["found_at"],
                "price": delivery["price"],
                "source": "notified",
                "score": score,
                "conclusion": (
                    AIResponse(score, "").conclusion
                    if isinstance(score, int) and score in range(1, 6)
                    else None
                ),
                "comment": rating.get("comment"),
                "ai_name": rating.get("name"),
            }
    rows = []
    for (market, listing_id, item), saved in stored.items():
        detail = details.get((market, listing_id), {})
        delivery = deliveries.get((market, listing_id), {})
        dates = [
            str(date).replace(" ", "T", 1)
            for date in (saved.get("found_at"), delivery.get("found_at"))
            if date
        ]
        state = default_state() | (
            local_cache.get((CacheType.MATCH_STATE.value, market, listing_id)) or {}
        )
        row = {
            name: detail.get(name) or ""
            for name in ("title", "image", "location", "seller", "condition", "description")
        }
        row.update(
            key=f"{market}:{listing_id}",
            marketplace=market,
            listing_id=listing_id,
            item=item,
            filed_under=list(dict.fromkeys([item, *state["filed_under"]])),
            url=detail.get("post_url") or _fallback_url(market, listing_id),
            price=saved.get("price") or "",
            current_price=saved.get("current_price"),
            snapshot_price=detail.get("price"),
            found_at=min(dates) if dates else "",
            source=saved.get("source", "matched"),
            notified_users=sorted(delivery.get("users", [])),
            state=state,
            **{name: saved.get(name) for name in ("score", "conclusion", "comment", "ai_name")},
        )
        evidence = detail.get("seller_profile")
        if isinstance(evidence, dict):
            url = profile_url(str(evidence.get("profile_url") or ""))
            shared = local_cache.get((CacheType.SELLER_PROFILE.value, url)) if url else None
            if isinstance(shared, dict) and str(shared.get("checked_at", "")) > str(
                evidence.get("checked_at", "")
            ):
                evidence = shared
        row["seller_profile"] = evidence
        row["seller_assessment"] = assess_seller(evidence)
        row["recheck"] = (
            {
                "at": saved["rechecked_at"],
                "status": saved.get("last_status"),
                **{
                    name: saved.get(name)
                    for name in ("old_score", "old_price", "reason", "threshold", "checked_item")
                },
            }
            if saved.get("rechecked_at")
            else None
        )
        rows.append(row)
    return rows


def price_number(value: Any) -> float:
    """Unknown or compound prices sort last; do not guess a price for them."""
    match = re.fullmatch(
        r"\s*(?:[A-Z]{3}|[$£€₱¥])?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)"
        r"\s*(?:[A-Z]{3}|[$£€₱¥])?\s*",
        str(value or ""),
        re.IGNORECASE,
    )
    return float(match[1].replace(",", "")) if match else float("inf")


def price_dropped(row: dict[str, Any]) -> bool:
    """Compare known prices against the last re-check, or the first observation."""
    previous = price_number((row.get("recheck") or {}).get("old_price") or row.get("price"))
    current = price_number(row.get("current_price"))
    return math.isfinite(previous) and math.isfinite(current) and current < previous


def query_matches(
    local_cache: Cache,
    *,
    item: str | None = None,
    min_score: int | None = None,
    status: str = "all",
    include_dismissed: bool = False,
    price_drop: bool = False,
    q: str = "",
    sort: str = "newest",
    limit: int | None = 200,
    cursor: int = 0,
    since: datetime | None = None,
) -> dict[str, Any]:
    rows = load_matches(local_cache)
    counts = {
        name: sum(
            bool(row["state"].get(name)) and (name == "dismissed" or not row["state"]["dismissed"])
            for row in rows
        )
        for name in ("shortlisted", "contacted", "dismissed")
    }
    counts["all"] = sum(not row["state"]["dismissed"] for row in rows)
    groups: dict[str, int] = {}
    new_groups: dict[str, int] = {}
    new_count = 0
    memberships: set[tuple[str, str]] = set()
    for row in rows:
        if not row["state"]["dismissed"]:
            try:
                is_new = bool(row["found_at"]) and (
                    since is None
                    or datetime.fromisoformat(row["found_at"]).timestamp() > since.timestamp()
                )
            except ValueError:
                is_new = False
            new_count += int(is_new)
            for name in row["filed_under"]:
                membership = (row["key"], name)
                if membership not in memberships:
                    memberships.add(membership)
                    groups[name] = groups.get(name, 0) + 1
                    new_groups[name] = new_groups.get(name, 0) + int(is_new)
    rows = [
        row
        for row in rows
        if (not item or item in row["filed_under"])
        and (not price_drop or price_dropped(row))
        and (min_score is None or (row["score"] is not None and row["score"] >= min_score))
        and (status == "all" or row["state"].get(status))
        and (
            not row["state"]["dismissed"]
            or status == "dismissed"
            or (status == "all" and include_dismissed)
        )
        and (
            not q
            or q.casefold()
            in " ".join(
                str(row.get(name) or "")
                for name in ("title", "seller", "description", "location", "item")
            ).casefold()
        )
    ]
    filtered_groups: dict[str, set[str]] = {}
    for row in rows:
        for name in row["filed_under"]:
            if not item or name == item:
                filtered_groups.setdefault(name, set()).add(row["key"])
    rows.sort(key=lambda row: (row["found_at"], row["key"], row["item"]), reverse=True)
    if sort == "price":
        rows.sort(key=lambda row: price_number(row["current_price"] or row["price"]))
    elif sort == "last_seen":
        rows.sort(key=lambda row: row.get("last_seen") or "", reverse=True)
    elif sort == "score":
        rows.sort(key=lambda row: row["score"] or 0, reverse=True)
    return {
        "matches": rows[cursor : cursor + limit if limit is not None else None],
        "total": len(rows),
        "library_total": counts["all"],
        "new_count": new_count,
        "counts": counts,
        "filtered_groups": [
            {"item": name, "count": len(keys)} for name, keys in sorted(filtered_groups.items())
        ],
        "groups": [
            {"item": name, "count": count, "new_since": new_groups.get(name, 0)}
            for name, count in sorted(groups.items())
        ],
        "next_cursor": (
            str(cursor + limit) if limit is not None and cursor + limit < len(rows) else None
        ),
    }
