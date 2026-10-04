"""Thread-safe job bookkeeping. Only the monitor takes and executes work."""

from __future__ import annotations

import copy
import math
import re
import threading
import uuid
from typing import Any

from .matches import price_number


def price_filter_reason(price: str, item: Any, marketplace: Any) -> str:
    """Apply price bounds normally enforced by the Marketplace search page.

    Currency conversion is only safe when a single configured currency identifies
    the listing's units. Ambiguous or unavailable prices are errors, not passes.
    """
    bounds = [
        (name, getattr(item, name, None) or getattr(marketplace, name, None))
        for name in ("min_price", "max_price")
    ]
    if not any(value for _, value in bounds):
        return ""
    amount = price_number(price)
    if not math.isfinite(amount):
        raise ValueError("The listing price cannot be compared with the search's price limits")
    currencies = getattr(item, "currency", None) or getattr(marketplace, "currency", None) or []
    if isinstance(currencies, str):
        currencies = [currencies]
    explicit = re.search(r"\b([A-Z]{3})\b", price)
    currency = (
        explicit[1] if explicit else next(iter(currencies)) if len(set(currencies)) == 1 else None
    )
    for name, value in bounds:
        if not value:
            continue
        parts = str(value).split()
        bound = float(parts[0])
        if len(parts) > 1:
            if currency is None:
                raise ValueError("Cannot determine the listing currency for this price limit")
            if parts[1] != currency:
                from currency_converter import CurrencyConverter  # type: ignore

                bound = CurrencyConverter().convert(bound, parts[1], currency)
        if (name == "min_price" and amount < bound) or (name == "max_price" and amount > bound):
            return f"Price is {'below the minimum' if name == 'min_price' else 'above the maximum'} ({value})"
    return ""


class RecheckQueue:
    def __init__(self) -> None:
        self.wake = threading.Event()
        self.lock = threading.Lock()
        self.jobs: dict[str, dict[str, Any]] = {}

    def enqueue(
        self, listings: list[dict[str, str]], item: str | None, refresh: bool
    ) -> dict[str, Any]:
        with self.lock:
            if sum(job["state"] in ("queued", "running") for job in self.jobs.values()) >= 10:
                raise ValueError("Ten re-check jobs are already pending; wait for one to finish")
            # ponytail: keep the latest 100 jobs in memory; persistent job recovery would
            # require a disk-backed queue if jobs must survive a monitor process restart.
            for key in list(self.jobs):
                if len(self.jobs) < 100:
                    break
                if self.jobs[key]["state"] in ("done", "stopped"):
                    del self.jobs[key]
            job_id = uuid.uuid4().hex
            self.jobs[job_id] = {
                "job_id": job_id,
                "state": "queued",
                "done": 0,
                "total": len(listings),
                "results": [],
                "listings": listings,
                "item": item,
                "searches": sorted({entry.get("original_item", "") for entry in listings}),
                "refresh": refresh,
                "stop": False,
            }
            self.wake.set()
            return {"job_id": job_id, "queued": len(listings)}

    def get(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            job = self.jobs[job_id]
            return copy.deepcopy(
                {
                    name: job[name]
                    for name in ("job_id", "state", "done", "total", "results", "item", "searches")
                }
            )

    def stop(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            job = self.jobs[job_id]
            job["stop"] = True
            if job["state"] == "queued" or (
                job["state"] == "running" and not job.get("in_flight")
            ):
                job["state"] = "stopped"
            self.wake.set()
        return self.get(job_id)

    def take(self) -> tuple[str, dict[str, Any], str | None, bool] | None:
        with self.lock:
            self.wake.clear()
            for job_id, job in self.jobs.items():
                if job["state"] not in ("queued", "running") or job["stop"]:
                    continue
                job["state"] = "running"
                job["in_flight"] = True
                return job_id, job["listings"][job["done"]], job["item"], job["refresh"]
        return None

    def finish(self, job_id: str, result: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            job = self.jobs[job_id]
            job["results"].append(result)
            job["done"] += 1
            job["in_flight"] = False
            if job["stop"] or result["status"] == "error":
                job["state"] = "stopped"
            elif job["done"] == job["total"]:
                job["state"] = "done"
            if any(value["state"] in ("queued", "running") for value in self.jobs.values()):
                self.wake.set()
        return self.get(job_id)

    def pending(self) -> bool:
        with self.lock:
            return any(
                job["state"] in ("queued", "running") and not job["stop"]
                for job in self.jobs.values()
            )
