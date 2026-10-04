"""Regression checks for manual searches with unchanged config content."""

import logging
import subprocess
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from ai_marketplace_monitor.monitor import MarketplaceMonitor
from ai_marketplace_monitor.recheck import RecheckQueue
from ai_marketplace_monitor.utils import SleepStatus
from ai_marketplace_monitor.webui.auth import CSRF_HEADER, AuthConfig, hash_password
from ai_marketplace_monitor.webui.config_api import ConfigFileService
from ai_marketplace_monitor.webui.log_handler import LogBroadcastHandler
from ai_marketplace_monitor.webui.server import AuthState, WebUIConfig, create_app


@pytest.mark.parametrize("revision", ["a" * 40, "b" * 64, "invalid metadata"])
def test_status_captures_build_revision_at_startup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, revision: str
) -> None:
    monkeypatch.setenv("AIMM_BUILD_SHA", revision)
    path = tmp_path / "config.toml"
    path.write_text("", encoding="utf-8")
    state = AuthState()
    client = TestClient(
        create_app(
            WebUIConfig(config_files=[path]),
            state,
            ConfigFileService([path]),
            LogBroadcastHandler(),
        )
    )
    monkeypatch.setenv("AIMM_BUILD_SHA", "c" * 40)
    build = client.get("/api/status").json()["build"]
    assert build["sha"] == (revision if revision != "invalid metadata" else None)
    assert build["version"] and build["dirty"] is False
    state.exposed = True
    assert client.get("/api/status").status_code == 401


def test_build_revision_uses_source_checkout_and_handles_missing_git(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from ai_marketplace_monitor.webui import server

    monkeypatch.delenv("AIMM_BUILD_SHA", raising=False)
    monkeypatch.setattr(
        server,
        "__file__",
        str(tmp_path / "src" / "ai_marketplace_monitor" / "webui" / "server.py"),
    )
    assert server._build_info()["sha"] is None  # Installed distributions have no checkout.
    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(
        server.subprocess,
        "check_output",
        Mock(side_effect=["d" * 40 + "\n", " M src/ai_marketplace_monitor/webui/server.py\n"]),
    )
    build = server._build_info()
    assert build["sha"] == "d" * 40 and build["dirty"] is True
    monkeypatch.setattr(
        server.subprocess, "check_output", Mock(side_effect=subprocess.TimeoutExpired("git", 2))
    )
    assert server._build_info()["sha"] is None


@pytest.mark.parametrize("image_arrives_during_clear", [False, True])
def test_request_runs_again_with_unchanged_config(
    monkeypatch: pytest.MonkeyPatch, image_arrives_during_clear: bool
) -> None:
    monitor: Any = object.__new__(MarketplaceMonitor)
    monitor.search_requested = threading.Event()
    monitor.rechecks = RecheckQueue()
    pending_image: list[bool] = []
    monitor.image_matcher = SimpleNamespace(
        automatic=False, queue=SimpleNamespace(pending=lambda: bool(pending_image))
    )
    if image_arrives_during_clear:
        monkeypatch.setattr(monitor.rechecks.wake, "clear", lambda: pending_image.append(True))
    monitor.recheck_after = 0.0
    monitor.keyboard_monitor = None
    monitor.defer_login_until_credentials = False
    monitor.config = SimpleNamespace()
    monitor.config_files = []
    monitor.config_hash = "unchanged"
    monitor.logger = Mock()
    monitor.load_config_file = Mock()
    monitor._launch_browser = Mock()
    monitor.handle_pause = Mock()
    monitor.schedule_jobs = Mock(side_effect=[None, RuntimeError("second scheduling reached")])
    job = Mock(next_run=1, tags={"demo"})
    monkeypatch.setattr("ai_marketplace_monitor.monitor.KeyboardMonitor", Mock())
    monkeypatch.setattr(
        "ai_marketplace_monitor.monitor.calculate_file_hash", lambda files: "unchanged"
    )
    monkeypatch.setattr("ai_marketplace_monitor.monitor.schedule.get_jobs", lambda: [job])
    monkeypatch.setattr("ai_marketplace_monitor.monitor.schedule.jobs", [job])
    monkeypatch.setattr("ai_marketplace_monitor.monitor.schedule.idle_seconds", lambda: 5)
    clear = Mock()
    monkeypatch.setattr("ai_marketplace_monitor.monitor.schedule.clear", clear)

    def wake(*args):
        assert args[0] == (1 if image_arrives_during_clear else 5)
        monitor.request_search()
        return SleepStatus.BY_FILE_CHANGE

    monkeypatch.setattr("ai_marketplace_monitor.monitor.doze", wake)
    with pytest.raises(RuntimeError, match="second scheduling reached"):
        monitor.start_monitor()
    clear.assert_called_once()
    assert monitor.schedule_jobs.call_count == 2
    assert not monitor.search_requested.is_set()


def test_restart_api_signals_monitor_and_context_requires_auth(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text(
        '[marketplace.facebook]\nsearch_city = "houston"\n[item.camera]\nsearch_phrases = "camera"\n[user.me]\n',
        encoding="utf-8",
    )
    request_search = Mock()
    handler = LogBroadcastHandler()
    config = WebUIConfig(config_files=[path], log_handler=handler, request_search=request_search)
    state = AuthState()
    client = TestClient(create_app(config, state, ConfigFileService([path]), handler))
    assert client.post("/api/monitor/restart").status_code == 200
    request_search.assert_called_once()
    assert "inherited" in client.get("/api/config/context").json()
    handler.emit(logging.LogRecord("demo", logging.INFO, "test", 1, "hello", (), None))
    snapshot = client.get("/api/logs").json()
    assert snapshot["stream_id"] == handler.stream_id
    with client.websocket_connect("/ws/stream") as stream:
        assert stream.receive_json()["stream_id"] == snapshot["stream_id"]
    state.exposed = True
    assert client.get("/api/config/context").status_code == 401
    assert client.post("/api/monitor/restart").status_code == 401


def test_authenticated_console_requires_csrf_and_recovers_after_expiry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "config.toml"
    path.write_text(
        '[marketplace.facebook]\nsearch_city = "houston"\n[item.camera]\nsearch_phrases = "camera"\n[user.me]\n',
        encoding="utf-8",
    )
    state = AuthState()
    state.exposed = True
    state.auth = AuthConfig("review", hash_password("synthetic-password"), "synthetic-secret")
    handler = LogBroadcastHandler()
    requested = Mock()
    client = TestClient(
        create_app(
            WebUIConfig(config_files=[path], request_search=requested),
            state,
            ConfigFileService([path]),
            handler,
        )
    )
    assert client.get("/api/status").status_code == 401
    login = {"username": "review", "password": "synthetic-password"}
    assert client.post("/api/login", data=login).status_code == 200
    assert client.get("/api/config/context").status_code == 200
    assert client.post("/api/monitor/restart").status_code == 403
    headers = {CSRF_HEADER: client.cookies["aimm_csrf"]}
    assert client.post("/api/monitor/restart", headers=headers).status_code == 200
    requested.assert_called_once()
    with monkeypatch.context() as expired:
        expired.setattr("ai_marketplace_monitor.webui.auth.SESSION_TTL", -1)
        assert client.get("/api/status").status_code == 401
    assert client.post("/api/login", data=login).status_code == 200
    # A new login rotates CSRF; an earlier tab/request must use the new cookie.
    assert client.post("/api/monitor/restart", headers=headers).status_code == 403
    headers = {CSRF_HEADER: client.cookies["aimm_csrf"]}
    config = client.get("/api/config/file/primary").json()
    assert (
        client.post("/api/config/validate", json={"content": config["content"]}).status_code == 403
    )
    assert client.post(
        "/api/config/validate", json={"content": config["content"]}, headers=headers
    ).json()["valid"]
    assert client.post("/api/logout").status_code == 200
    assert client.get("/api/status").status_code == 401


def test_all_fixed_start_times_are_registered_with_marketplace_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import schedule

    from ai_marketplace_monitor.facebook import FacebookItemConfig, FacebookMarketplaceConfig

    monitor: Any = object.__new__(MarketplaceMonitor)
    market = FacebookMarketplaceConfig(name="my_account", search_city=["houston"])
    item = FacebookItemConfig(
        name="camera",
        marketplace="my_account",
        search_phrases=["camera"],
        start_at=["09:00", "18:00", "*:30", "*:*:15"],
    )
    monitor.config = SimpleNamespace(marketplace={"my_account": market}, item={"camera": item})
    monitor.active_marketplaces = {}
    monitor.logger = None
    monitor.browser = None
    monitor.keyboard_monitor = None
    monitor.load_config_file = Mock()
    monitor.load_ai_agents = Mock()
    monitor._select_translator = Mock(return_value=None)
    factory = Mock(return_value=Mock())
    monkeypatch.setattr(
        "ai_marketplace_monitor.monitor.supported_marketplaces", {"facebook": factory}
    )
    monkeypatch.setattr(schedule, "default_scheduler", schedule.Scheduler())
    monitor.schedule_jobs()
    jobs = schedule.get_jobs("camera")
    assert len(jobs) == 4
    assert [job.unit for job in jobs] == ["days", "days", "hours", "minutes"]
    assert [job.at_time.strftime("%H:%M:%S") if job.at_time else None for job in jobs] == [
        "09:00:00",
        "18:00:00",
        "00:30:00",
        "00:00:15",
    ]
    factory.assert_called_once()


def test_ai_reload_replaces_previous_agents(monkeypatch: pytest.MonkeyPatch) -> None:
    monitor: Any = object.__new__(MarketplaceMonitor)
    provider = SimpleNamespace(name="openai", provider=None, enabled=True)
    monitor.config = SimpleNamespace(ai={"openai": provider})
    monitor.ai_agents = []
    monitor.logger = None
    factory = Mock(side_effect=lambda **kwargs: Mock(config=kwargs["config"]))
    monkeypatch.setattr(
        "ai_marketplace_monitor.monitor.supported_ai_backends", {"openai": factory}
    )
    monitor.load_ai_agents()
    monitor.load_ai_agents()
    assert len(monitor.ai_agents) == 1
    assert factory.call_count == 2
    provider.enabled = False
    monitor.load_ai_agents()
    assert monitor.ai_agents == []


def test_fixed_times_do_not_repeat_initial_search(monkeypatch: pytest.MonkeyPatch) -> None:
    monitor: Any = object.__new__(MarketplaceMonitor)
    monitor.search_requested = threading.Event()
    monitor.rechecks = RecheckQueue()
    monitor.image_matcher = SimpleNamespace(
        automatic=False, queue=SimpleNamespace(pending=lambda: False)
    )
    monitor.recheck_after = 0.0
    monitor.keyboard_monitor = None
    monitor.defer_login_until_credentials = False
    monitor.config = SimpleNamespace()
    monitor.config_files = []
    monitor.config_hash = "unchanged"
    monitor.logger = Mock()
    monitor.load_config_file = Mock()
    monitor._launch_browser = Mock()
    monitor.handle_pause = Mock()
    monitor.schedule_jobs = Mock()
    jobs = [
        Mock(next_run=1, tags={"camera"}),
        Mock(next_run=2, tags={"camera"}),
        Mock(next_run=3, tags={"bike"}),
    ]
    monkeypatch.setattr("ai_marketplace_monitor.monitor.KeyboardMonitor", Mock())
    monkeypatch.setattr(
        "ai_marketplace_monitor.monitor.calculate_file_hash", lambda files: "unchanged"
    )
    monkeypatch.setattr("ai_marketplace_monitor.monitor.schedule.get_jobs", lambda: jobs)
    monkeypatch.setattr("ai_marketplace_monitor.monitor.schedule.jobs", jobs)
    monkeypatch.setattr("ai_marketplace_monitor.monitor.schedule.idle_seconds", lambda: 5)
    monkeypatch.setattr(
        "ai_marketplace_monitor.monitor.doze", Mock(side_effect=RuntimeError("sleep reached"))
    )
    with pytest.raises(RuntimeError, match="sleep reached"):
        monitor.start_monitor()
    jobs[0].run.assert_called_once()
    jobs[1].run.assert_not_called()
    jobs[2].run.assert_called_once()
