from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest

from ai_marketplace_monitor.facebook import FacebookMarketplace, FacebookSearchResultPage
from ai_marketplace_monitor.listing import Listing
from ai_marketplace_monitor.monitor import MarketplaceMonitor
from ai_marketplace_monitor.price_check import (
    PriceCheckQueue,
    parse_price,
    price_check_context,
    summarize_prices,
)


def result_listing(listing_id: str, price: str, title: str = "GoPro Hero 12") -> Listing:
    return Listing(
        marketplace="facebook",
        name="",
        id=listing_id,
        title=title,
        image="",
        price=price,
        post_url=f"https://www.facebook.com/marketplace/item/{listing_id}/?ref=search",
        location="Houston, TX",
        seller="",
        condition="",
        description="",
    )


@pytest.mark.parametrize(
    "price, parsed",
    [
        ("$1,200", ("$", 1200.0)),
        ("$180 | $200", ("$", 180.0)),
        ("€ 99.50", ("€", 99.5)),
        ("250", ("", 250.0)),
        ("Free", None),
        ("", None),
    ],
)
def test_parse_price_reads_the_first_amount(price: str, parsed: Any) -> None:
    assert parse_price(price) == parsed


def test_summary_excludes_junk_duplicates_and_other_currencies() -> None:
    listings = [
        result_listing(str(index), f"${price}")
        for index, price in enumerate([100, 150, 200, 250, 300, 400])
    ]
    listings += [
        result_listing("0", "$100"),
        result_listing("case", "$5", "GoPro case only"),
        result_listing("free", "Free"),
        result_listing("euro", "€90"),
    ]
    summary = summarize_prices(listings, ["case"])
    assert {key: summary[key] for key in ("count", "excluded", "unpriced", "currency")} == {
        "count": 6,
        "excluded": 1,
        "unpriced": 1,
        "currency": "$",
    }
    assert summary["other_currencies"] == {"€": 1}
    assert [summary[key] for key in ("low", "p25", "median", "p75", "high")] == [
        100,
        162,
        225,
        288,
        400,
    ]
    assert summary["examples"][0] == {
        "title": "GoPro Hero 12",
        "price": "$100",
        "location": "Houston, TX",
        "url": "https://www.facebook.com/marketplace/item/0/",
    }
    assert summary["titles"][-1] == "$400 — GoPro Hero 12"

    context = price_check_context(
        {**summary, "searched": {"phrases": ["gopro hero 12"], "cities": ["houston"]}}
    )
    assert context.startswith('<facebook_price_check>\nSearched "gopro hero 12" in houston.')
    assert "median 225" in context and context.endswith("</facebook_price_check>")


def test_summary_without_prices_has_no_statistics() -> None:
    summary = summarize_prices([result_listing("1", "Free")], [])
    assert summary["count"] == 0 and "median" not in summary
    assert "Prices" not in price_check_context({**summary, "searched": {}})
    one = summarize_prices([result_listing("1", "$50")], [])
    assert [one[key] for key in ("low", "p25", "median", "p75", "high")] == [50] * 5


def test_queue_runs_one_check_at_a_time_and_can_stop() -> None:
    queue = PriceCheckQueue()
    first = queue.enqueue({"search_phrases": ["bike"]})
    assert queue.wake.is_set() and first["state"] == "queued"
    with pytest.raises(ValueError, match="already running"):
        queue.enqueue({"search_phrases": ["bike"]})
    job_id, request = queue.take() or ("", {})
    assert job_id == first["job_id"] and request == {"search_phrases": ["bike"]}
    assert queue.take() is None
    assert queue.finish(job_id, result={"count": 1})["state"] == "done"
    second = queue.enqueue({"search_phrases": ["car"]})["job_id"]
    queue.take()
    assert queue.stop(second)["state"] == "stopped" and queue.stopped(second)
    assert queue.finish(second, result={"count": 1})["state"] == "stopped"
    assert not queue.pending()
    for _ in range(25):
        queue.stop(queue.enqueue({})["job_id"])
    assert len(queue.jobs) == 20


def test_results_page_search_uses_only_phrase_and_radius(monkeypatch: Any) -> None:
    marketplace: Any = object.__new__(FacebookMarketplace)
    marketplace.page, marketplace.translator, marketplace.logger = Mock(), Mock(), None
    marketplace.goto_url = Mock()
    monkeypatch.setattr(FacebookSearchResultPage, "get_listings", lambda self: ["listing"])
    assert marketplace.search_result_listings("gopro hero 12", "houston", 40) == ["listing"]
    marketplace.goto_url.assert_called_with(
        "https://www.facebook.com/marketplace/houston/search?query=gopro%20hero%2012&radius=40"
    )
    marketplace.search_result_listings("bike", "austin", None)
    marketplace.goto_url.assert_called_with(
        "https://www.facebook.com/marketplace/austin/search?query=bike"
    )


def test_monitor_checks_saved_cities_and_reports_failures(monkeypatch: Any) -> None:
    monkeypatch.setattr("ai_marketplace_monitor.monitor.time.sleep", lambda seconds: None)
    monitor: Any = object.__new__(MarketplaceMonitor)
    monitor.logger = Mock()
    monitor.price_checks = PriceCheckQueue()
    facebook = Mock()
    facebook.search_result_listings.side_effect = lambda phrase, city, radius: [
        result_listing(f"{phrase}-{city}", "$100" if city == "houston" else "$300")
    ]
    monitor.active_marketplaces = {"facebook": facebook}
    marketplace_config = SimpleNamespace(
        market_type="facebook", search_city=["dallas"], radius=None, city_name=None
    )
    item_config = SimpleNamespace(
        marketplace="facebook",
        search_city=["houston", "austin", "waco"],
        radius=[40, 60, 80],
        city_name=["Houston", None, "Waco"],
    )
    monitor.config = SimpleNamespace(
        item={"gopro": item_config}, marketplace={"facebook": marketplace_config}
    )
    phrases = ["a", "b", "c", "d"]
    job_id = monitor.price_checks.enqueue(
        {"item": "gopro", "search_phrases": phrases, "antikeywords": []}
    )["job_id"]
    monitor.process_price_check()
    job = monitor.price_checks.get(job_id)
    assert job["state"] == "done"
    assert job["result"]["searched"] == {
        "phrases": ["a", "b", "c"],
        "cities": ["Houston", "austin"],
    }
    assert (job["result"]["count"], job["result"]["median"]) == (6, 200)
    assert facebook.search_result_listings.call_args_list[1].args == ("a", "austin", 60)

    monitor.price_checks.enqueue({"item": "", "search_phrases": ["a"], "antikeywords": []})
    facebook.search_result_listings.side_effect = RuntimeError("https://secret-token")
    monitor.process_price_check()
    failed = monitor.price_checks.get(next(reversed(monitor.price_checks.jobs)))
    assert failed["state"] == "error" and "secret" not in failed["error"]
    assert facebook.search_result_listings.call_args.args == ("a", "dallas", None)
