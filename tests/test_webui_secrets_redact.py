"""Tests for secret redaction / restoration in config content."""

from __future__ import annotations

from ai_marketplace_monitor.webui.secrets_redact import MASK, redact, restore


def test_redact_replaces_password_and_token() -> None:
    src = """
[marketplace.facebook]
username = "ben@example.com"
password = "s3cret-pass"

[user.me]
pushbullet_token = "abc123token"
"""
    redacted, secrets = redact(src)
    assert f'"{MASK}"' in redacted
    assert "ben@example.com" not in redacted
    assert "s3cret-pass" not in redacted
    assert "abc123token" not in redacted
    assert secrets[("marketplace.facebook", "username")] == "ben@example.com"
    assert secrets[("marketplace.facebook", "password")] == "s3cret-pass"
    assert secrets[("user.me", "pushbullet_token")] == "abc123token"


def test_redact_leaves_non_sensitive_keys_alone() -> None:
    src = """
[marketplace.facebook]
search_city = "houston"
search_phrases = "gopro hero"
"""
    redacted, secrets = redact(src)
    assert redacted == src
    assert secrets == {}


def test_restore_round_trips_unchanged_masks() -> None:
    src = """
[marketplace.facebook]
password = "real-password"
"""
    redacted, secrets = redact(src)
    assert restore(redacted, secrets) == src


def test_restore_leaves_user_edits_alone() -> None:
    src = """
[marketplace.facebook]
password = "old-password"
"""
    redacted, secrets = redact(src)
    # User types a new value over the mask.
    edited = redacted.replace(f'"{MASK}"', '"new-password"')
    restored = restore(edited, secrets)
    assert "new-password" in restored
    assert "old-password" not in restored


def test_same_key_in_different_sections_no_collision() -> None:
    src = """
[user.alice]
pushbullet_token = "alice-token"

[user.bob]
pushbullet_token = "bob-token"
"""
    redacted, secrets = redact(src)
    assert secrets[("user.alice", "pushbullet_token")] == "alice-token"
    assert secrets[("user.bob", "pushbullet_token")] == "bob-token"
    restored = restore(redacted, secrets)
    assert "alice-token" in restored
    assert "bob-token" in restored


def test_redact_idempotent() -> None:
    src = '[x]\npassword = "foo"\n'
    once, secrets1 = redact(src)
    twice, _ = redact(once)
    assert once == twice
    # Second redact on already-masked content finds no new secrets.
    # But the original secret must still be available for restore.
    assert secrets1[("x", "password")] == "foo"


def test_empty_value_not_redacted() -> None:
    src = '[x]\npassword = ""\n'
    redacted, secrets = redact(src)
    assert redacted == src
    assert secrets == {}


def test_preserves_trailing_comment() -> None:
    src = '[x]\napi_key = "sk-abc"  # my key\n'
    redacted, secrets = redact(src)
    assert "# my key" in redacted
    assert "sk-abc" not in redacted
    assert restore(redacted, secrets) == src


def test_single_quoted_string_redacted() -> None:
    src = "[x]\npassword = 'quoted'\n"
    redacted, secrets = redact(src)
    assert "quoted" not in redacted
    assert MASK in redacted
    assert secrets[("x", "password")] == "quoted"
    assert restore(redacted, secrets) == src


def test_environment_references_stay_visible_and_pushover_key_is_hidden() -> None:
    source = '[user.me]\ntelegram_token = "${TELEGRAM_TOKEN}"\npushover_user_key = "private-key"\n'
    masked, secrets = redact(source)
    assert "${TELEGRAM_TOKEN}" in masked
    assert "private-key" not in masked
    assert restore(masked, secrets) == source


def test_escaped_quoted_keys_multiline_and_comment_headers_round_trip() -> None:
    source = '[user."camera_owner"] # account\n"smtp_password" = "escaped \\"quote\\" and apostrophe\'" # keep\napi_key = """line one\nline two"""\n'
    masked, secrets = redact(source)
    assert "escaped" not in masked
    assert "line one" not in masked
    assert secrets[("user.camera_owner", "smtp_password")] == 'escaped "quote" and apostrophe\''
    assert restore(masked, secrets) == source


def test_multiline_description_does_not_confuse_secret_sections() -> None:
    source = '[item.camera]\ndescription = """[user.fake]\npassword = \'description text\'\n"""\n[user.me]\npassword = "real value"\n'
    masked, secrets = redact(source)
    assert "description text" in masked
    assert "real value" not in masked
    assert set(secrets) == {("user.me", "password")}
    assert restore(masked, secrets) == source


def test_unsupported_secret_containers_fail_closed() -> None:
    import pytest

    for source in [
        '[user.me]\nsettings = {password = "private"}\n',
        '[user.me]\npassword = ["private"]\n',
    ]:
        with pytest.raises(ValueError, match="unsupported TOML container"):
            redact(source)


def test_ordinary_invalid_toml_can_be_repaired_without_secret_leak() -> None:
    source = '[user.me]\npassword = "private"\nbroken = \n'
    masked, secrets = redact(source)
    assert "private" not in masked
    assert restore(masked, secrets) == source


def test_section_names_that_contain_secret_words_are_not_secret_fields() -> None:
    source = '[user.my_token]\npushbullet_token = "synthetic-private"\n'
    masked, secrets = redact(source)
    assert "[user.my_token]" in masked
    assert "synthetic-private" not in masked
    assert restore(masked, secrets) == source
