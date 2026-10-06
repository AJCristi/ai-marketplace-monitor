"""Config file read/write/validate helpers for the web UI."""

from __future__ import annotations

import copy
import logging
import os
import re
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, List, Tuple

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    import tomli as tomllib

from ..config import Config
from ..utils import merge_dicts
from .config_auth import extract_credentials
from .secrets_redact import MASK, SecretMap, _is_section, _is_sensitive, redact, restore


@dataclass
class ConfigFileInfo:
    id: str
    path: str
    name: str
    mtime: float
    size: int


def _parse_fields(content: str) -> Dict[str, Dict[str, Any]]:
    """Parse TOML content into a flat mapping of section names to fields.

    Best-effort: if parsing fails (malformed TOML mid-edit), returns {}.
    """
    try:
        data = tomllib.loads(content)
    except Exception:
        return {}

    result: Dict[str, Dict[str, Any]] = {}

    def walk(prefix: str, node: Any) -> None:
        if isinstance(node, dict):
            # Decide if this dict is a "section" (has at least one non-dict
            # leaf) or purely nested dicts (like `[marketplace]` containing
            # `[marketplace.facebook]`).
            leaves = {k: v for k, v in node.items() if not isinstance(v, dict)}
            if leaves:
                result[prefix] = leaves
            for k, v in node.items():
                if isinstance(v, dict):
                    walk(f"{prefix}.{k}" if prefix else k, v)

    walk("", data)
    return result


class ConfigFileService:
    """Read/write/validate for a single editable config file.

    Designed with a list-shaped API even though only one file is editable
    today, so multi-file support can be added without changing the HTTP
    contract.
    """

    def __init__(self, config_files: List[Path], logger: logging.Logger | None = None) -> None:
        if not config_files:
            raise ValueError("At least one config file is required.")
        self._editable: Path = config_files[-1].expanduser().resolve()
        self._all: List[Path] = [p.expanduser().resolve() for p in config_files]
        self._logger = logger

    @property
    def editable_path(self) -> Path:
        return self._editable

    def list_files(self) -> List[ConfigFileInfo]:
        stat = self._editable.stat()
        return [
            ConfigFileInfo(
                id="primary",
                path=str(self._editable),
                name=self._editable.name,
                mtime=stat.st_mtime,
                size=stat.st_size,
            )
        ]

    def read(self, file_id: str) -> Tuple[str, float]:
        self._require(file_id)
        raw = self._editable.read_text(encoding="utf-8")
        redacted, _ = redact(raw)
        return redacted, self._editable.stat().st_mtime

    def context(self) -> Dict[str, Any]:
        """Return redacted source values, without expanding environment secrets."""
        system = Path(__file__).parents[1] / "config.toml"
        paths = [system, *self._all]
        configs = [tomllib.loads(path.read_text(encoding="utf-8")) for path in paths]
        environment: Dict[str, bool] = {}

        def mask(value: Any, key: str = "", path: tuple[str, ...] = ()) -> Any:
            if isinstance(value, str) and re.fullmatch(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}", value):
                environment[value[2:-1]] = bool(os.environ.get(value[2:-1]))
                return value
            if _is_sensitive(key) and value and not _is_section(path, value):
                return MASK
            if isinstance(value, dict):
                return {k: mask(v, k, (*path, k)) for k, v in value.items()}
            if isinstance(value, list):
                return [mask(v, key, path) for v in value]
            return value

        effective = mask(merge_dicts(copy.deepcopy(configs)))
        inherited = mask(merge_dicts(configs[:-1]))
        credentials = extract_credentials(self._all)
        try:
            validated = Config(self._all)
            notification_values = {}
            for name, value in validated.notification.items():
                values = {
                    key: value for key, value in asdict(value).items() if not key.startswith("_")
                }
                for key, source in effective.get("notification", {}).get(name, {}).items():
                    if isinstance(source, str) and re.fullmatch(
                        r"\$\{[A-Za-z_][A-Za-z0-9_]*\}", source
                    ):
                        values[key] = source
                notification_values[name] = mask(values)
        except Exception:
            notification_values = {}
        return {
            "notification_values": notification_values,
            "effective": effective,
            "inherited": inherited,
            "environment": environment,
            "facebook_credentials_configured": bool(credentials.username and credentials.password),
            "sources": [
                {"path": str(path), "editable": i == len(paths) - 1, "mtime": path.stat().st_mtime}
                for i, path in enumerate(paths)
            ],
        }

    def _restore_content(self, content: str, renames: Any = None) -> str:
        # Read the maps fresh: reads from other tabs must not change what a mask means.
        secrets: SecretMap = {}
        for path in self._all:
            _, values = redact(path.read_text(encoding="utf-8"))
            secrets.update(values)
        if renames is not None:
            if not isinstance(renames, dict) or not all(
                isinstance(old, str)
                and isinstance(new, str)
                and old.split(".")[0] == new.split(".")[0]
                for old, new in renames.items()
            ):
                raise ValueError("Section renames must map names within the same section type.")
            moved = {
                (renames.get(section, section), key): value
                for (section, key), value in secrets.items()
            }
            secrets.update(moved)
        restored = restore(content, secrets)
        for section, fields in _parse_fields(restored).items():
            for key, value in fields.items():
                if _is_sensitive(key) and value == MASK:
                    raise ValueError(
                        f"Hidden value for {section}.{key} cannot be restored. Replace it before saving."
                    )
        return restored

    def validate(self, content: str, renames: Any = None) -> Tuple[bool, str | None]:
        """Parse the given content using the real Config loader.

        Masks in ``content`` are first restored to their real values so we
        validate what will actually be written.
        """
        try:
            restored = self._restore_content(content, renames)
        except ValueError as error:
            return False, str(error)
        tmp_dir = self._editable.parent
        tmp = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(tmp_dir),
            prefix=f".{self._editable.name}.",
            suffix=".tmp",
            delete=False,
        )
        try:
            tmp.write(restored)
            tmp.flush()
            tmp.close()
            tmp_path = Path(tmp.name)
            files = [tmp_path if p == self._editable else p for p in self._all]
            try:
                Config(files, self._logger)
                return True, None
            except Exception as e:
                return False, str(e)
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

    def write(
        self, file_id: str, content: str, base_mtime: float | None, renames: Any = None
    ) -> Tuple[float, bool, str | None]:
        """Validate and atomically write the file.

        Returns (new_mtime, ok, error_message).
        """
        self._require(file_id)

        if base_mtime is not None:
            current = self._editable.stat().st_mtime
            # Allow a tiny epsilon for filesystems with coarse mtimes.
            if abs(current - base_mtime) > 0.001:
                return current, False, "conflict: file changed on disk"

        # Restore masks before validating and writing so round-tripped
        # "<REDACTED>" tokens become the real secret values on disk.
        try:
            restored = self._restore_content(content, renames)
        except ValueError as restore_error:
            return self._editable.stat().st_mtime, False, str(restore_error)

        ok, error = self.validate(restored)
        if not ok:
            return (
                self._editable.stat().st_mtime,
                False,
                error or "unknown validation error",
            )

        # Atomic write: temp file in same dir + os.replace.
        tmp = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=str(self._editable.parent),
            prefix=f".{self._editable.name}.",
            suffix=".tmp",
            delete=False,
        )
        try:
            tmp.write(restored)
            tmp.flush()
            os.fsync(tmp.fileno())
            tmp.close()
            os.replace(tmp.name, self._editable)
        except Exception as e:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
            return self._editable.stat().st_mtime, False, str(e)

        return self._editable.stat().st_mtime, True, None

    def _require(self, file_id: str) -> None:
        if file_id != "primary":
            raise KeyError(f"Unknown config file id: {file_id}")
