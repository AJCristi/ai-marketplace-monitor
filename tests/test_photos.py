import hashlib
import io
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock

import pytest
from diskcache import Cache  # type: ignore
from PIL import Image

from ai_marketplace_monitor.ai import AIResponse
from ai_marketplace_monitor.listing import Listing
from ai_marketplace_monitor.match_store import MatchStore
from ai_marketplace_monitor.matches import library, load_matches, record_match, record_sighting
from ai_marketplace_monitor.photos import (
    MAX_BYTES,
    archive_next_photo,
    download_image,
    image_url_allowed,
    prepare_webp,
)


def image_bytes(color: str = "red", size: tuple[int, int] = (2000, 1000)) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, "PNG")
    return output.getvalue()


def test_webp_archive_caps_dimensions_and_rejects_invalid_images() -> None:
    with Image.open(io.BytesIO(prepare_webp(image_bytes()))) as photo:
        assert photo.format == "WEBP"
        assert photo.size == (1600, 800)
        assert not photo.getexif()
    for data in (b"not an image", b"x" * (MAX_BYTES + 1), image_bytes(size=(5000, 4001))):
        with pytest.raises(ValueError):
            prepare_webp(data)


def test_photo_changes_do_not_change_ai_listing_hash(listing: Listing) -> None:
    updated = replace(listing, image="https://scontent.fbcdn.net/new.jpg", image_urls=["new"])
    assert updated.hash == listing.hash
    assert replace(updated, price="$20").hash != listing.hash


def test_archive_deduplicates_content_preserves_order_and_survives_failed_refresh(
    temp_cache: Cache, listing: Listing, monkeypatch: pytest.MonkeyPatch
) -> None:
    first, second, duplicate, expired = [
        f"https://scontent.fbcdn.net/{name}.jpg" for name in ("one", "two", "duplicate", "expired")
    ]
    listing.image = first
    listing.image_urls = [first, second, duplicate, expired]
    record_match(temp_cache, listing, "camera", AIResponse(4, "good"))
    record_match(temp_cache, listing, "gear", AIResponse(4, "good"))
    download = Mock(
        side_effect=[
            image_bytes(),
            image_bytes("blue"),
            image_bytes(),
            ValueError("Photo expired"),
        ]
    )
    monkeypatch.setattr("ai_marketplace_monitor.photos.download_image", download)
    attempted: set[tuple[str, str, str]] = set()
    results = [archive_next_photo(temp_cache, attempted) for _ in range(4)]
    assert all(result is not None for result in results)
    assert [result["saved"] for result in results if result is not None] == [
        True,
        True,
        True,
        False,
    ]
    assert archive_next_photo(temp_cache, attempted) is None
    rows = load_matches(temp_cache)
    assert rows[0]["photos"] == rows[1]["photos"]
    assert [photo["digest"] for photo in rows[0]["photos"]] == [
        hashlib.sha256(prepare_webp(image_bytes(color))).hexdigest() for color in ("red", "blue")
    ]
    assert rows[0]["photo_pending"] == 1
    assert "data" not in rows[0]["photos"][0]
    # An unavailable/reduced gallery must not delete already archived photos.
    listing.image_urls = []
    record_sighting(temp_cache, listing, "camera", "next-run")
    assert len(load_matches(temp_cache)[0]["photos"]) == 2
    with library(temp_cache) as store:
        assert store.db.execute("SELECT COUNT(*) FROM photo_sources").fetchone()[0] == 3


def test_archive_backfills_saved_primary_and_retries_after_restart(
    temp_cache: Cache, listing: Listing, monkeypatch: pytest.MonkeyPatch
) -> None:
    listing.image = "https://scontent.fbcdn.net/legacy.jpg"
    record_match(temp_cache, listing, "camera", AIResponse(4, "good"))
    download = Mock(side_effect=[ValueError("Expired"), image_bytes()])
    monkeypatch.setattr("ai_marketplace_monitor.photos.download_image", download)
    attempted: set[tuple[str, str, str]] = set()
    failed = archive_next_photo(temp_cache, attempted)
    assert failed is not None and failed["saved"] is False
    assert archive_next_photo(temp_cache, attempted) is None
    retried = archive_next_photo(temp_cache, set())
    assert retried is not None and retried["saved"] is True
    assert load_matches(temp_cache)[0]["photo_pending"] == 0


def test_gallery_schema_upgrade_preserves_listing_and_state(tmp_path: Path) -> None:
    path = tmp_path / "matches.sqlite3"
    with MatchStore(path) as store:
        store.save_listing("facebook", "1", {"title": "Existing", "state": {"shortlisted": True}})
        store.db.executescript(
            "DROP TABLE photos; DROP TABLE photo_sources; PRAGMA user_version=1;"
        )
    with MatchStore(path) as store:
        saved = store.listing("facebook", "1")
        assert saved is not None and saved["state"]["shortlisted"] is True
        assert store.db.execute("PRAGMA user_version").fetchone()[0] == 3
        assert store.photos("facebook", "1") == []
    with MatchStore(path) as store:
        saved = store.listing("facebook", "1")
        assert saved is not None and saved["title"] == "Existing"


def test_photo_metadata_reads_skip_photo_blobs_after_upgrade(tmp_path: Path) -> None:
    path = tmp_path / "matches.sqlite3"
    with MatchStore(path) as store:
        store.db.executescript("DROP INDEX photos_metadata; PRAGMA user_version=2;")
    with MatchStore(path) as store:
        plans = [
            " ".join(str(row["detail"]) for row in store.db.execute(f"EXPLAIN QUERY PLAN {query}"))
            for query in (
                "SELECT marketplace,listing_id,digest,saved_at FROM photos ORDER BY position,digest",
                (
                    "SELECT digest,saved_at FROM photos WHERE marketplace='facebook' "
                    "AND listing_id='1' ORDER BY position,digest"
                ),
            )
        ]
    assert all("COVERING INDEX photos_metadata" in plan for plan in plans)


@pytest.mark.parametrize(
    "url",
    [
        "http://scontent.fbcdn.net/a",
        "https://localhost/a",
        "https://127.0.0.1/a",
        "https://fbcdn.net.evil.test/a",
        "https://user:pass@scontent.fbcdn.net/a",
        "https://scontent.fbcdn.net:8443/a",
        "file:///a",
    ],
)
def test_download_url_boundary(url: str) -> None:
    assert not image_url_allowed(url)


def test_download_redirect_revalidated(monkeypatch: pytest.MonkeyPatch) -> None:
    reply = Mock(is_redirect=True, headers={"Location": "http://127.0.0.1/private"})
    reply.__enter__ = Mock(return_value=reply)
    reply.__exit__ = Mock(return_value=False)
    get = Mock(return_value=reply)
    monkeypatch.setattr("ai_marketplace_monitor.photos.requests.get", get)
    with pytest.raises(ValueError, match="supported Facebook"):
        download_image("https://scontent.fbcdn.net/a")
    assert get.call_count == 1
    assert get.call_args.kwargs["allow_redirects"] is False
