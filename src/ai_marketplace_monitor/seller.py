"""Evidence-based seller labels, independent of listing scores and notifications."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit


def profile_url(value: str) -> str:
    """Accept only Facebook seller identities, never arbitrary scraped links."""
    try:
        url = urlsplit(urljoin("https://www.facebook.com/", value))
        if url.scheme != "https" or url.netloc not in {
            "www.facebook.com",
            "facebook.com",
            "m.facebook.com",
        }:
            return ""
        match = re.fullmatch(r"/marketplace/profile/(\d+)/?", url.path)
        identity = match[1] if match else parse_qs(url.query).get("id", [""])[0]
        if not match and url.path != "/profile.php":
            return ""
        return (
            f"https://www.facebook.com/marketplace/profile/{identity}/"
            if re.fullmatch(r"\d+", identity)
            else ""
        )
    except ValueError:
        return ""


class _SellerPanel(HTMLParser):
    """Read the seller heading's section, excluding scripts and unrelated page text."""

    def __init__(self, heading: str) -> None:
        super().__init__()
        self.label = heading
        self.heading: list[str] | None = None
        self.active = False
        self.done = False
        self.stack: list[tuple[str, bool]] = []
        self.parts: list[str] = []
        self.urls: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        hidden = (
            bool(self.stack and self.stack[-1][1])
            or tag in {"script", "style", "template"}
            or "hidden" in attributes
            or attributes.get("aria-hidden") == "true"
            or bool(
                re.search(
                    r"(?:display\s*:\s*none|visibility\s*:\s*hidden)",
                    attributes.get("style") or "",
                    re.I,
                )
            )
        )
        if tag not in {
            "area",
            "base",
            "br",
            "col",
            "embed",
            "hr",
            "img",
            "input",
            "link",
            "meta",
            "param",
            "source",
            "track",
            "wbr",
        }:
            self.stack.append((tag, hidden))
        if hidden or self.done:
            return
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            if self.active:
                self.done = True
                self.active = False
            self.heading = []
        if self.active:
            if tag == "a":
                url = profile_url(attributes.get("href") or "")
                if url:
                    self.urls.add(url)
            # Accessible star ratings may have no visible text.
            label = attributes.get("aria-label") or ""
            if re.fullmatch(r"(?:Rated )?[0-5](?:\.\d+)? out of 5(?: stars)?", label, re.I):
                self.parts.append(label)

    def handle_endtag(self, tag: str) -> None:
        hidden = bool(self.stack and self.stack[-1][1])
        if not hidden and tag in {"h1", "h2", "h3", "h4", "h5", "h6"} and self.heading is not None:
            if " ".join(self.heading).strip() == self.label and not self.done:
                self.active = True
            self.heading = None
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data: str) -> None:
        if self.done or (self.stack and self.stack[-1][1]):
            return
        text = data.strip()
        if self.heading is not None:
            if text:
                self.heading.append(text)
        elif self.active and text:
            if text in {"Sponsored", "Send seller a message", "Today's picks"}:
                self.active = False
                self.done = True
            else:
                self.parts.append(text)


def parse_seller_evidence(
    html: str, heading: str = "Seller information", joined_label: str = "Joined Facebook in"
) -> dict[str, Any]:
    """Collect explicit facts only; unfamiliar layouts/languages yield missing fields."""
    panel = _SellerPanel(heading)
    panel.feed(html)
    evidence: dict[str, Any] = {"checked_at": datetime.now(timezone.utc).isoformat()}
    # Ambiguous identities must never combine evidence from different sellers.
    if len(panel.urls) != 1:
        return evidence
    evidence["profile_url"] = next(iter(panel.urls))
    text = " ".join(panel.parts)
    years = set(re.findall(re.escape(joined_label) + r"\s+(\d{4})\b", text))
    if len(years) == 1:
        year = int(next(iter(years)))
        if 2004 <= year <= datetime.now(timezone.utc).year:
            evidence["joined_year"] = year
    # ponytail: parse explicit English rating labels only; add localized patterns
    # when captured seller panels establish their exact format.
    ratings = set(re.findall(r"\b([0-5](?:\.\d+)?)\s+out of 5\b", text, re.I))
    counts = set(
        re.findall(
            r"(?<![\w.,])([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s+(?:ratings|reviews)\b", text, re.I
        )
    )
    compact = re.findall(
        r"\b([0-5](?:\.\d+)?)\s*\(\s*[\d,]+\s+(?:ratings|reviews)\s*\)", text, re.I
    )
    ratings.update(compact)
    if len(ratings) == 1 and len(counts) == 1:
        rating = float(next(iter(ratings)))
        count = int(next(iter(counts)).replace(",", ""))
        if 0 <= rating <= 5 and count > 0:
            evidence.update(rating=rating, review_count=count)
    return evidence


def evidence_fresh(evidence: Any, now: datetime | None = None) -> bool:
    if not isinstance(evidence, dict):
        return False
    try:
        age = (now or datetime.now(timezone.utc)) - datetime.fromisoformat(evidence["checked_at"])
        return timedelta(0) <= age <= timedelta(days=30)
    except (KeyError, TypeError, ValueError):
        return False


def assess_seller(evidence: Any, now: datetime | None = None) -> dict[str, Any]:
    """Use conservative, explainable rules; these are signals, not identity checks."""
    now = now or datetime.now(timezone.utc)
    evidence = evidence if isinstance(evidence, dict) else {}
    url = profile_url(str(evidence.get("profile_url") or ""))
    result: dict[str, Any] = {
        "status": "unknown",
        "reasons": [],
        "profile_url": url,
        "checked_at": evidence.get("checked_at"),
    }
    reasons = result["reasons"]
    if not evidence_fresh(evidence, now):
        reasons.append(
            "Seller evidence is missing or older than 30 days. Re-check the listing to refresh it."
        )
        return result
    if not url:
        reasons.append("A seller profile could not be identified in the listing's seller panel.")
        return result
    year = evidence.get("joined_year")
    year = year if type(year) is int and 2004 <= year <= now.year else None
    rating, count = evidence.get("rating"), evidence.get("review_count")
    feedback = (
        type(rating) in (int, float) and 0 <= rating <= 5 and type(count) is int and count > 0
    )
    reasons.append(
        f"Joined Facebook in {year}." if year else "Account join year is not available."
    )
    reasons.append(
        f"Seller rating {rating:g}/5 from {count} reviews."
        if feedback
        else "Seller rating and review count are not available."
    )
    if feedback and count >= 5 and rating < 3:
        result["status"] = "caution"
        reasons.append("Low seller rating across at least five reviews.")
    elif year == now.year:
        result["status"] = "caution"
        reasons.append("Account was created this year; its short history warrants a closer look.")
    elif year and now.year - year >= 2 and feedback and count >= 5 and rating >= 4:
        result["status"] = "established"
        reasons.append("Account history and positive seller feedback support this assessment.")
    else:
        reasons.append("Not enough corroborating evidence to assess seller credibility.")
    return result
