"""Bounded local WebP archives, shared by every search for a listing."""

from __future__ import annotations

import hashlib
import io
import json
import time
from typing import Any
from urllib.parse import urljoin, urlsplit

import requests
from diskcache import Cache  # type: ignore
from PIL import Image, ImageOps

from .match_store import photo_urls, source_hash
from .matches import library

MAX_BYTES = 5 * 1024 * 1024
MAX_STORED_BYTES = 512 * 1024


def image_url_allowed(url: str) -> bool:
    """Only Facebook image CDNs; no credentials, custom ports or arbitrary URLs."""
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        return (
            parsed.scheme == "https"
            and parsed.port in (None, 443)
            and not parsed.username
            and not parsed.password
            and any(
                host == domain or host.endswith("." + domain)
                for domain in ("fbcdn.net", "fbsbx.com")
            )
        )
    except ValueError:
        return False


def download_image(url: str) -> bytes:
    """Bound downloads and validate each redirect, without logging signed URLs."""
    started = time.monotonic()
    for _ in range(4):
        if not image_url_allowed(url):
            raise ValueError("The saved photo is not a supported Facebook image URL.")
        try:
            with requests.get(
                url, timeout=(5, 15), stream=True, allow_redirects=False
            ) as response:
                if response.is_redirect:
                    url = urljoin(url, response.headers.get("Location", ""))
                    continue
                response.raise_for_status()
                data = bytearray()
                for chunk in response.iter_content(65536):
                    data.extend(chunk)
                    if len(data) > MAX_BYTES or time.monotonic() - started > 30:
                        raise ValueError("The saved photo exceeds the image download limit.")
                return bytes(data)
        except requests.RequestException:
            raise ValueError(
                "The saved photo could not be downloaded; re-check the listing to refresh its photo."
            ) from None
    raise ValueError("The saved photo redirected too many times.")


def open_photo(raw: bytes, max_side: int) -> Image.Image:
    """Decode an untrusted photo upright as RGB, bounded in bytes, pixels and size."""
    if len(raw) > MAX_BYTES:
        raise ValueError("The saved photo is too large.")
    try:
        with Image.open(io.BytesIO(raw)) as original:
            if original.width * original.height > 20_000_000:
                raise ValueError("The saved photo has too many pixels.")
            photo = ImageOps.exif_transpose(original).convert("RGB")
    except (OSError, Image.DecompressionBombError):
        raise ValueError("The saved photo is not a readable image.") from None
    photo.thumbnail((max_side, max_side))
    return photo


def prepare_webp(raw: bytes) -> bytes:
    output = io.BytesIO()
    open_photo(raw, 1600).save(output, "WEBP", quality=80)
    data = output.getvalue()
    if len(data) > MAX_STORED_BYTES:
        raise ValueError("The saved photo exceeds the archive size limit.")
    return data


def thumbnail_webp(data: bytes) -> bytes:
    """Lists show photos at about 96 px, so send a small copy of the 1600 px archive."""
    output = io.BytesIO()
    open_photo(data, 320).save(output, "WEBP", quality=75)
    return output.getvalue()


def archive_next_photo(
    local_cache: Cache, attempted: set[tuple[str, str, str]]
) -> dict[str, Any] | None:
    """One attempt per source per process; no HTTP inside a database transaction."""
    candidate = None
    with library(local_cache) as store:
        saved = {
            tuple(row)
            for row in store.db.execute(
                "SELECT marketplace,listing_id,source_hash FROM photo_sources"
            )
        }
        for market, listing_id, payload in store.db.execute("SELECT * FROM listings"):
            for url in photo_urls(json.loads(payload)):
                key = (market, listing_id, source_hash(url))
                if key not in saved and key not in attempted:
                    candidate = (key, url)
                    break
            if candidate:
                break
    if candidate is None:
        return None
    key, url = candidate
    attempted.add(key)
    result: dict[str, Any] = {"marketplace": key[0], "listing_id": key[1], "saved": False}
    try:
        data = prepare_webp(download_image(url))
        digest = hashlib.sha256(data).hexdigest()
        with library(local_cache) as store:
            if store.listing(key[0], key[1]) is not None:
                store.save_photo(*key, digest, data)
                result["saved"] = True
    except ValueError as error:
        result["reason"] = str(error)
    return result
