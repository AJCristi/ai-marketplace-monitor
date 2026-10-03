"""Mask scalar TOML secrets while preserving formatting on restoration.

Quoted keys, escaped quotes and multiline strings are supported. Secret
containers fail closed rather than exposing credentials to the browser.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any, Dict, Iterator, Tuple

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    import tomli as tomllib

MASK = "<REDACTED>"
_SENSITIVE_SUBSTRINGS = ("password", "token", "api_key", "secret")
_SENSITIVE_EXACT = {
    "username",
    "smtp_username",
    "proxy_username",
    "api_secret",
    "pushover_user_key",
}
_STRING = r'''"""(?:\\[\s\S]|(?!""")[\s\S])*"""|"(?:\\[\s\S]|[^"\\\r\n])*"|'[^'\r\n]*' '''.strip()
_STRING = r"'''[\s\S]*?'''|" + _STRING
_KEY = r"""(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')(?:[ \t]*\.[ \t]*(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*'))*"""
_TOKEN = re.compile(
    rf"(?P<header>^[ \t]*\[[^\]\n]+\][ \t]*(?:\#[^\n]*)?)"
    rf"|(?P<assignment>^[ \t]*(?P<key>{_KEY})[ \t]*=[ \t]*(?P<value>{_STRING}))"
    rf"|(?P<string>{_STRING})|(?P<comment>\#[^\n]*)",
    re.MULTILINE,
)
_ENV = re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}")
SecretMap = Dict[Tuple[str, str], str]
_SECTION_GROUPS = {"marketplace", "item", "ai", "user", "notification", "region", "translation"}


class _Secret(str):
    """Decoded value with its original TOML literal for lossless restoration."""

    literal: str

    def __new__(cls, value: str, literal: str) -> _Secret:
        instance = super().__new__(cls, value)
        instance.literal = literal
        return instance


def _is_sensitive(key: str) -> bool:
    return key.lower() in _SENSITIVE_EXACT or any(
        word in key.lower() for word in _SENSITIVE_SUBSTRINGS
    )


def _is_section(path: tuple[str, ...], value: Any) -> bool:
    return len(path) == 2 and path[0] in _SECTION_GROUPS and isinstance(value, dict)


def _assignments(content: str) -> Iterator[tuple[re.Match[str], str, str, str]]:
    section = ""
    for match in _TOKEN.finditer(content):
        if match.group("header"):
            header = match.group("header").strip()
            try:
                node = tomllib.loads(header + "\n__webui = 0")
                parts = []
                while isinstance(node, dict) and "__webui" not in node:
                    key = next(iter(node))
                    parts.append(key)
                    node = node[key]
                section = ".".join(parts)
            except (ValueError, StopIteration):
                section = header.split("#", 1)[0][1:-1].strip()
        elif match.group("assignment"):
            try:
                node = tomllib.loads(match.group("key") + " = " + match.group("value"))
                parts = []
                while isinstance(node, dict):
                    key = next(iter(node))
                    parts.append(key)
                    node = node[key]
                yield match, ".".join(filter(None, [section, *parts[:-1]])), parts[-1], node
            except ValueError:
                if _is_sensitive(match.group("key")):
                    raise ValueError(
                        "Repair the malformed secret assignment in the source file."
                    ) from None


def _check_safe(content: str) -> None:
    try:
        parsed = tomllib.loads(content)
    except ValueError:
        # Permit repairing ordinary syntax errors, but refuse any sensitive
        # assignment the scalar scanner could not account for.
        residual = _TOKEN.sub(
            lambda match: (
                " " * len(match.group())
                if match.group("assignment") or match.group("comment")
                else match.group()
            ),
            content,
        )
        for match in re.finditer(r"([A-Za-z0-9_\-]+|\"[^\"]*\"|'[^']*')[ \t]*=", residual):
            if _is_sensitive(match.group(1).strip("\"'")):
                raise ValueError(
                    "Repair the unsupported secret assignment in the source file before opening the editor."
                ) from None
        return

    def walk(node: Any, key: str = "", path: tuple[str, ...] = ()) -> None:
        if _is_sensitive(key) and not _is_section(path, node):
            if node and node != MASK and not (isinstance(node, str) and _ENV.fullmatch(node)):
                raise ValueError(
                    "A secret uses an unsupported TOML container. Move it to a scalar assignment in the source file."
                )
        elif isinstance(node, dict):
            for child_key, child in node.items():
                walk(child, child_key, (*path, child_key))
        elif isinstance(node, list):
            for child in node:
                walk(child, path=path)

    walk(parsed)


def redact(content: str) -> Tuple[str, SecretMap]:
    """Return masked TOML and the map needed to restore untouched masks."""
    secrets: SecretMap = {}
    replacements = []
    for match, section, key, value in _assignments(content):
        if _is_sensitive(key) and value and value != MASK and not _ENV.fullmatch(value):
            secrets[(section, key)] = _Secret(value, match.group("value"))
            quote = "'" if match.group("value").startswith("'") else '"'
            replacements.append((match.start("value"), match.end("value"), quote + MASK + quote))
    for start, end, value in reversed(replacements):
        content = content[:start] + value + content[end:]
    _check_safe(content)
    return content, secrets


def restore(content: str, secrets: SecretMap) -> str:
    """Restore known masks, leaving deliberately replaced values unchanged."""
    replacements = []
    for match, section, key, value in _assignments(content):
        real = secrets.get((section, key))
        if value == MASK and real is not None:
            literal = real.literal if isinstance(real, _Secret) else json.dumps(real)
            replacements.append((match.start("value"), match.end("value"), literal))
    for start, end, value in reversed(replacements):
        content = content[:start] + value + content[end:]
    return content


def has_mask(content: str) -> bool:
    return f'"{MASK}"' in content or f"'{MASK}'" in content
