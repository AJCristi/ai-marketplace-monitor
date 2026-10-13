"""Facebook results-page price checks for the web console's search chat."""

import copy
import re
import statistics
import threading
import uuid
from collections import Counter
from typing import Any

from .listing import Listing
from .utils import is_substring

PRICE_CHECK_MAX_PHRASES = 3
PRICE_CHECK_MAX_CITIES = 2
PRICE_CHECK_EXAMPLES = 8
PRICE_CHECK_CONTEXT_TITLES = 30
PRICE_CHECK_JOBS_KEPT = 20


class PriceCheckQueue:
    def __init__(self) -> None:
        self.wake = threading.Event()
        self.lock = threading.RLock()
        self.jobs: dict[str, dict[str, Any]] = {}

    def enqueue(self, request: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            if self.pending():
                raise ValueError("A price check is already running; wait for it to finish")
            for job_id in list(self.jobs)[: max(0, len(self.jobs) + 1 - PRICE_CHECK_JOBS_KEPT)]:
                del self.jobs[job_id]
            job_id = uuid.uuid4().hex
            self.jobs[job_id] = {
                "job_id": job_id,
                "state": "queued",
                "request": request,
                "result": None,
                "error": "",
            }
            self.wake.set()
            return self.get(job_id)

    def get(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            job = self.jobs[job_id]
            return copy.deepcopy({key: job[key] for key in ("job_id", "state", "result", "error")})

    def take(self) -> tuple[str, dict[str, Any]] | None:
        with self.lock:
            for job_id, job in self.jobs.items():
                if job["state"] == "queued":
                    job["state"] = "running"
                    return job_id, copy.deepcopy(job["request"])
        return None

    def stop(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            job = self.jobs[job_id]
            if job["state"] in ("queued", "running"):
                job["state"] = "stopped"
            return self.get(job_id)

    def stopped(self, job_id: str) -> bool:
        with self.lock:
            return self.jobs[job_id]["state"] == "stopped"

    def finish(
        self, job_id: str, result: dict[str, Any] | None = None, error: str = ""
    ) -> dict[str, Any]:
        with self.lock:
            job = self.jobs[job_id]
            if job["state"] == "running":
                job.update(state="error" if error else "done", result=result, error=error)
            return self.get(job_id)

    def pending(self) -> bool:
        with self.lock:
            return any(job["state"] in ("queued", "running") for job in self.jobs.values())


def parse_price(price: str) -> tuple[str, float] | None:
    """The currency symbol and first amount of a results-page price, or None if unpriced."""
    matched = re.match(r"\s*([^\d\s]*)\s*(\d[\d,]*(?:\.\d+)?)", price or "")
    if not matched:
        return None
    return matched.group(1), float(matched.group(2).replace(",", ""))


def summarize_prices(listings: list[Listing], antikeywords: list[str]) -> dict[str, Any]:
    unique = list({listing.id or listing.post_url: listing for listing in listings}.values())
    kept = [
        listing
        for listing in unique
        if not (antikeywords and is_substring(antikeywords, listing.title))
    ]
    priced = [(listing, parse_price(listing.price)) for listing in kept]
    currencies = Counter(price[0] for _, price in priced if price is not None)
    summary: dict[str, Any] = {
        "count": 0,
        "excluded": len(unique) - len(kept),
        "unpriced": sum(price is None for _, price in priced),
        "currency": "",
        "other_currencies": {},
        "examples": [],
        "titles": [],
    }
    if not currencies:
        return summary
    currency = currencies.most_common(1)[0][0]
    rows = sorted(
        ((price[1], listing) for listing, price in priced if price and price[0] == currency),
        key=lambda row: row[0],
    )
    amounts = [amount for amount, _ in rows]
    low, median, high = amounts[0], statistics.median(amounts), amounts[-1]
    p25, _, p75 = (
        statistics.quantiles(amounts, n=4, method="inclusive") if len(amounts) > 1 else [low] * 3
    )
    step = max(1, len(rows) / PRICE_CHECK_EXAMPLES)
    samples = [rows[int(index * step)] for index in range(min(len(rows), PRICE_CHECK_EXAMPLES))]
    summary.update(
        count=len(rows),
        currency=currency,
        other_currencies={key: value for key, value in currencies.items() if key != currency},
        low=round(low),
        p25=round(p25),
        median=round(median),
        p75=round(p75),
        high=round(high),
        examples=[
            {
                "title": listing.title,
                "price": listing.price,
                "location": listing.location,
                "url": listing.post_url.split("?")[0],
            }
            for _, listing in samples
        ],
        titles=[f"{listing.price} — {listing.title}" for _, listing in rows][
            :PRICE_CHECK_CONTEXT_TITLES
        ],
    )
    return summary


def price_check_context(result: dict[str, Any]) -> str:
    """Plain-text summary the chat attaches to the buyer's next message."""
    searched = result.get("searched", {})
    lines = [
        "Searched "
        + ", ".join(f'"{phrase}"' for phrase in searched.get("phrases", []))
        + " in "
        + ", ".join(searched.get("cities", []))
        + f". {result['count']} priced listings; {result['excluded']} excluded by "
        f"anti-keywords; {result['unpriced']} free or unpriced."
    ]
    if result["count"]:
        lines.append(
            f"Prices ({result['currency'] or 'no symbol'}): lowest {result['low']}, "
            f"25th percentile {result['p25']}, median {result['median']}, "
            f"75th percentile {result['p75']}, highest {result['high']}."
        )
        lines += ["Listings (seller-written titles):", *result["titles"]]
    return "<facebook_price_check>\n" + "\n".join(lines) + "\n</facebook_price_check>"
