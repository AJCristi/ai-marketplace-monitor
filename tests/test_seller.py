"""Seller evidence uses saved pages and temporary caches, without a browser."""

from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest
from diskcache import Cache  # type: ignore

from ai_marketplace_monitor.ai import AIResponse
from ai_marketplace_monitor.facebook import FacebookMarketplace, FacebookRegularItemPage
from ai_marketplace_monitor.listing import Listing
from ai_marketplace_monitor.matches import load_matches, record_match
from ai_marketplace_monitor.seller import assess_seller, parse_seller_evidence, profile_url
from ai_marketplace_monitor.utils import CacheType, hash_dict

URL = "https://www.facebook.com/marketplace/profile/123/"


def panel(facts: str, url: str = URL) -> str:
    return f'<h2><span>Seller information</span></h2><a href="{url}">Seller details</a>{facts}'


@pytest.mark.parametrize(
    ("filename", "year"),
    [("regular_listing.html", 2024), ("auto_with_description_listing.html", 2013)],
)
def test_saved_listing_seller_panels(filename: str, year: int) -> None:
    html = (Path(__file__).parent / filename).read_text(encoding="utf-8")
    evidence = parse_seller_evidence(html)
    assert evidence["joined_year"] == year
    assert evidence["profile_url"].startswith("https://www.facebook.com/marketplace/profile/")
    assert "?" not in evidence["profile_url"]
    assert "rating" not in evidence  # Page scripts mention ratings, but the panel does not.
    assert assess_seller(evidence)["status"] == "unknown"


def test_parser_scopes_facts_and_requires_unambiguous_identity() -> None:
    html = (
        "<p>Joined Facebook in 2005. 5 out of 5. 100 reviews</p>"
        + panel(
            '<span>Joined Facebook in <!-- -->2015</span><span aria-label="4.8 out of 5 stars"></span><span>12 reviews</span>'
        )
        + "<script>Joined Facebook in 2026</script><div hidden>1 out of 5. 99 reviews</div>"
        + "<h2>Other listings</h2><p>Joined Facebook in 2020. 1 out of 5. 6 reviews</p>"
    )
    evidence = parse_seller_evidence(html)
    assert {key: evidence[key] for key in ("joined_year", "rating", "review_count")} == {
        "joined_year": 2015,
        "rating": 4.8,
        "review_count": 12,
    }
    ambiguous = parse_seller_evidence(
        panel('Joined Facebook in 2015<a href="/marketplace/profile/456/">Other</a>')
    )
    assert set(ambiguous) == {"checked_at"}
    assert set(parse_seller_evidence("<div>Seller information</div>Joined Facebook in 2005")) == {
        "checked_at"
    }
    compact = parse_seller_evidence(panel("4.2 (1,200 ratings)"))
    assert compact["rating"] == 4.2 and compact["review_count"] == 1200
    assert "rating" not in parse_seller_evidence(panel("4.2 out of 5, no review count"))
    assert "rating" not in parse_seller_evidence(panel("4.2 (12 ratings) 2.1 (12 ratings)"))
    assert "rating" not in parse_seller_evidence(panel("4.2 out of 5, 1.200 reviews"))
    assert "rating" not in parse_seller_evidence(
        panel('Joined Facebook in 2015<span style="display: none">4.8 out of 5. 12 reviews</span>')
    )
    assert "joined_year" not in parse_seller_evidence(panel("Joined Facebook in 2999"))


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "https://evil.test/marketplace/profile/123/",
        "https://www.facebook.com.evil.test/marketplace/profile/123/",
        "//evil.test/profile.php?id=123",
        "https://www.facebook.com/marketplace/item/123/",
    ],
)
def test_profile_links_reject_unsafe_or_unrelated_destinations(url: str) -> None:
    assert profile_url(url) == ""
    assert "profile_url" not in parse_seller_evidence(panel("Joined Facebook in 2015", url))


def test_profile_identity_normalizes_tracking_and_mobile_links() -> None:
    assert profile_url("/marketplace/profile/123/?product_id=456") == URL
    assert profile_url("https://m.facebook.com/profile.php?id=123&ref=marketplace") == URL


@pytest.mark.parametrize(
    ("year", "rating", "count", "expected"),
    [
        (2015, 4, 5, "established"),
        (2026, 5, 20, "caution"),
        (2015, 2.9, 5, "caution"),
        (2015, 5, 4, "unknown"),
        (2015, 3.9, 20, "unknown"),
        (2025, 5, 20, "unknown"),
        (None, None, None, "unknown"),
        (2015, float("nan"), 20, "unknown"),
    ],
)
def test_assessment_requires_corroboration(
    year: int | None, rating: float | None, count: int | None, expected: str
) -> None:
    now = datetime(2026, 10, 4, tzinfo=timezone.utc)
    evidence = {
        "profile_url": URL,
        "checked_at": now.isoformat(),
        "joined_year": year,
        "rating": rating,
        "review_count": count,
    }
    result = assess_seller(evidence, now)
    assert result["status"] == expected
    assert result["reasons"]
    for checked_at in (
        (now - timedelta(days=31)).isoformat(),
        (now + timedelta(days=1)).isoformat(),
        "bad",
        "2026-10-04",
    ):
        assert assess_seller(evidence | {"checked_at": checked_at}, now)["status"] == "unknown"


def test_cache_shares_latest_seller_but_preserves_listing_hash_and_old_records(
    tmp_path: Path, listing: Listing
) -> None:
    now = datetime.now(timezone.utc)
    original_hash = listing.hash
    old_payload = asdict(listing)
    del old_payload["seller_profile"]
    del old_payload["image_urls"]
    assert original_hash == hash_dict(
        {
            key: (value.split("?")[0] if key == "post_url" else value)
            for key, value in old_payload.items()
            if key != "image"
        }
    )
    with Cache(str(tmp_path / "cache")) as cache:
        cache.set((CacheType.LISTING_DETAILS.value, listing.post_url), old_payload)
        restored = Listing.from_cache(listing.post_url, cache)
        assert restored is not None and restored.seller_profile is None
        listing.seller_profile = {
            "profile_url": URL,
            "checked_at": (now - timedelta(days=2)).isoformat(),
            "joined_year": 2010,
            "rating": 4.8,
            "review_count": 20,
        }
        assert listing.hash == original_hash
        record_match(cache, listing, "test", AIResponse(4, "good"))
        second = replace(
            listing,
            id="222",
            post_url=listing.post_url + "2",
            seller_profile={
                "profile_url": URL,
                "checked_at": now.isoformat(),
                "joined_year": 2010,
                "rating": 2,
                "review_count": 20,
            },
        )
        record_match(cache, second, "test", AIResponse(5, "great deal"))
        listing.to_cache(
            listing.post_url, cache
        )  # An older snapshot cannot overwrite newer evidence.
        restored = Listing.from_cache(listing.post_url, cache)
        assert restored is not None and restored.seller_profile == second.seller_profile
        matches = load_matches(cache)
        assert all(row["seller_assessment"]["status"] == "caution" for row in matches)
        assert {row["score"] for row in matches} == {4, 5}
        # Same display name, different identity: never inherit another seller's assessment.
        third = replace(
            second,
            id="333",
            post_url=listing.post_url + "3",
            seller_profile={
                "checked_at": now.isoformat(),
                "profile_url": URL.replace("123", "456"),
            },
        )
        record_match(cache, third, "test", AIResponse(4, "good"))
        assert (
            next(row for row in load_matches(cache) if row["listing_id"] == "333")[
                "seller_assessment"
            ]["status"]
            == "unknown"
        )


def test_optional_scrape_failure_does_not_fail_listing() -> None:
    page = Mock()
    page.content.side_effect = RuntimeError("page unavailable")
    evidence = FacebookRegularItemPage(page).get_seller_profile()
    assert assess_seller(evidence)["status"] == "unknown"


def test_legacy_and_stale_listings_refresh_automatically(
    listing: Listing, monkeypatch: pytest.MonkeyPatch
) -> None:
    market: Any = object.__new__(FacebookMarketplace)
    market.page, market.translator, market.goto_url = Mock(), Mock(), Mock()
    market.logger = None
    monkeypatch.setattr(Listing, "from_cache", Mock(return_value=listing))
    monkeypatch.setattr(Listing, "to_cache", Mock())
    monkeypatch.setattr(
        "ai_marketplace_monitor.facebook.parse_listing", Mock(return_value=listing)
    )
    monkeypatch.setattr("ai_marketplace_monitor.facebook.counter", Mock())
    for evidence in (None, {"checked_at": "2000-01-01T00:00:00+00:00"}):
        listing.seller_profile = evidence
        assert market.get_listing_details(listing.post_url, Mock())[1] is False
    assert market.goto_url.call_count == 2
    market.goto_url.side_effect = RuntimeError("Facebook unavailable")
    assert market.get_listing_details(listing.post_url, Mock()) == (listing, True)
    assert assess_seller(listing.seller_profile)["status"] == "unknown"
    # Actual listing refreshes must still surface errors instead of using stale prices.
    with pytest.raises(RuntimeError, match="Facebook unavailable"):
        market.get_listing_details(listing.post_url, Mock(), price="$999")
    with pytest.raises(RuntimeError, match="Facebook unavailable"):
        market.get_listing_details(listing.post_url, Mock(), force_refresh=True)
