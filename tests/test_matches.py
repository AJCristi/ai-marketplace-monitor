"""Matches persistence, delivery independence, and monitor-thread re-checks."""

import csv
import dataclasses
import io
import threading
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest
from diskcache import Cache  # type: ignore
from fastapi.testclient import TestClient

from ai_marketplace_monitor.ai import AIResponse
from ai_marketplace_monitor.facebook import FacebookMarketplace
from ai_marketplace_monitor.listing import Listing
from ai_marketplace_monitor.matches import (
    initialize_library,
    library,
    load_matches,
    price_dropped,
    query_matches,
    record_delivery,
    record_failed_rating,
    record_match,
    record_sighting,
    update_state,
)
from ai_marketplace_monitor.monitor import MarketplaceMonitor
from ai_marketplace_monitor.notification import NotificationStatus
from ai_marketplace_monitor.recheck import RecheckQueue, price_filter_reason
from ai_marketplace_monitor.utils import CacheType, SleepStatus, doze
from ai_marketplace_monitor.webui.auth import CSRF_HEADER, AuthConfig, hash_password
from ai_marketplace_monitor.webui.config_api import ConfigFileService
from ai_marketplace_monitor.webui.log_handler import LogBroadcastHandler
from ai_marketplace_monitor.webui.server import AuthState, WebUIConfig, create_app


@pytest.fixture
def match_cache(tmp_path: Path) -> Any:
    with Cache(str(tmp_path / "cache")) as cache:
        yield cache


def test_legacy_union_and_missing_details(match_cache: Cache, listing: Listing) -> None:
    listing.to_cache(listing.post_url, match_cache)
    for user, value in [
        ("a", "2026-01-01 10:00:00"),
        ("b", ("2026-01-02 10:00:00", listing.hash)),
        ("c", ("2026-01-03 10:00:00", listing.hash, "$15")),
    ]:
        match_cache.set(("user-notifications", "facebook", listing.id, user), value)
    match_cache.set(
        ("ai-inquiries", "item", "market", listing.hash),
        {"score": 4, "comment": "good", "name": "test"},
    )
    match_cache.set(("user-notifications", "facebook", "222", "a"), "2026-01-04 10:00:00")
    rows = load_matches(match_cache)
    row = next(row for row in rows if row["listing_id"] == listing.id)
    assert row["notified_users"] == ["a", "b", "c"]
    assert row["found_at"] == "2026-01-01T10:00:00"
    assert row["score"] == 4
    missing = next(row for row in rows if row["listing_id"] == "222")
    assert missing["url"] == "https://www.facebook.com/marketplace/item/222/"
    assert missing["title"] == "" and missing["score"] is None
    record_match(match_cache, listing, "test", AIResponse(5, "great"))
    record_match(match_cache, listing, "second", AIResponse(3, "okay"))
    rows = load_matches(match_cache)
    assert {(row["item"], row["score"]) for row in rows if row["listing_id"] == listing.id} == {
        ("test", 5),
        ("second", 3),
    }


def test_durable_sightings_states_and_history(match_cache: Cache, listing: Listing) -> None:
    record_match(match_cache, listing, "test", AIResponse(4, "good"), run="first")
    record_delivery(match_cache, listing, "me")
    update_state(match_cache, "facebook", listing.id, {"shortlisted": True, "dismissed": True})
    assert not record_sighting(match_cache, listing, "test", "first")
    assert record_sighting(match_cache, listing, "test", "second")
    # A new ID with identical text is a different listing, not a recognized repost.
    assert not record_sighting(
        match_cache, dataclasses.replace(listing, id="222"), "test", "third"
    )
    listing.price = "$8"
    record_sighting(match_cache, listing, "other", "third")
    match_cache.clear()
    with Cache(match_cache.directory) as reopened:
        row = load_matches(reopened)[0]
        assert row["seen_count"] == 3 and row["last_seen"] >= row["first_seen"]
        assert row["price"] == "$10" and row["current_price"] == "$8"
        assert row["title"] == listing.title and row["notified_users"] == ["me"]
        assert row["state"]["shortlisted"] and row["state"]["dismissed"]
        assert row["filed_under"] == ["test"]  # A sighting elsewhere is not a pass.
        with library(reopened) as store:
            first = store.history("facebook", listing.id, 0, 1)
            assert first["events"][0]["data"]["changes"]["price"] == {
                "before": "$10",
                "after": "$8",
            }
            second = store.history("facebook", listing.id, first["next_cursor"], 1)
            assert second["events"][0]["kind"] == "matched"
            assert second["next_cursor"] is None


def test_migration_rollback_and_retry_preserves_sources(
    match_cache: Cache,
    listing: Listing,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_marketplace_monitor.match_store import MatchStore

    listing.to_cache(listing.post_url, match_cache)
    match_cache.set(
        ("matches", "facebook", listing.id, "test"),
        {
            "found_at": "2025-01-02T10:00:00",
            "price": "$10",
            "score": 4,
        },
    )
    original = MatchStore.save_match
    monkeypatch.setattr(MatchStore, "save_match", Mock(side_effect=RuntimeError("interrupted")))
    with pytest.raises(RuntimeError, match="interrupted"):
        initialize_library(match_cache)
    assert match_cache.get(("matches", "facebook", listing.id, "test"))
    monkeypatch.setattr(MatchStore, "save_match", original)
    initialize_library(match_cache)
    update_state(match_cache, "facebook", listing.id, {"contacted": True})
    initialize_library(match_cache)
    row = load_matches(match_cache)[0]
    assert row["seen_count"] == 0 and row["last_seen"] is None and row["imported"]
    assert row["found_at"] == "2025-01-02T10:00:00" and row["state"]["contacted"]
    with library(match_cache) as store:
        assert len(store.history("facebook", listing.id, 0, 10)["events"]) == 1


def test_clear_cache_imports_library_first(
    match_cache: Cache,
    listing: Listing,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from typer.testing import CliRunner

    from ai_marketplace_monitor import cli

    listing.to_cache(listing.post_url, match_cache)
    match_cache.set(("user-notifications", "facebook", listing.id, "me"), "2025-01-02 10:00:00")
    monkeypatch.setattr(cli, "cache", match_cache)
    result = CliRunner().invoke(cli.app, ["--clear-cache", "all"])
    assert result.exit_code == 0, result.output
    assert len(match_cache) == 0
    assert load_matches(match_cache)[0]["title"] == listing.title


def test_repeated_search_skips_ai_but_keeps_sighting(
    match_cache: Cache,
    listing: Listing,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    record_match(match_cache, listing, "test", AIResponse(4, "good"), run="initial")
    monitor: Any = object.__new__(MarketplaceMonitor)
    monitor.config = SimpleNamespace(user={"me": SimpleNamespace(enabled=True)})
    monitor.logger = Mock()
    monitor.evaluate_by_ai = Mock(side_effect=AssertionError("No repeated AI call"))
    item = SimpleNamespace(name="test", notify=None, rating=[4], searched_count=1)
    market = SimpleNamespace(name="facebook", notify=None, rating=None)
    user = Mock()
    user.notification_status.return_value = NotificationStatus.NOTIFIED
    monkeypatch.setattr("ai_marketplace_monitor.monitor.User", Mock(return_value=user))
    monkeypatch.setattr("ai_marketplace_monitor.monitor.cache", match_cache)
    monkeypatch.setattr("ai_marketplace_monitor.monitor.counter", Mock())
    monkeypatch.setattr("ai_marketplace_monitor.monitor.time.sleep", lambda seconds: None)

    def search(_item: Any, on_listing: Any) -> Any:
        on_listing(listing)
        return [listing, listing]

    monitor.search_item(market, Mock(search=search), item)
    assert load_matches(match_cache)[0]["seen_count"] == 2
    user.notify.assert_not_called()


def test_facebook_observes_before_filtering_without_fetching(
    match_cache: Cache,
    listing: Listing,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_marketplace_monitor.facebook import FacebookItemConfig, FacebookMarketplaceConfig

    record_match(match_cache, listing, "test", AIResponse(4, "good"))
    market: Any = object.__new__(FacebookMarketplace)
    market.page = Mock()
    market.logger = Mock()
    market.keyboard_monitor = None
    market.translator = Mock()
    market.goto_url = Mock()
    market.config = FacebookMarketplaceConfig(name="facebook", search_city=["houston"])
    market.check_listing = Mock(return_value=False)
    market.get_listing_details = Mock(
        side_effect=AssertionError("No detail fetch for rejected result")
    )
    item = FacebookItemConfig(name="test", search_phrases=["camera", "camera gear"])
    monkeypatch.setattr("ai_marketplace_monitor.facebook.time.sleep", lambda seconds: None)
    monkeypatch.setattr("ai_marketplace_monitor.facebook.counter", Mock())
    monkeypatch.setattr(
        "ai_marketplace_monitor.facebook.FacebookSearchResultPage",
        Mock(return_value=Mock(get_listings=Mock(return_value=[listing, listing]))),
    )
    assert (
        list(
            market.search(
                item, on_listing=lambda row: record_sighting(match_cache, row, "test", "second")
            )
        )
        == []
    )
    assert load_matches(match_cache)[0]["seen_count"] == 2
    market.get_listing_details.assert_not_called()


def test_concurrent_partial_states_are_not_lost(match_cache: Cache, listing: Listing) -> None:
    from concurrent.futures import ThreadPoolExecutor

    record_match(match_cache, listing, "test", AIResponse(4, "good"))
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [
            pool.submit(update_state, match_cache, "facebook", listing.id, {key: True})
            for key in ("shortlisted", "contacted")
        ]
        for result in results:
            result.result()
    state = load_matches(match_cache)[0]["state"]
    assert state["shortlisted"] and state["contacted"]


def test_evaluation_history_tracks_outcome_changes_without_duplicate_snapshots(
    match_cache: Cache,
    listing: Listing,
) -> None:
    rating = AIResponse(4, "good")
    record_match(match_cache, listing, "test", rating)
    # Raising the minimum changes the outcome even if the cached rating is unchanged.
    record_failed_rating(match_cache, listing, "test", rating)
    record_failed_rating(match_cache, listing, "test", rating)
    assert load_matches(match_cache)[0]["evaluation_status"] == "below_threshold"
    record_match(match_cache, listing, "test", rating)
    record_failed_rating(match_cache, listing, "other", rating)
    record_failed_rating(match_cache, listing, "other", rating)
    assert len(load_matches(match_cache)) == 1
    with library(match_cache) as store:
        events = store.history("facebook", listing.id, 0, 10)["events"]
    assert len(events) == 4
    assert [event["data"]["status"] for event in reversed(events)] == [
        "passed",
        "below_threshold",
        "passed",
        "below_threshold",
    ]


def test_first_found_price_tags_state_and_filters(match_cache: Cache, listing: Listing) -> None:
    assert record_match(match_cache, listing, "test", AIResponse(5, AIResponse.NOT_EVALUATED))
    before = load_matches(match_cache)[0]
    listing.price = "$1"
    assert not record_match(match_cache, listing, "test", AIResponse(4, "changed"))
    after = load_matches(match_cache)[0]
    assert after["found_at"] == before["found_at"] and after["price"] == "$10"
    assert after["current_price"] == "$1" and after["seen_count"] == 2
    update_state(
        match_cache, "facebook", listing.id, {"shortlisted": True, "filed_under": ["other"]}
    )
    update_state(match_cache, "facebook", listing.id, {"contacted": True})
    with Cache(match_cache.directory) as reopened:
        row = query_matches(reopened, item="other", status="shortlisted")["matches"][0]
        assert row["state"]["contacted"] and row["score"] == 4
    assert query_matches(match_cache, min_score=4)["total"] == 1
    update_state(match_cache, "facebook", listing.id, {"dismissed": True})
    assert query_matches(match_cache)["total"] == 0
    assert query_matches(match_cache)["counts"]["shortlisted"] == 0
    assert query_matches(match_cache, status="dismissed")["total"] == 1
    assert query_matches(match_cache, include_dismissed=True)["total"] == 1
    match_cache.evict(CacheType.AI_INQUIRY.value)
    assert load_matches(match_cache)
    match_cache.clear()
    assert load_matches(match_cache)[0]["state"]["dismissed"]


def test_bounded_join_with_ten_thousand_details(
    match_cache: Cache, listing: Listing, monkeypatch: pytest.MonkeyPatch
) -> None:
    from ai_marketplace_monitor.webui import found_export

    with match_cache.transact():
        for number in range(10000):
            detail = dataclasses.replace(
                listing,
                id=str(number),
                post_url=f"https://www.facebook.com/marketplace/item/{number}/",
            )
            detail.to_cache(detail.post_url, match_cache)
            if number < 200:
                match_cache.set(
                    ("matches", "facebook", detail.id, "test"),
                    {"found_at": "2026-01-01T10:00:00", "price": detail.price, "score": 4},
                )
    original = found_export._load_lookups
    retained = []

    def inspect(*args: Any) -> Any:
        result = original(*args)
        retained.append(len(result[0]))
        return result

    monkeypatch.setattr(found_export, "_load_lookups", inspect)
    result = query_matches(match_cache, limit=25)
    assert result["total"] == 200 and len(result["matches"]) == 25
    assert result["next_cursor"] == "25" and retained == [200]
    next_page = query_matches(match_cache, limit=25, cursor=25)
    assert not {row["key"] for row in result["matches"]} & {
        row["key"] for row in next_page["matches"]
    }


@pytest.mark.parametrize("delivery", ["none", "failed", "disabled", "already_sent"])
def test_search_records_before_delivery(
    match_cache: Cache, listing: Listing, monkeypatch: pytest.MonkeyPatch, delivery: str
) -> None:
    monitor: Any = object.__new__(MarketplaceMonitor)
    monitor.config = SimpleNamespace(
        user={} if delivery == "none" else {"me": SimpleNamespace(enabled=delivery != "disabled")}
    )
    monitor.logger = Mock()
    monitor.evaluate_by_ai = Mock(return_value=AIResponse(5, AIResponse.NOT_EVALUATED))
    item = SimpleNamespace(name="test", notify=None, rating=[4], searched_count=0)
    market = SimpleNamespace(name="facebook", notify=None, rating=None)
    user = Mock()
    user.notification_status.return_value = (
        NotificationStatus.NOTIFIED
        if delivery == "already_sent"
        else NotificationStatus.NOT_NOTIFIED
    )
    user.notify.return_value = False
    monkeypatch.setattr("ai_marketplace_monitor.monitor.User", Mock(return_value=user))
    monkeypatch.setattr("ai_marketplace_monitor.monitor.cache", match_cache)
    monkeypatch.setattr("ai_marketplace_monitor.monitor.counter", Mock())
    monkeypatch.setattr("ai_marketplace_monitor.monitor.time.sleep", lambda seconds: None)
    monitor.search_item(market, Mock(search=Mock(return_value=[listing])), item)
    row = load_matches(match_cache)[0]
    assert row["score"] is None and row["notified_users"] == []
    assert any(
        call.kwargs.get("extra", {}).get("aimm", {}).get("kind") == "match_recorded"
        for call in monitor.logger.info.call_args_list
    )


def test_same_text_different_ids_remain_distinct(
    match_cache: Cache,
    listing: Listing,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monitor: Any = object.__new__(MarketplaceMonitor)
    monitor.config = SimpleNamespace(user={})
    monitor.logger = None
    monitor.evaluate_by_ai = Mock(return_value=AIResponse(4, "good"))
    item = SimpleNamespace(name="test", notify=None, rating=[4], searched_count=1)
    market = SimpleNamespace(name="facebook", notify=None, rating=None)
    monkeypatch.setattr("ai_marketplace_monitor.monitor.cache", match_cache)
    monkeypatch.setattr("ai_marketplace_monitor.monitor.counter", Mock())
    monkeypatch.setattr("ai_marketplace_monitor.monitor.time.sleep", lambda seconds: None)
    repost = dataclasses.replace(listing, id="222", post_url=listing.post_url + "2")
    monitor.search_item(market, Mock(search=Mock(return_value=[listing, repost])), item)
    assert {row["listing_id"] for row in load_matches(match_cache)} == {listing.id, "222"}


def make_monitor(match_cache: Cache, listing: Listing, monkeypatch: pytest.MonkeyPatch) -> Any:
    record_match(match_cache, listing, "test", AIResponse(5, "original"))
    monitor: Any = object.__new__(MarketplaceMonitor)
    monitor.rechecks = RecheckQueue()
    monitor.logger = Mock()
    monitor.config = SimpleNamespace(
        item={
            name: SimpleNamespace(
                name=name, enabled=True, marketplace="facebook", rating=[4], searched_count=1
            )
            for name in ("test", "other")
        },
        marketplace={
            "facebook": SimpleNamespace(
                name="facebook", enabled=True, market_type="facebook", rating=[3]
            )
        },
    )
    monitor.active_marketplaces = {
        "facebook": Mock(
            get_listing_details=Mock(return_value=(listing, False)),
            check_listing=Mock(return_value=True),
        )
    }
    monitor.evaluate_by_ai = Mock(return_value=AIResponse(3, "now below minimum"))
    monkeypatch.setattr("ai_marketplace_monitor.monitor.cache", match_cache)
    monkeypatch.setattr(
        "ai_marketplace_monitor.monitor.User",
        Mock(side_effect=AssertionError("Re-check must not notify")),
    )
    return monitor


def test_recheck_threshold_cross_search_cancel_and_no_delivery(
    match_cache: Cache, listing: Listing, monkeypatch: pytest.MonkeyPatch
) -> None:
    monitor = make_monitor(match_cache, listing, monkeypatch)
    identity = {"marketplace": "facebook", "listing_id": listing.id}
    job = monitor.rechecks.enqueue([identity, identity], "other", True)
    assert monitor.rechecks.wake.is_set()
    thread = threading.get_ident()

    def fetch(*args: Any, **kwargs: Any) -> Any:
        assert threading.get_ident() == thread and kwargs["force_refresh"] is True
        monitor.rechecks.stop(job["job_id"])
        return listing, False

    market = monitor.active_marketplaces["facebook"]
    market.get_listing_details.side_effect = fetch
    monitor.process_recheck()
    status = monitor.rechecks.get(job["job_id"])
    assert status["state"] == "stopped" and status["done"] == 1
    assert status["results"][0]["status"] == "below_threshold"
    assert [row["item"] for row in load_matches(match_cache)] == ["test"]
    assert load_matches(match_cache)[0]["score"] == 5
    market.get_listing_details.side_effect = None
    monitor.evaluate_by_ai.return_value = AIResponse(4, "passes current description")
    job = monitor.rechecks.enqueue([identity], "other", False)
    monitor.process_recheck()
    assert monitor.rechecks.get(job["job_id"])["state"] == "done"
    assert (
        next(row for row in load_matches(match_cache) if row["item"] == "other")["source"]
        == "recheck"
    )
    assert market.get_listing_details.call_args.kwargs["force_refresh"] is False
    cached = Listing.from_cache(listing.post_url, match_cache)
    assert cached is not None and cached.name == "test"
    assert not any(key[0] == "user-notifications" for key in match_cache.iterkeys())


@pytest.mark.parametrize("outcome", ["below_threshold", "filtered_out", "error"])
def test_cross_search_recheck_updates_existing_target(
    match_cache: Cache, listing: Listing, monkeypatch: pytest.MonkeyPatch, outcome: str
) -> None:
    monitor = make_monitor(match_cache, listing, monkeypatch)
    record_match(match_cache, listing, "other", AIResponse(4, "earlier pass"))
    market = monitor.active_marketplaces["facebook"]
    if outcome == "filtered_out":
        market.check_listing.return_value = False
    elif outcome == "error":
        market.get_listing_details.side_effect = ValueError("unavailable")
    monitor.rechecks.enqueue(
        [{"marketplace": "facebook", "listing_id": listing.id, "original_item": "test"}],
        "other",
        True,
    )
    monitor.process_recheck()
    rows = {row["item"]: row for row in load_matches(match_cache)}
    assert rows["test"]["score"] == 5
    assert rows["test"]["evaluation_status"] == "passed"
    assert rows["other"]["recheck"]["status"] == outcome
    assert rows["other"]["evaluation_status"] == ("passed" if outcome == "error" else outcome)
    assert rows["other"]["score"] == (3 if outcome == "below_threshold" else 4)


@pytest.mark.parametrize("failure", ["filter", "error", "price"])
def test_recheck_never_removes_match(
    match_cache: Cache, listing: Listing, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    monitor = make_monitor(match_cache, listing, monkeypatch)
    market = monitor.active_marketplaces["facebook"]
    if failure == "filter":
        market.check_listing.return_value = False
    elif failure == "price":
        monitor.config.item["test"].max_price = "5"
    else:
        market.get_listing_details.side_effect = ValueError("private data must not reach API")
    job = monitor.rechecks.enqueue(
        [{"marketplace": "facebook", "listing_id": listing.id}], None, True
    )
    monitor.process_recheck()
    row = load_matches(match_cache)[0]
    assert row["recheck"]["status"] == ("error" if failure == "error" else "filtered_out")
    assert "private data" not in str(monitor.rechecks.get(job["job_id"]))
    monitor.evaluate_by_ai.assert_not_called()


def test_force_refresh_and_event_wakeup(listing: Listing, monkeypatch: pytest.MonkeyPatch) -> None:
    listing.seller_profile = {"checked_at": datetime.now(timezone.utc).isoformat()}
    market: Any = object.__new__(FacebookMarketplace)
    market.page = Mock()
    market.translator = Mock()
    market.logger = None
    market.goto_url = Mock()
    monkeypatch.setattr(Listing, "from_cache", Mock(return_value=listing))
    write = Mock()
    monkeypatch.setattr(Listing, "to_cache", write)
    monkeypatch.setattr(
        "ai_marketplace_monitor.facebook.parse_listing", Mock(return_value=listing)
    )
    monkeypatch.setattr("ai_marketplace_monitor.facebook.counter", Mock())
    item = SimpleNamespace(name="test")
    assert market.get_listing_details(listing.post_url, item)[1] is True
    market.goto_url.assert_not_called()
    assert market.get_listing_details(listing.post_url, item, force_refresh=True)[1] is False
    market.goto_url.assert_called_once_with(listing.post_url)
    write.assert_called_once()
    event = threading.Event()
    event.set()
    assert doze(100, wake_event=event) == SleepStatus.BY_EVENT


def test_api_auth_validation_and_persistence(
    match_cache: Cache, listing: Listing, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("ai_marketplace_monitor.webui.server.cache", match_cache)
    record_match(match_cache, listing, "test", AIResponse(4, "good"))
    path = tmp_path / "config.toml"
    path.write_text(
        '[marketplace.facebook]\nsearch_city="houston"\n[item.test]\nsearch_phrases="camera"\n[user.me]\n',
        encoding="utf-8",
    )
    queue = RecheckQueue()
    state = AuthState()
    state.exposed = True
    state.auth = AuthConfig("test", hash_password("synthetic-password"), "synthetic-secret")
    handler = LogBroadcastHandler()
    client = TestClient(
        create_app(
            WebUIConfig(config_files=[path], rechecks=queue),
            state,
            ConfigFileService([path]),
            handler,
        )
    )
    url = f"/api/matches/facebook/{listing.id}/state"
    assert client.get("/api/matches").status_code == 401
    assert client.get("/api/matches.csv").status_code == 401
    assert client.get(f"/api/matches/facebook/{listing.id}/history").status_code == 401
    client.post("/api/login", data={"username": "test", "password": "synthetic-password"})
    assert client.put(url, json={"shortlisted": True}).status_code == 403
    headers = {CSRF_HEADER: client.cookies["aimm_csrf"]}
    assert client.put(url, json={"shortlisted": "yes"}, headers=headers).status_code == 400
    assert client.put(url, json={"shortlisted": True}, headers=headers).json()["shortlisted"]
    assert client.get("/api/matches?sort=invalid").status_code == 422
    for query in (
        "sort=invalid",
        "status=invalid",
        "min_score=6",
        "include_dismissed=invalid",
        "price_drop=invalid",
    ):
        assert client.get("/api/matches?" + query).status_code == 422
        assert client.get("/api/matches.csv?" + query).status_code == 422
    body: dict[str, Any] = {
        "listings": [{"marketplace": "facebook", "listing_id": listing.id}],
        "refresh": True,
    }
    assert client.post("/api/matches/recheck", json=body).status_code == 403
    assert (
        client.post(
            "/api/matches/recheck",
            json={**body, "listings": body["listings"] * 26},
            headers=headers,
        ).status_code
        == 400
    )
    response = client.post("/api/matches/recheck", json=body, headers=headers).json()
    job_url = "/api/matches/recheck/" + response["job_id"]
    assert client.get(job_url).json()["state"] == "queued"
    assert client.delete(job_url).status_code == 403
    assert client.delete(job_url, headers=headers).json()["state"] == "stopped"
    assert client.get("/api/matches?status=shortlisted").json()["total"] == 1
    assert (
        client.get(f"/api/matches/facebook/{listing.id}/history?limit=1").json()["events"][0][
            "kind"
        ]
        == "matched"
    )
    assert client.get(f"/api/matches/facebook/{listing.id}/history?cursor=-1").status_code == 422
    assert client.get("/api/matches/facebook/999/history").status_code == 404
    assert client.get("/api/matches?sort=last_seen").status_code == 200


def test_matches_csv_filters_all_pages_without_notification(
    match_cache: Cache, listing: Listing, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("ai_marketplace_monitor.webui.server.cache", match_cache)
    path = tmp_path / "config.toml"
    path.write_text("", encoding="utf-8")
    client = TestClient(
        create_app(
            WebUIConfig(config_files=[path]),
            AuthState(),
            ConfigFileService([path]),
            LogBroadcastHandler(),
        )
    )
    with match_cache.transact():
        for index in range(204):
            entry = dataclasses.replace(
                listing,
                id=str(index),
                title="Camera" if index < 3 else "Other",
                post_url=f"https://www.facebook.com/marketplace/item/{index}/",
                price=f"${100 - index}" if index < 3 else "$200",
            )
            record_match(
                match_cache,
                entry,
                "test" if index < 3 else "batch",
                AIResponse(5 if index == 0 else 4, "good"),
            )
    update_state(match_cache, "facebook", "0", {"shortlisted": True, "filed_under": ["gear"]})
    update_state(match_cache, "facebook", "1", {"contacted": True})
    update_state(match_cache, "facebook", "2", {"dismissed": True})

    def export(query: str = "") -> list[dict[str, str]]:
        response = client.get("/api/matches.csv" + query)
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/csv")
        assert 'filename="matches-' in response.headers["content-disposition"]
        return list(csv.DictReader(io.StringIO(response.text)))

    assert len(client.get("/api/matches").json()["matches"]) == 200
    all_rows = export()
    assert len(all_rows) == 203
    assert all(row["notified_user"] == "" for row in all_rows)
    assert len(export("?item=batch")) == 201
    cases = [
        ("?q=CAMERA&sort=price", ["1", "0"]),
        ("?item=test&sort=score", ["0", "1"]),
        ("?min_score=5", ["0"]),
        ("?status=shortlisted&item=gear&q=Camera&min_score=5", ["0"]),
        ("?status=contacted", ["1"]),
        ("?status=dismissed", ["2"]),
        ("?item=test&include_dismissed=true&sort=price", ["2", "1", "0"]),
        ("?q=absent", []),
    ]
    for query, expected in cases:
        assert [row["url"].rstrip("/").split("/")[-1] for row in export(query)] == expected
    assert list(csv.DictReader(io.StringIO(client.get("/api/found.csv").text))) == []

    with library(match_cache) as store:
        for index in [0, *range(3, 204)]:
            item = "test" if index == 0 else "batch"
            saved = store.match("facebook", str(index), item)
            assert saved is not None
            saved["recheck"] = {
                "at": "2026-10-04T12:00:00",
                "old_price": "$90" if index == 0 else "$200",
            }
            store.save_match("facebook", str(index), item, saved)
            store.snapshot(
                "facebook", str(index), {"price": "$80" if index == 0 else "$150"}, "test"
            )
    dropped = client.get("/api/matches?price_drop=true").json()
    assert dropped["total"] == 202
    assert len(dropped["matches"]) == 200
    assert len(export("?price_drop=true")) == 202
    assert len(export("?price_drop=true&item=batch")) == 201
    assert [row["price"] for row in export("?price_drop=true&item=gear&min_score=5")] == ["$80"]
    assert export("?price_drop=true&status=contacted") == []


@pytest.mark.parametrize(
    ("previous", "current", "old_price", "expected"),
    [
        ("$100", "$80", None, True),
        ("$100", "$80", "$70", False),
        ("$100", "$80", "$90", True),
        ("$100", "$100", None, False),
        ("$100", None, None, False),
        ("Ask seller", "$80", None, False),
        ("$100-$200", "$80", None, False),
    ],
)
def test_price_drop_requires_known_lower_prices(
    previous: str, current: str | None, old_price: str | None, expected: bool
) -> None:
    assert (
        price_dropped(
            {"price": previous, "current_price": current, "recheck": {"old_price": old_price}}
        )
        is expected
    )


def test_price_bounds_do_not_guess_unknown_units() -> None:
    assert "maximum" in price_filter_reason(
        "$300", SimpleNamespace(max_price="200"), SimpleNamespace()
    )
    with pytest.raises(ValueError, match="currency"):
        price_filter_reason("$300", SimpleNamespace(max_price="200 EUR"), SimpleNamespace())
    with pytest.raises(ValueError, match="price"):
        price_filter_reason("Ask seller", SimpleNamespace(max_price="200"), SimpleNamespace())


def test_new_badges_and_manual_groups(match_cache: Cache, listing: Listing) -> None:
    record_match(match_cache, listing, "test", AIResponse(4, "good"))
    update_state(match_cache, "facebook", listing.id, {"filed_under": ["other"]})
    result = query_matches(match_cache, since=datetime(2000, 1, 1, tzinfo=timezone.utc))
    assert result["new_count"] == 1
    assert {group["item"]: group["count"] for group in result["groups"]} == {"test": 1, "other": 1}
    assert (
        query_matches(match_cache, since=datetime(2100, 1, 1, tzinfo=timezone.utc))["new_count"]
        == 0
    )


@pytest.mark.parametrize("work_kind", ["recheck", "image"])
def test_due_search_precedes_background_work(
    monkeypatch: pytest.MonkeyPatch, work_kind: str
) -> None:
    monitor: Any = object.__new__(MarketplaceMonitor)
    monitor.search_requested = threading.Event()
    monitor.rechecks = RecheckQueue()
    if work_kind == "recheck":
        monitor.rechecks.enqueue([{"marketplace": "facebook", "listing_id": "1"}], None, True)
    monitor.image_matcher = SimpleNamespace(
        automatic=False, queue=SimpleNamespace(pending=lambda: work_kind == "image"), scan=Mock()
    )
    monkeypatch.setattr("ai_marketplace_monitor.monitor.load_matches", lambda cache: [])
    monitor.recheck_after = 0
    monitor.keyboard_monitor = None
    monitor.defer_login_until_credentials = False
    monitor.config = SimpleNamespace()
    monitor.config_files = []
    monitor.config_hash = "unchanged"
    monitor.logger = None
    monitor.load_config_file = Mock()
    monitor._launch_browser = Mock()
    monitor.handle_pause = Mock()
    monitor.schedule_jobs = Mock()
    events = []
    job = Mock(next_run=1, tags={"demo"})
    job.run.side_effect = lambda: events.append("initial search")
    monkeypatch.setattr("ai_marketplace_monitor.monitor.KeyboardMonitor", Mock())
    monkeypatch.setattr(
        "ai_marketplace_monitor.monitor.calculate_file_hash", lambda files: "unchanged"
    )
    monkeypatch.setattr("ai_marketplace_monitor.monitor.schedule.get_jobs", lambda: [job])
    monkeypatch.setattr("ai_marketplace_monitor.monitor.schedule.jobs", [job])
    monkeypatch.setattr(
        "ai_marketplace_monitor.monitor.schedule.idle_seconds", Mock(side_effect=[0, 60])
    )
    monkeypatch.setattr(
        "ai_marketplace_monitor.monitor.schedule.run_pending", lambda: events.append("due search")
    )

    def recheck() -> None:
        events.append("recheck")
        raise RuntimeError("safe point reached")

    monitor.process_recheck = recheck

    def image_check(rows: Any) -> None:
        events.append("image")
        raise RuntimeError("safe point reached")

    monitor.image_matcher.process = image_check
    with pytest.raises(RuntimeError, match="safe point reached"):
        monitor.start_monitor()
    assert events == ["initial search", "due search", work_kind]
