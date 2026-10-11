"""Facebook sessions persist through a temporary home, with a mocked browser."""

import json
import os
import stat
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest

from ai_marketplace_monitor.facebook import FacebookMarketplace

LOGGED_IN = [{"name": "c_user", "value": "1"}]
LOGGED_OUT = [{"name": "datr", "value": "x"}]
STATE = {"cookies": LOGGED_IN, "origins": []}


@pytest.fixture
def market(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr("ai_marketplace_monitor.facebook.amm_home", tmp_path)
    monkeypatch.setattr("ai_marketplace_monitor.facebook.time.sleep", Mock())
    market: Any = object.__new__(FacebookMarketplace)
    market.name = "facebook"
    market.browser, market.page, market.logger = Mock(), None, Mock()
    market.keyboard_monitor, market.logged_in = None, None
    market.config = Mock(
        username="someone", password="synthetic-password", login_wait_time=0, monitor_config=None
    )
    return market


def logged_page(cookies: list[dict[str, str]], url: str = "https://www.facebook.com/") -> Mock:
    page = Mock(url=url)
    page.context.cookies.return_value = cookies
    page.context.storage_state.return_value = {"cookies": cookies, "origins": []}
    return page


def session_path(tmp_path: Path) -> Path:
    return tmp_path / "facebook-session-facebook.json"


def write_session(market: Any, tmp_path: Path, account: str | None = None) -> None:
    saved = {"account": account or market.session_account(), "storage_state": STATE}
    session_path(tmp_path).write_text(json.dumps(saved), encoding="utf-8")


def login_statuses(market: Any) -> list[str]:
    calls = market.logger.info.call_args_list + market.logger.warning.call_args_list
    return [
        call.kwargs["extra"]["aimm"]["status"]
        for call in calls
        if call.kwargs.get("extra", {}).get("aimm", {}).get("kind") == "facebook_login"
    ]


def test_session_file_name_is_safe_for_any_marketplace_name(market: Any, tmp_path: Path) -> None:
    market.name = "my market/../x"
    assert market.session_file() == tmp_path / "facebook-session-my_market____x.json"


@pytest.mark.parametrize("saved", [True, False])
def test_create_page_loads_saved_session_only_when_present(
    market: Any, tmp_path: Path, saved: bool
) -> None:
    if saved:
        write_session(market, tmp_path)
    market.create_page()
    kwargs = market.browser.new_context.call_args.kwargs
    assert kwargs.get("storage_state") == (STATE if saved else None)


def test_session_saved_for_another_account_is_ignored(market: Any, tmp_path: Path) -> None:
    write_session(market, tmp_path, account="someone-else")
    market.create_page()
    assert "storage_state" not in market.browser.new_context.call_args.kwargs


@pytest.mark.parametrize("content", ["not json", '{"cookies": []}'])
def test_unreadable_saved_session_falls_back_to_fresh_context(
    market: Any, tmp_path: Path, content: str
) -> None:
    session_path(tmp_path).write_text(content, encoding="utf-8")
    market.create_page()
    assert "storage_state" not in market.browser.new_context.call_args.kwargs
    market.logger.warning.assert_called_once()


def test_rejected_storage_state_falls_back_without_logging_its_contents(
    market: Any, tmp_path: Path
) -> None:
    write_session(market, tmp_path)
    market.browser.new_context.side_effect = [ValueError("bad state"), Mock()]
    assert market.create_page() is not None
    assert "storage_state" not in market.browser.new_context.call_args.kwargs
    assert "bad state" not in market.logger.warning.call_args.args[0]


def test_login_reuses_saved_session_without_typing_credentials(
    market: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    page = logged_page(LOGGED_IN)
    market.create_page, market.goto_url = Mock(return_value=page), Mock()
    doze = Mock()
    monkeypatch.setattr("ai_marketplace_monitor.facebook.doze", doze)
    market.config.login_wait_time = 60
    market.login()
    page.wait_for_selector.assert_not_called()
    doze.assert_not_called()
    saved = json.loads(session_path(tmp_path).read_text(encoding="utf-8"))
    assert saved == {"account": market.session_account(), "storage_state": STATE}
    assert login_statuses(market) == ["logged_in"]


def test_checkpoint_page_is_not_treated_as_logged_in(market: Any, tmp_path: Path) -> None:
    page = logged_page(LOGGED_IN, url="https://www.facebook.com/auth_platform/codesubmit/?apc=x")
    market.create_page, market.goto_url = Mock(return_value=page), Mock()
    market.login()
    page.wait_for_selector.assert_called()
    assert not session_path(tmp_path).exists()
    assert login_statuses(market) == ["logged_out"]


def test_manual_login_during_wait_saves_session(market: Any, tmp_path: Path) -> None:
    page = logged_page(LOGGED_IN)
    page.context.cookies.side_effect = [LOGGED_OUT, LOGGED_IN]
    market.create_page, market.goto_url = Mock(return_value=page), Mock()
    market.login()
    page.wait_for_selector.assert_called()
    assert session_path(tmp_path).exists()
    assert login_statuses(market) == ["logged_in"]


def test_failed_login_does_not_save_session(market: Any, tmp_path: Path) -> None:
    page = logged_page(LOGGED_OUT)
    market.create_page, market.goto_url = Mock(return_value=page), Mock()
    market.login()
    page.wait_for_selector.assert_called()
    assert not session_path(tmp_path).exists()
    assert login_statuses(market) == ["logged_out"]


@pytest.mark.parametrize(("cookies", "saved"), [(LOGGED_IN, True), (LOGGED_OUT, False)])
def test_search_refreshes_session_when_logged_in(
    market: Any, tmp_path: Path, cookies: list[dict[str, str]], saved: bool
) -> None:
    market.page = logged_page(cookies)
    market._search_listings = Mock(return_value=iter(["listing"]))
    assert list(market.search(Mock())) == ["listing"]
    assert session_path(tmp_path).exists() is saved


def test_search_refreshes_session_when_stopped_early(market: Any, tmp_path: Path) -> None:
    market.page = logged_page(LOGGED_IN)
    market._search_listings = Mock(return_value=iter(["first", "second"]))
    results = market.search(Mock())
    next(results)
    results.close()
    assert session_path(tmp_path).exists()


@pytest.mark.parametrize(("before", "reported"), [(True, []), (False, ["logged_in"])])
def test_search_reports_login_status_only_when_it_changes(
    market: Any, before: bool, reported: list[str]
) -> None:
    market.logged_in = before
    market.page = logged_page(LOGGED_IN)
    market._search_listings = Mock(return_value=iter([]))
    list(market.search(Mock()))
    assert login_statuses(market) == reported


@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes")
def test_saved_session_is_readable_only_by_owner(market: Any, tmp_path: Path) -> None:
    market.page = logged_page(LOGGED_IN)
    market.save_session()
    assert stat.S_IMODE(session_path(tmp_path).stat().st_mode) == 0o600


def test_failed_save_keeps_previous_session_and_leaves_no_temp_file(
    market: Any, tmp_path: Path
) -> None:
    session_file = session_path(tmp_path)
    session_file.write_text('{"cookies": []}', encoding="utf-8")
    market.page = Mock()
    market.page.context.storage_state.side_effect = RuntimeError("browser closed")
    market.save_session()
    assert session_file.read_text(encoding="utf-8") == '{"cookies": []}'
    assert list(tmp_path.iterdir()) == [session_file]
