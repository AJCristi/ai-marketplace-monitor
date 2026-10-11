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


@pytest.fixture
def market(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr("ai_marketplace_monitor.facebook.amm_home", tmp_path)
    market: Any = object.__new__(FacebookMarketplace)
    market.name = "facebook"
    market.browser, market.page, market.logger = Mock(), None, Mock()
    market.keyboard_monitor = None
    market.config = Mock(
        username="someone", password="synthetic-password", login_wait_time=0, monitor_config=None
    )
    return market


def logged_page(cookies: list[dict[str, str]]) -> Mock:
    page = Mock()
    page.context.cookies.return_value = cookies
    page.context.storage_state.return_value = {"cookies": cookies, "origins": []}
    return page


def test_session_file_name_is_safe_for_any_marketplace_name(market: Any, tmp_path: Path) -> None:
    market.name = "my market/../x"
    assert market.session_file() == tmp_path / "facebook-session-my_market____x.json"


@pytest.mark.parametrize("saved", [True, False])
def test_create_page_loads_saved_session_only_when_present(
    market: Any, tmp_path: Path, saved: bool
) -> None:
    session_file = tmp_path / "facebook-session-facebook.json"
    if saved:
        session_file.write_text("{}", encoding="utf-8")
    market.create_page()
    kwargs = market.browser.new_context.call_args.kwargs
    assert kwargs.get("storage_state") == (str(session_file) if saved else None)


def test_unreadable_saved_session_falls_back_to_fresh_context(market: Any, tmp_path: Path) -> None:
    (tmp_path / "facebook-session-facebook.json").write_text("not json", encoding="utf-8")
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
    saved = json.loads((tmp_path / "facebook-session-facebook.json").read_text(encoding="utf-8"))
    assert saved["cookies"] == LOGGED_IN


def test_failed_login_does_not_save_session(
    market: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("ai_marketplace_monitor.facebook.time.sleep", Mock())
    page = logged_page(LOGGED_OUT)
    market.create_page, market.goto_url = Mock(return_value=page), Mock()
    market.login()
    page.wait_for_selector.assert_called()
    assert not (tmp_path / "facebook-session-facebook.json").exists()


@pytest.mark.parametrize(("cookies", "saved"), [(LOGGED_IN, True), (LOGGED_OUT, False)])
def test_search_refreshes_session_when_logged_in(
    market: Any, tmp_path: Path, cookies: list[dict[str, str]], saved: bool
) -> None:
    market.page = logged_page(cookies)
    market._search_listings = Mock(return_value=iter(["listing"]))
    assert list(market.search(Mock())) == ["listing"]
    assert (tmp_path / "facebook-session-facebook.json").exists() is saved


def test_search_refreshes_session_when_stopped_early(market: Any, tmp_path: Path) -> None:
    market.page = logged_page(LOGGED_IN)
    market._search_listings = Mock(return_value=iter(["first", "second"]))
    results = market.search(Mock())
    next(results)
    results.close()
    assert (tmp_path / "facebook-session-facebook.json").exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes")
def test_saved_session_is_readable_only_by_owner(market: Any, tmp_path: Path) -> None:
    market.page = logged_page(LOGGED_IN)
    market.save_session()
    mode = (tmp_path / "facebook-session-facebook.json").stat().st_mode
    assert stat.S_IMODE(mode) == 0o600


def test_failed_save_keeps_previous_session_and_leaves_no_temp_file(
    market: Any, tmp_path: Path
) -> None:
    session_file = tmp_path / "facebook-session-facebook.json"
    session_file.write_text('{"cookies": []}', encoding="utf-8")
    market.page = Mock()
    market.page.context.storage_state.side_effect = RuntimeError("browser closed")
    market.save_session()
    assert session_file.read_text(encoding="utf-8") == '{"cookies": []}'
    assert list(tmp_path.iterdir()) == [session_file]
