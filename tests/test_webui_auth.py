"""Tests for auth helpers: password hashing, sessions, rate limiting."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ai_marketplace_monitor.webui.auth import (
    RateLimiter,
    SessionManager,
    hash_password,
    verify_password,
)
from ai_marketplace_monitor.webui.config_api import ConfigFileService
from ai_marketplace_monitor.webui.log_handler import LogBroadcastHandler
from ai_marketplace_monitor.webui.server import WebUIConfig, _resolve_auth, create_app, start_webui


def test_password_roundtrip() -> None:
    pw = "correct horse battery staple"
    h = hash_password(pw)
    assert verify_password(pw, h)
    assert not verify_password("wrong", h)


def test_verify_password_rejects_garbage_hash() -> None:
    assert not verify_password("whatever", "not-a-hash")


def test_session_issue_and_validate() -> None:
    sm = SessionManager("secret-key")
    token, csrf = sm.issue("admin")
    assert sm.validate(token) == "admin"
    assert csrf != ""
    # Different secret → validation fails.
    assert SessionManager("other").validate(token) is None


def test_session_rejects_tampered_token() -> None:
    sm = SessionManager("secret-key")
    token, _ = sm.issue("admin")
    assert sm.validate(token + "x") is None


def test_rate_limiter_locks_after_threshold() -> None:
    rl = RateLimiter()
    for _ in range(5):
        rl.record_failure("1.2.3.4")
    assert rl.is_locked("1.2.3.4")
    assert not rl.is_locked("5.6.7.8")


def test_rate_limiter_reset_on_success() -> None:
    rl = RateLimiter()
    for _ in range(4):
        rl.record_failure("1.2.3.4")
    rl.reset("1.2.3.4")
    assert not rl.is_locked("1.2.3.4")


@pytest.mark.parametrize("local_only", ["0", "1", "true"])
def test_docker_auto_login_is_explicit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, local_only: str
) -> None:
    monkeypatch.setenv("AIMM_WEBUI_LOCAL_ONLY", local_only)
    path = tmp_path / "config.toml"
    path.write_text(
        '[marketplace.facebook]\nusername = "me@example.com"\npassword = "secret"\n',
        encoding="utf-8",
    )
    config = WebUIConfig(host="0.0.0.0", config_files=[path])  # noqa: S104 — Docker bind
    state, _ = _resolve_auth(config)
    client = TestClient(
        create_app(config, state, ConfigFileService([path]), LogBroadcastHandler())
    )
    if local_only == "1":
        assert client.get("/api/auth/info").json()["open"] is True
        assert client.post("/api/login").status_code == 200
        assert client.get("/api/status").status_code == 200
    else:
        assert client.get("/api/auth/info").json()["open"] is False
        assert client.post("/api/login").status_code == 401
        assert client.get("/api/status").status_code == 401
        response = client.post(
            "/api/login", data={"username": "me@example.com", "password": "secret"}
        )
        assert response.status_code == 200
        assert client.get("/api/status").status_code == 200


def test_network_bind_without_credentials_still_requires_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("AIMM_WEBUI_LOCAL_ONLY", "FACEBOOK_USERNAME", "FACEBOOK_PASSWORD"):
        monkeypatch.delenv(name, raising=False)
    config = WebUIConfig(host="0.0.0.0", log_handler=LogBroadcastHandler())  # noqa: S104
    with pytest.raises(RuntimeError, match="requires authentication"):
        start_webui(config)
