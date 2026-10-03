"""Matches persistence, delivery independence, and monitor-thread re-checks."""

import dataclasses
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
from ai_marketplace_monitor.matches import load_matches, query_matches, record_match, update_state
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


def test_first_found_price_tags_state_and_filters(match_cache: Cache, listing: Listing) -> None:
    assert record_match(match_cache, listing, "test", AIResponse(5, AIResponse.NOT_EVALUATED))
    before = match_cache.get(("matches", "facebook", listing.id, "test"))
    listing.price = "$1"
    assert not record_match(match_cache, listing, "test", AIResponse(4, "changed"))
    assert match_cache.get(("matches", "facebook", listing.id, "test")) == before
    update_state(
        match_cache, "facebook", listing.id, {"shortlisted": True, "filed_under": ["other"]}
    )
    update_state(match_cache, "facebook", listing.id, {"contacted": True})
    with Cache(match_cache.directory) as reopened:
        row = query_matches(reopened, item="other", status="shortlisted")["matches"][0]
        assert row["state"]["contacted"] and row["score"] is None
    assert query_matches(match_cache, min_score=4)["total"] == 0
    update_state(match_cache, "facebook", listing.id, {"dismissed": True})
    assert query_matches(match_cache)["total"] == 0
    assert query_matches(match_cache)["counts"]["shortlisted"] == 0
    assert query_matches(match_cache, status="dismissed")["total"] == 1
    assert query_matches(match_cache, include_dismissed=True)["total"] == 1
    match_cache.evict(CacheType.AI_INQUIRY.value)
    assert load_matches(match_cache)
    match_cache.clear()
    assert load_matches(match_cache) == []


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
                record_match(match_cache, detail, "test", AIResponse(4, "good"))
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
    assert match_cache.get(("matches", "facebook", listing.id, "other")) is None
    assert match_cache.get(("matches", "facebook", listing.id, "test"))["score"] == 5
    market.get_listing_details.side_effect = None
    monitor.evaluate_by_ai.return_value = AIResponse(4, "passes current description")
    job = monitor.rechecks.enqueue([identity], "other", False)
    monitor.process_recheck()
    assert monitor.rechecks.get(job["job_id"])["state"] == "done"
    assert match_cache.get(("matches", "facebook", listing.id, "other"))["source"] == "recheck"
    assert market.get_listing_details.call_args.kwargs["force_refresh"] is False
    cached = Listing.from_cache(listing.post_url, match_cache)
    assert cached is not None and cached.name == "test"
    assert not any(key[0] == "user-notifications" for key in match_cache.iterkeys())


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
    client.post("/api/login", data={"username": "test", "password": "synthetic-password"})
    assert client.put(url, json={"shortlisted": True}).status_code == 403
    headers = {CSRF_HEADER: client.cookies["aimm_csrf"]}
    assert client.put(url, json={"shortlisted": "yes"}, headers=headers).status_code == 400
    assert client.put(url, json={"shortlisted": True}, headers=headers).json()["shortlisted"]
    assert client.get("/api/matches?sort=invalid").status_code == 422
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


def test_due_search_precedes_one_recheck(monkeypatch: pytest.MonkeyPatch) -> None:
    monitor: Any = object.__new__(MarketplaceMonitor)
    monitor.search_requested = threading.Event()
    monitor.rechecks = RecheckQueue()
    monitor.rechecks.enqueue([{"marketplace": "facebook", "listing_id": "1"}], None, True)
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
    with pytest.raises(RuntimeError, match="safe point reached"):
        monitor.start_monitor()
    assert events == ["initial search", "due search", "recheck"]
