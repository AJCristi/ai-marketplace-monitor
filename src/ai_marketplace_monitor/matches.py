"""Persistent matches and personal state, independent of notification delivery."""

from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Any

from diskcache import Cache  # type: ignore

from .ai import AIResponse
from .listing import Listing
from .utils import CacheType


def rating_fields(rating: AIResponse) -> dict[str, Any]:
    if rating.comment == AIResponse.NOT_EVALUATED:
        return {"score": None, "conclusion": None, "comment": None, "ai_name": None}
    return {
        "score": rating.score,
        "conclusion": rating.conclusion,
        "comment": rating.comment,
        "ai_name": rating.name,
    }


def record_match(
    local_cache: Cache, listing: Listing, item: str, rating: AIResponse, source: str = "matched"
) -> bool:
    """Keep the first observation and price; return whether this is a new match."""
    key = (CacheType.MATCHED.value, listing.marketplace, listing.id, item)
    with local_cache.transact():
        previous = local_cache.get(key)
        if isinstance(previous, dict):
            return False
        local_cache.set(
            key,
            dict(
                found_at=datetime.now().isoformat(timespec="seconds"),
                listing_hash=listing.hash,
                price=listing.price,
                source=source,
                **rating_fields(rating),
            ),
            tag=CacheType.MATCHED.value,
        )
        listing.to_cache(listing.post_url, local_cache)
    return True


def match_state(local_cache: Cache, marketplace: str, listing_id: str) -> dict[str, Any]:
    saved = local_cache.get((CacheType.MATCH_STATE.value, marketplace, listing_id))
    return {"shortlisted": False, "contacted": False, "dismissed": False, "filed_under": []} | (
        saved if isinstance(saved, dict) else {}
    )


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
    with local_cache.transact():
        state = match_state(local_cache, marketplace, listing_id) | patch
        state["updated_at"] = datetime.now().isoformat(timespec="seconds")
        local_cache.set(
            (CacheType.MATCH_STATE.value, marketplace, listing_id),
            state,
            tag=CacheType.MATCH_STATE.value,
        )
    return state


def load_matches(local_cache: Cache) -> list[dict[str, Any]]:
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
        state = match_state(local_cache, market, listing_id)
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
            found_at=min(dates) if dates else "",
            source=saved.get("source", "matched"),
            notified_users=sorted(delivery.get("users", [])),
            state=state,
            **{name: saved.get(name) for name in ("score", "conclusion", "comment", "ai_name")},
        )
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
    match = re.fullmatch(r"[^\d]*([\d,]+(?:\.\d+)?)[^\d]*", str(value or ""))
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
    rows.sort(key=lambda row: (row["found_at"], row["key"], row["item"]), reverse=True)
    if sort == "price":
        rows.sort(key=lambda row: price_number(row["current_price"] or row["price"]))
    elif sort == "score":
        rows.sort(key=lambda row: row["score"] or 0, reverse=True)
    return {
        "matches": rows[cursor : cursor + limit if limit is not None else None],
        "total": len(rows),
        "library_total": counts["all"],
        "new_count": new_count,
        "counts": counts,
        "groups": [
            {"item": name, "count": count, "new_since": new_groups.get(name, 0)}
            for name, count in sorted(groups.items())
        ],
        "next_cursor": (
            str(cursor + limit) if limit is not None and cursor + limit < len(rows) else None
        ),
    }
