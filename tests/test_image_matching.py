"""Image matching contracts with real images/cache and mocked external I/O."""

import dataclasses
import io
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest
from diskcache import Cache  # type: ignore
from fastapi.testclient import TestClient
from openai import APIStatusError
from PIL import Image

from ai_marketplace_monitor.ai import AIResponse, OpenAIConfig
from ai_marketplace_monitor.config import Config
from ai_marketplace_monitor.image_matching import (
    TAG,
    ImageMatcher,
    comparison,
    download_image,
    image_url_allowed,
    observation,
    prepare_image,
)
from ai_marketplace_monitor.matches import load_matches, record_match
from ai_marketplace_monitor.utils import MonitorConfig
from ai_marketplace_monitor.webui.auth import CSRF_HEADER, AuthConfig, hash_password
from ai_marketplace_monitor.webui.config_api import ConfigFileService
from ai_marketplace_monitor.webui.log_handler import LogBroadcastHandler
from ai_marketplace_monitor.webui.server import AuthState, WebUIConfig, create_app


def photo(color: str) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (128, 96), color).save(output, "PNG")
    return output.getvalue()


def response(value: Any) -> Any:
    return SimpleNamespace(
        usage=SimpleNamespace(prompt_tokens=1000, completion_tokens=100),
        choices=[
            SimpleNamespace(
                finish_reason="stop", message=SimpleNamespace(content=json.dumps(value))
            )
        ],
    )


@pytest.fixture
def service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    with Cache(str(tmp_path / "images")) as cache:
        matcher = ImageMatcher(cache)
        matcher.configure(
            SimpleNamespace(
                monitor=MonitorConfig(
                    name="monitor", image_matching_ai="mimo", image_matching_daily_budget=1
                ),
                ai={
                    "mimo": OpenAIConfig(
                        name="mimo",
                        provider="openai",
                        api_key="synthetic",
                        model="mimo-v2.6-pro",
                        base_url="https://api.xiaomimimo.com/v1",
                    )
                },
            )
        )
        client = Mock()
        client.__enter__ = Mock(return_value=client)
        client.__exit__ = Mock(return_value=False)
        create = client.chat.completions.create

        def answer(**kwargs: Any) -> Any:
            prompt = kwargs["messages"][-1]["content"][0]["text"]
            if "category" in prompt:
                return response(
                    {
                        "category": "vehicle",
                        "details": ["scratched bumper"],
                        "plate": {"text": "ABC-123", "jurisdiction": "PH", "readable": True},
                    }
                )
            return response(
                {"decision": "matching_plate", "evidence": ["Both photos show ABC-123."]}
            )

        create.side_effect = answer
        monkeypatch.setattr(
            "ai_marketplace_monitor.image_matching.OpenAI", Mock(return_value=client)
        )
        monkeypatch.setattr(
            "ai_marketplace_monitor.image_matching.download_image",
            lambda url: photo("red" if "one" in url else "blue"),
        )
        yield matcher, create


def rows() -> list[dict[str, Any]]:
    return [
        {
            "marketplace": "facebook",
            "listing_id": name,
            "image": f"https://scontent.fbcdn.net/{name}.png",
            "title": "Used car",
            "found_at": "2026-10-01",
            "url": f"https://www.facebook.com/marketplace/item/{name}",
        }
        for name in ("one", "two")
    ]


def finish(matcher: ImageMatcher, entries: list[dict[str, Any]]) -> Any:
    result = None
    for _ in range(40):
        if not matcher.queue.pending():
            break
        result = matcher.process(entries)
    assert not matcher.queue.pending()
    return result


def test_manual_when_auto_off_cache_refresh_and_symmetric_review(service: Any) -> None:
    matcher, create = service
    entries = rows()
    matcher.enqueue(entries[0])
    assert finish(matcher, entries)["state"] == "done"
    assert create.call_count == 3
    pair = matcher.related(entries[0])[0]
    assert pair["other"]["listing_id"] == "two"
    matcher.review(entries[1], pair["pair_id"], "confirmed")
    assert matcher.related(entries[0])[0]["review"] == "confirmed"
    matcher.enqueue(entries[0])
    finish(matcher, entries)
    assert create.call_count == 3
    matcher.enqueue(entries[0], refresh=True)
    finish(matcher, entries)
    assert create.call_count == 6
    assert matcher.related(entries[0])[0]["review"] == "confirmed"
    with Cache(matcher.cache.directory) as reopened:
        restored = ImageMatcher(reopened)
        assert restored.related(entries[1])[0]["review"] == "confirmed"
        assert reopened.get((TAG, "budget", matcher.budget()["day"])) > 0


def test_auto_disabled_cancels_pending_and_model_changes_invalidate(service: Any) -> None:
    matcher, create = service
    entries = rows()
    matcher.config.monitor.image_matching = True
    matcher.scan(entries[:1])
    matcher.config.monitor.image_matching = False
    assert finish(matcher, entries)["state"] == "stopped"
    assert create.call_count == 0
    matcher.enqueue(entries[0])
    finish(matcher, entries)
    matcher.config.ai["mimo"].model = "new-vision-model"
    matcher.enqueue(entries[0])
    finish(matcher, entries)
    assert create.call_count == 6
    assert matcher.related(entries[0])[0]["review"] == "unreviewed"


def test_one_model_call_per_monitor_step_and_duplicate_job_coalescing(service: Any) -> None:
    matcher, create = service
    entries = rows()
    first = matcher.enqueue(entries[0])
    assert matcher.enqueue(entries[0]) == first
    while matcher.queue.pending():
        count = create.call_count
        matcher.process(entries)
        assert create.call_count - count <= 1


def test_auto_resumes_after_budget_increase_without_rebilling_cached_pairs(service: Any) -> None:
    matcher, create = service
    matcher.config.monitor.image_matching = True
    matcher.config.monitor.image_matching_daily_budget = 0.000001
    matcher.scan(rows())
    finish(matcher, rows())
    assert create.call_count == 0
    matcher.next_scan = 0
    matcher.scan(rows())
    assert not matcher.queue.pending()
    matcher.config.monitor.image_matching_daily_budget = 1
    matcher.next_scan = 0
    matcher.scan(rows())
    finish(matcher, rows())
    assert create.call_count == 3
    assert matcher.related(rows()[1])
    matcher.next_scan = 0
    matcher.scan(rows())
    assert not matcher.queue.pending()


def test_concurrent_manual_requests_share_one_job(service: Any) -> None:
    from concurrent.futures import ThreadPoolExecutor

    matcher, create = service
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = list(pool.map(lambda _: matcher.enqueue(rows()[0]), range(8)))
    assert len({job["job_id"] for job in jobs}) == 1
    assert create.call_count == 0


def test_budget_reservation_survives_failure_and_blocks_later_calls(service: Any) -> None:
    matcher, create = service
    create.side_effect = RuntimeError("provider failure containing synthetic-secret")
    matcher.enqueue(rows()[0])
    job = finish(matcher, rows())
    assert "synthetic-secret" not in json.dumps(job)
    used = matcher.budget()["used_usd"]
    assert used > 0
    matcher.config.monitor.image_matching_daily_budget = used
    matcher.enqueue(rows()[0], refresh=True)
    job = finish(matcher, rows())
    assert "daily budget reached" in job["results"][0]["reason"]
    assert create.call_count == 1
    assert matcher.budget()["used_usd"] == used


@pytest.mark.parametrize("status_code", [400, 404, 422, 401, 403, 429, 500])
@pytest.mark.parametrize("automatic", [False, True])
def test_provider_rejections_report_manual_error_or_automatic_skip(
    service: Any, status_code: int, automatic: bool
) -> None:
    matcher, create = service
    entries = rows()
    matcher.config.monitor.image_matching = automatic
    original_answer = create.side_effect
    create.side_effect = APIStatusError(
        "Image inputs unsupported; synthetic-secret",
        response=Mock(status_code=status_code, headers={}),
        body={"error": {"message": "Image inputs unsupported; synthetic-secret"}},
    )
    matcher.enqueue(entries[0], automatic=automatic)
    job = finish(matcher, entries)
    result = job["results"][0]
    rejected = status_code in (400, 404, 422)
    skipped = automatic and rejected
    assert job["state"] == ("done" if skipped else "stopped")
    assert result["status"] == ("skipped" if skipped else "error")
    assert (result.get("error_code") == "model_request_rejected") == rejected
    assert ("image inputs and JSON output" in result["reason"]) == rejected
    assert "synthetic-secret" not in json.dumps(matcher.status(entries[0]))
    assert matcher.status(entries[0])["last_check"]["status"] == result["status"]
    assert matcher.budget()["used_usd"] > 0
    assert not matcher.related(entries[0])
    assert matcher.cache.get((TAG, "listing", "facebook", "one")) is None
    # A failed job must not block subsequent work after the provider is corrected.
    create.side_effect = original_answer
    matcher.enqueue(entries[1], automatic=automatic)
    assert finish(matcher, entries)["state"] == "done"
    assert matcher.related(entries[1])


def test_invalid_response_is_not_cached_and_is_counted(service: Any) -> None:
    matcher, create = service
    create.return_value = response({"category": "vehicle", "details": "not a list"})
    create.side_effect = None
    matcher.enqueue(rows()[0])
    assert finish(matcher, rows())["state"] == "stopped"
    assert matcher.budget()["used_usd"] > 0
    assert not matcher.related(rows()[0])
    assert matcher.cache.get((TAG, "listing", "facebook", "one")) is None


def test_review_during_recheck_is_preserved_and_changed_photos_mark_old_evidence(
    service: Any,
) -> None:
    matcher, create = service
    entries = rows()
    matcher.enqueue(entries[0])
    finish(matcher, entries)
    pair = matcher.related(entries[0])[0]
    original_answer = create.side_effect

    def answer(**kwargs: Any) -> Any:
        if "Compare photo" in kwargs["messages"][-1]["content"][0]["text"]:
            matcher.review(entries[0], pair["pair_id"], "confirmed")
        return original_answer(**kwargs)

    create.side_effect = answer
    matcher.enqueue(entries[0], refresh=True)
    finish(matcher, entries)
    changed = {**entries[0], "image": "https://scontent.fbcdn.net/new-photo.png"}
    result = matcher.related(changed)[0]
    assert result["review"] == "confirmed" and result["stale"]
    assert result["source"]["image"] == entries[0]["image"]


def test_uncertain_or_conflicting_plates_do_not_create_plate_flags() -> None:
    def feature(text: str, region: str = "PH", readable: bool = True) -> Any:
        return observation(
            {
                "category": "car",
                "details": [],
                "plate": {"text": text, "jurisdiction": region, "readable": readable},
            }
        )

    result = {"decision": "matching_plate", "evidence": ["Same plate"]}
    left = feature("ABC 123")
    assert comparison(result, left, feature("ABC-123"))["decision"] == "matching_plate"
    for right in (
        feature("ABC 123", readable=False),
        feature("ABC 123", region="UK"),
        feature("ABC I23"),
        feature("ABC ???"),
    ):
        assert comparison(result, left, right)["decision"] == "insufficient_evidence"


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
    monkeypatch.setattr("ai_marketplace_monitor.image_matching.requests.get", get)
    with pytest.raises(ValueError, match="supported Facebook"):
        download_image("https://scontent.fbcdn.net/a")
    assert get.call_count == 1
    assert get.call_args.kwargs["allow_redirects"] is False


def test_real_image_preparation_rejects_invalid_and_caps_size() -> None:
    result = prepare_image(photo("red"))
    with Image.open(io.BytesIO(result["data"])) as image:
        assert image.format == "JPEG" and max(image.size) <= 1024
    with pytest.raises(ValueError, match="readable"):
        prepare_image(b"not an image")
    with pytest.raises(ValueError, match="large"):
        prepare_image(b"x" * (5 * 1024 * 1024 + 1))


@pytest.mark.parametrize("value", [-1, float("nan"), float("inf"), True, "1"])
def test_budget_config_rejects_unsafe_values(value: Any) -> None:
    with pytest.raises(ValueError):
        MonitorConfig(name="monitor", image_matching_daily_budget=value)


def test_config_references_and_manual_settings(config_file: Any) -> None:
    base = '[marketplace.facebook]\nsearch_city="houston"\n[item.test]\nsearch_phrases="car"\n[user.me]\n'
    ai = '[ai.mimo]\nprovider="openai"\nmodel="mimo-v2.6-pro"\nbase_url="https://api.xiaomimimo.com/v1"\napi_key="synthetic"\n'
    config = Config(
        [
            Path(
                config_file(
                    base
                    + ai
                    + '[monitor]\nimage_matching_ai="mimo"\nimage_matching_daily_budget=0.5\n'
                )
            )
        ]
    )
    assert not config.monitor.image_matching
    for monitor in (
        'image_matching_ai="missing"',
        "image_matching=true",
        'image_matching=true\nimage_matching_ai="mimo"',
    ):
        with pytest.raises(ValueError):
            Config([Path(config_file(base + ai + "[monitor]\n" + monitor))])


def test_authenticated_api_enqueues_without_io_and_persists_review(
    service: Any, listing: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    matcher, create = service
    monkeypatch.setattr("ai_marketplace_monitor.webui.server.cache", matcher.cache)
    for entry in rows():
        saved = dataclasses.replace(
            listing, id=entry["listing_id"], image=entry["image"], post_url=entry["url"]
        )
        record_match(matcher.cache, saved, "test", AIResponse(4, "Good"))
    path = tmp_path / "config.toml"
    path.write_text(
        '[marketplace.facebook]\nsearch_city="houston"\n[item.test]\nsearch_phrases="car"\n[user.me]\n',
        encoding="utf-8",
    )
    state = AuthState()
    state.exposed = True
    state.auth = AuthConfig("test", hash_password("synthetic-password"), "synthetic-secret")
    client = TestClient(
        create_app(
            WebUIConfig(config_files=[path], image_matcher=matcher),
            state,
            ConfigFileService([path]),
            LogBroadcastHandler(),
        )
    )
    url = "/api/matches/facebook/one/related"
    assert client.get(url).status_code == 401
    assert client.post(url, json={}).status_code == 401
    client.post("/api/login", data={"username": "test", "password": "synthetic-password"})
    assert client.post(url, json={}).status_code == 403
    headers = {CSRF_HEADER: client.cookies["aimm_csrf"]}
    assert client.post(url, json={"refresh": "true"}, headers=headers).status_code == 400
    assert (
        client.post("/api/matches/facebook/missing/related", json={}, headers=headers).status_code
        == 404
    )
    assert client.post(url, json={}, headers=headers).status_code == 200
    assert create.call_count == 0
    finish(matcher, load_matches(matcher.cache))
    data = client.get(url).json()
    pair = data["related"][0]
    assert client.put(url + "/" + pair["pair_id"], json={"review": "confirmed"}).status_code == 403
    assert (
        client.put(
            url + "/" + pair["pair_id"], json={"review": "confirmed"}, headers=headers
        ).status_code
        == 200
    )
    assert (
        client.get("/api/matches/facebook/two/related").json()["related"][0]["review"]
        == "confirmed"
    )
    assert client.get("/api/matches").json()["matches"][0]["related_count"] == 1
    assert matcher.cache.get(("user-notifications", "facebook", "one", "me")) is None
