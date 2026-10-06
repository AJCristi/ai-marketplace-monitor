"""Authentication, session, and rate-limit helpers for the web UI."""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from typing import Dict, Tuple

import bcrypt
from itsdangerous import BadSignature, TimestampSigner

SESSION_COOKIE = "aimm_session"
CSRF_COOKIE = "aimm_csrf"
CSRF_HEADER = "X-CSRF-Token"
SESSION_TTL = 8 * 60 * 60  # 8 hours

_LOCKOUT_THRESHOLD = 5
_LOCKOUT_WINDOW = 60  # seconds


def hash_password(password: str) -> str:
    # bcrypt truncates at 72 bytes; reject overly long inputs at the API
    # layer rather than silently truncating, but allow generous lengths here.
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


@dataclass
class RateLimiter:
    """Simple per-IP failure counter with a rolling window."""

    failures: Dict[str, Tuple[int, float]] = field(default_factory=dict)

    def record_failure(self, ip: str) -> None:
        count, first = self.failures.get(ip, (0, time.time()))
        now = time.time()
        if now - first > _LOCKOUT_WINDOW:
            count, first = 0, now
        self.failures[ip] = (count + 1, first)

    def is_locked(self, ip: str) -> bool:
        entry = self.failures.get(ip)
        if entry is None:
            return False
        count, first = entry
        if time.time() - first > _LOCKOUT_WINDOW:
            del self.failures[ip]
            return False
        return count >= _LOCKOUT_THRESHOLD

    def reset(self, ip: str) -> None:
        self.failures.pop(ip, None)


@dataclass
class AuthConfig:
    username: str
    password_hash: str
    secret_key: str


class SessionManager:
    """Issues and validates signed session tokens stored in a cookie."""

    def __init__(self, secret_key: str) -> None:
        self._signer = TimestampSigner(secret_key)

    def issue(self, username: str) -> Tuple[str, str]:
        """Return (session_token, csrf_token)."""
        token = self._signer.sign(username.encode("utf-8")).decode("utf-8")
        csrf = secrets.token_urlsafe(32)
        return token, csrf

    def validate(self, token: str) -> str | None:
        try:
            username_bytes = self._signer.unsign(token, max_age=SESSION_TTL)
        except BadSignature:
            return None
        return username_bytes.decode("utf-8")
