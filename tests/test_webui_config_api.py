"""Tests for ConfigFileService: validation rollback, atomic write, mtime conflict."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from ai_marketplace_monitor.webui.config_api import ConfigFileService

SAMPLE_CONFIG = """
[marketplace.facebook]
username = "user@example.com"
search_city = "houston"

[item.iphone]
search_phrases = "iphone 13 pro"

[user.me]
pushbullet_token = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
"""


@pytest.fixture
def config_file(tmp_path: Path) -> Path:
    f = tmp_path / "config.toml"
    f.write_text(SAMPLE_CONFIG, encoding="utf-8")
    return f


def test_list_files_returns_editable(config_file: Path) -> None:
    svc = ConfigFileService([config_file])
    files = svc.list_files()
    assert len(files) == 1
    assert files[0].id == "primary"
    assert Path(files[0].path) == config_file


def test_read_returns_content_and_mtime(config_file: Path) -> None:
    svc = ConfigFileService([config_file])
    content, mtime = svc.read("primary")
    assert "[item.iphone]" in content
    assert mtime > 0


def test_read_unknown_id_raises(config_file: Path) -> None:
    svc = ConfigFileService([config_file])
    with pytest.raises(KeyError):
        svc.read("other")


def test_validate_rejects_garbage_toml(config_file: Path) -> None:
    svc = ConfigFileService([config_file])
    ok, error = svc.validate("this is not = = toml")
    assert ok is False
    assert error is not None


def test_write_rejects_invalid_and_leaves_file_untouched(config_file: Path) -> None:
    svc = ConfigFileService([config_file])
    original = config_file.read_text(encoding="utf-8")
    _, ok, error = svc.write("primary", "not = = toml", base_mtime=None)
    assert ok is False
    assert error is not None
    assert config_file.read_text(encoding="utf-8") == original


def test_write_mtime_conflict(config_file: Path) -> None:
    svc = ConfigFileService([config_file])
    _, stale = svc.read("primary")
    # Simulate an external edit.
    time.sleep(0.05)
    config_file.write_text(SAMPLE_CONFIG + "\n# external edit\n", encoding="utf-8")
    _, ok, error = svc.write("primary", SAMPLE_CONFIG, base_mtime=stale)
    assert ok is False
    assert error and "conflict" in error


def test_validate_accepts_incomplete_template(config_file: Path) -> None:
    """Validate the default first-run template without raising.

    The default template seeded on first run contains no real
    credentials. It's intentionally invalid until the user fills it in.
    Validation should return the error clearly rather than raising.
    """
    from ai_marketplace_monitor.cli import _DEFAULT_CONFIG_TEMPLATE

    svc = ConfigFileService([config_file])
    ok, error = svc.validate(_DEFAULT_CONFIG_TEMPLATE)
    # Template is intentionally minimal — we don't assert valid/invalid
    # (that depends on schema), but the call must not raise.
    assert isinstance(ok, bool)
    if not ok:
        assert error


def test_write_success_updates_file(config_file: Path) -> None:
    svc = ConfigFileService([config_file])
    _, mtime = svc.read("primary")
    # SAMPLE_CONFIG has a username so read() returns redacted content.
    # Start from the redacted version to mimic what the browser sends.
    redacted, _ = svc.read("primary")
    new_redacted = redacted + '\n[item.ipad]\nsearch_phrases = "ipad pro"\n'
    new_mtime, ok, error = svc.write("primary", new_redacted, base_mtime=mtime)
    assert ok, error
    on_disk = config_file.read_text(encoding="utf-8")
    assert "[item.ipad]" in on_disk
    # Original secret must still be on disk (round-tripped, not masked).
    assert "user@example.com" in on_disk
    assert new_mtime >= mtime


def test_read_returns_redacted_content(config_file: Path) -> None:
    svc = ConfigFileService([config_file])
    content, _ = svc.read("primary")
    # SAMPLE_CONFIG has username = "user@example.com" which is sensitive.
    assert "user@example.com" not in content
    assert "<REDACTED>" in content


def test_write_rejects_invalid_after_restore(config_file: Path) -> None:
    """Unchanged redacted content round-trips cleanly after restore.

    Masks must be restored before validation, so a user saving just
    the mask shouldn't accidentally write garbage.
    """
    svc = ConfigFileService([config_file])
    _, mtime = svc.read("primary")
    redacted, _ = svc.read("primary")
    # Unchanged redacted content must still validate and round-trip cleanly.
    _new_mtime, ok, error = svc.write("primary", redacted, base_mtime=mtime)
    assert ok, error
    on_disk = config_file.read_text(encoding="utf-8")
    assert "user@example.com" in on_disk


def test_write_new_secret_over_mask(config_file: Path) -> None:
    svc = ConfigFileService([config_file])
    _, mtime = svc.read("primary")
    redacted, _ = svc.read("primary")
    # User types a new username over the mask.
    edited = redacted.replace('"<REDACTED>"', '"new-user@example.com"', 1)
    _new_mtime, ok, error = svc.write("primary", edited, base_mtime=mtime)
    assert ok, error
    on_disk = config_file.read_text(encoding="utf-8")
    assert "new-user@example.com" in on_disk
    assert "user@example.com" not in on_disk.replace("new-user@example.com", "")


def test_context_includes_inherited_sections_without_exposing_secrets(
    config_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    inherited = config_file.with_name("shared.toml")
    inherited.write_text(
        '[marketplace.facebook]\nsearch_city = "austin"\n[ai.local]\nprovider = "ollama"\nbase_url = "http://localhost:11434/v1"\nmodel = "demo"\n[user.shared]\npushover_user_key = "private-user-key"\npushover_api_token = "private-api-token"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("REVIEW_TOKEN", "private-environment-value")
    config_file.write_text(
        SAMPLE_CONFIG
        + '\n[user.env]\ntelegram_token = "${REVIEW_TOKEN}"\ntelegram_chat_id = "123"\n',
        encoding="utf-8",
    )
    context = ConfigFileService([inherited, config_file]).context()
    assert context["effective"]["marketplace"]["facebook"]["search_city"] == "houston"
    assert context["inherited"]["marketplace"]["facebook"]["search_city"] == "austin"
    assert context["effective"]["user"]["shared"]["pushover_user_key"] == "<REDACTED>"
    assert context["effective"]["user"]["env"]["telegram_token"] == "${REVIEW_TOKEN}"
    assert context["environment"] == {"REVIEW_TOKEN": True}
    assert not any(
        value in str(context)
        for value in ("private-user-key", "private-api-token", "private-environment-value")
    )
    assert context["sources"][-1]["editable"] is True
    assert all(not source["editable"] for source in context["sources"][:-1])


def test_rename_restores_hidden_secrets_at_new_section(config_file: Path) -> None:
    service = ConfigFileService([config_file])
    content, mtime = service.read("primary")
    renamed = content.replace("[user.me]", "[user.renamed]")
    _, ok, error = service.write("primary", renamed, mtime, renames={"user.me": "user.renamed"})
    assert ok, error
    written = config_file.read_text(encoding="utf-8")
    assert "[user.renamed]" in written
    assert "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" in written
    assert "<REDACTED>" not in written


def test_unknown_mask_is_rejected_without_changing_file(config_file: Path) -> None:
    service = ConfigFileService([config_file])
    content, mtime = service.read("primary")
    draft = content.replace("[user.me]", "[user.renamed]")
    _, ok, error = service.write("primary", draft, mtime)
    assert not ok
    assert error and "cannot be restored" in error
    assert config_file.read_text(encoding="utf-8") == SAMPLE_CONFIG


def test_inherited_secret_can_be_preserved_in_editable_override(config_file: Path) -> None:
    shared = config_file.with_name("shared.toml")
    shared.write_text('[user.me]\nsmtp_password = "shared-password"\n', encoding="utf-8")
    service = ConfigFileService([shared, config_file])
    content, mtime = service.read("primary")
    draft = content + 'smtp_password = "<REDACTED>"\n'
    _, ok, error = service.write("primary", draft, mtime)
    assert ok, error
    assert 'smtp_password = "shared-password"' in config_file.read_text(encoding="utf-8")


def test_context_reports_normalized_notification_defaults_without_secrets(
    config_file: Path,
) -> None:
    config_file.write_text(
        SAMPLE_CONFIG
        + '\n[notification.shared]\nsmtp_password = "shared-private"\nsmtp_server = "smtp.example.com"\n',
        encoding="utf-8",
    )
    context = ConfigFileService([config_file]).context()
    values = context["notification_values"]["shared"]
    assert values["smtp_password"] == "<REDACTED>"
    assert values["retry_delay"] == 60
    assert values["max_retries"] == 5
    assert values["smtp_server"] == "smtp.example.com"
    assert "shared-private" not in str(context)


def test_context_masks_sensitive_containers_even_when_loader_rejects_them(
    config_file: Path,
) -> None:
    config_file.write_text(
        SAMPLE_CONFIG
        + '\n[ai.custom]\nprovider = "openai"\napi_key = {value = "private-container-value"}\n',
        encoding="utf-8",
    )
    context = ConfigFileService([config_file]).context()
    assert context["effective"]["ai"]["custom"]["api_key"] == "<REDACTED>"
    assert "private-container-value" not in str(context)


def test_context_preserves_secret_like_section_names(config_file: Path) -> None:
    config_file.write_text(SAMPLE_CONFIG.replace("[user.me]", "[user.my_token]"), encoding="utf-8")
    context = ConfigFileService([config_file]).context()
    assert context["effective"]["user"]["my_token"]["pushbullet_token"] == "<REDACTED>"
    assert "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" not in str(context)
