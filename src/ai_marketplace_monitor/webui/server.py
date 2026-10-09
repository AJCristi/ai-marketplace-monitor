"""FastAPI app factory and uvicorn-in-a-thread runner.

The monitor process stays fully synchronous. Uvicorn runs on its own
asyncio loop in a daemon thread; the LogBroadcastHandler bridges records
from the main thread to that loop via ``loop.call_soon_threadsafe``.
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import re
import secrets
import socket
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Callable, Dict, List, Literal

import uvicorn
from fastapi import (
    Cookie,
    Depends,
    FastAPI,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .. import __version__
from ..image_matching import ImageMatcher
from ..listing import Listing
from ..match_store import source_hash
from ..matches import (
    library,
    load_matches,
    query_matches,
    reading_library,
    record_manual_listing,
    update_state,
)
from ..photos import THUMBNAIL_CACHE_SIZE, thumbnail_webp
from ..recheck import RecheckQueue, facebook_listing_id
from ..utils import cache
from .auth import (
    CSRF_COOKIE,
    CSRF_HEADER,
    SESSION_COOKIE,
    SESSION_TTL,
    AuthConfig,
    RateLimiter,
    SessionManager,
    hash_password,
    verify_password,
)
from .config_api import ConfigFileService
from .config_auth import extract_credentials
from .found_export import iter_found_csv, iter_found_rows, iter_match_rows
from .log_handler import LogBroadcastHandler

# Ensure the vendored toml-edit-js WASM bundle is served with the right
# Content-Type. Python's mimetypes module learned .wasm in 3.10 but
# explicit registration is safer across patch versions.
mimetypes.add_type("application/wasm", ".wasm")

STATIC_DIR = Path(__file__).parent / "static"


def _build_info() -> dict[str, Any]:
    """Capture the server's starting revision, never a later checkout's HEAD."""
    revision = os.environ.get("AIMM_BUILD_SHA", "").strip()
    dirty = False
    root = Path(__file__).resolve().parents[3]
    if not revision and (root / ".git").exists():
        try:
            revision = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=root,
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=2,
            ).strip()
            dirty = bool(
                subprocess.check_output(
                    ["git", "status", "--porcelain", "--", "src/ai_marketplace_monitor"],
                    cwd=root,
                    text=True,
                    stderr=subprocess.DEVNULL,
                    timeout=2,
                ).strip()
            )
        except (OSError, subprocess.SubprocessError):
            revision = ""
    return {
        "version": __version__,
        "sha": (
            revision.lower()
            if re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", revision)
            else None
        ),
        "dirty": dirty,
    }


@dataclass
class WebUIConfig:
    host: str = "127.0.0.1"
    port: int = 8467
    config_files: List[Path] = field(default_factory=list)
    log_handler: LogBroadcastHandler | None = None
    request_search: Callable[[], None] | None = None
    cancel_search: Callable[[], None] | None = None
    search_progress: Callable[[], Dict[str, Any]] | None = None
    rechecks: RecheckQueue | None = None
    image_matcher: ImageMatcher | None = None


@dataclass
class MatchFilters:
    item: str | None = None
    source: str | None = Query(default=None, pattern="^manual$")
    min_score: int | None = Query(default=None, ge=1, le=5)
    status: str = Query(default="all", pattern="^(all|new|shortlisted|contacted|dismissed)$")
    include_dismissed: bool = False
    price_drop: bool = False
    q: str = Query(default="", max_length=500)
    sort: str = Query(default="newest", pattern="^(newest|last_seen|price|score)$")
    since: datetime | None = None


@dataclass
class StartupInfo:
    """Information about the running server, shown in the startup banner."""

    urls: List[str]
    username: str | None  # None in open mode
    host: str
    port: int
    exposed: bool


class AuthState:
    """Mutable auth state.

    On loopback or in explicitly local-only Docker mode the web UI is
    open — no password required. When ``--webui-host`` exposes the server on a
    non-loopback interface, ``auth`` must be set (credentials from
    a marketplace config section or environment variables).
    """

    def __init__(self) -> None:
        self.auth: AuthConfig | None = None
        self.exposed: bool = False


def _resolve_auth(config: WebUIConfig) -> tuple[AuthState, StartupInfo]:
    """Build initial AuthState from config files and environment.

    On loopback the UI is always open.  When exposed (--webui-host),
    credentials are required — checked from ``[marketplace.*]`` config
    sections, then ``FACEBOOK_USERNAME`` / ``FACEBOOK_PASSWORD`` env
    vars. ``AIMM_WEBUI_LOCAL_ONLY=1`` opts into open mode behind a
    Docker port published exclusively to loopback.
    """
    local_only = os.environ.get("AIMM_WEBUI_LOCAL_ONLY") == "1"
    exposed = config.host not in ("127.0.0.1", "localhost", "::1") and not local_only
    state = AuthState()
    state.exposed = exposed

    if exposed:
        extracted = extract_credentials(config.config_files)
        if extracted.username and extracted.password:
            state.auth = AuthConfig(
                username=extracted.username,
                password_hash=hash_password(extracted.password),
                secret_key=secrets.token_urlsafe(32),
            )
        # If exposed with no credentials, start_webui() will reject this.

    info = StartupInfo(
        urls=_enumerate_urls("127.0.0.1" if local_only else config.host, config.port),
        username=state.auth.username if state.auth else None,
        host=config.host,
        port=config.port,
        exposed=exposed,
    )
    return state, info


def _set_session_cookies(response: Response, token: str, csrf: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_TTL,
        httponly=True,
        samesite="strict",
    )
    response.set_cookie(
        CSRF_COOKIE,
        csrf,
        max_age=SESSION_TTL,
        httponly=False,  # JS reads this to echo via header
        samesite="strict",
    )


def _enumerate_urls(host: str, port: int) -> List[str]:
    if host in ("127.0.0.1", "localhost", "::1"):
        return [f"http://127.0.0.1:{port}"]
    if host in ("0.0.0.0", "::"):  # noqa: S104 — intentional bind-all
        # Enumerate local interface addresses so the user sees every reachable URL.
        urls = [f"http://127.0.0.1:{port}"]
        try:
            hostname = socket.gethostname()
            for info in socket.getaddrinfo(hostname, None):
                addr = str(info[4][0])
                if addr and addr not in ("127.0.0.1", "::1"):
                    if ":" in addr:
                        urls.append(f"http://[{addr}]:{port}")
                    else:
                        urls.append(f"http://{addr}:{port}")
        except socket.gaierror:
            pass
        return list(dict.fromkeys(urls))
    return [f"http://{host}:{port}"]


def create_app(
    config: WebUIConfig,
    state: AuthState,
    config_service: ConfigFileService,
    log_handler: LogBroadcastHandler,
) -> FastAPI:
    build = _build_info()
    app = FastAPI(
        title="AI Marketplace Monitor",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    process_secret = secrets.token_urlsafe(32)
    sessions = SessionManager(process_secret)
    rate_limiter = RateLimiter()

    def is_open() -> bool:
        """True when local-only access needs no password."""
        return not state.exposed

    def require_session(
        request: Request,
        session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    ) -> str:
        if is_open():
            return "anonymous"
        if session is None:
            raise HTTPException(status_code=401, detail="Not authenticated")
        username = sessions.validate(session)
        if username is None:
            raise HTTPException(status_code=401, detail="Session expired")
        return username

    def require_csrf(
        request: Request,
        csrf_cookie: str | None = Cookie(default=None, alias=CSRF_COOKIE),
    ) -> None:
        if is_open():
            return  # open mode skips CSRF (nothing to protect)
        header = request.headers.get(CSRF_HEADER)
        if not header or not csrf_cookie or not secrets.compare_digest(header, csrf_cookie):
            raise HTTPException(status_code=403, detail="CSRF token mismatch")

    # ------------------------------------------------------------------
    # Routes
    # ------------------------------------------------------------------

    @app.get("/api/auth/info")
    async def auth_info() -> Dict[str, Any]:
        """Return auth mode info for the frontend login screen."""
        return {
            "open": is_open(),
            "username_hint": state.auth.username if state.auth else None,
        }

    @app.post("/api/login")
    async def login(
        request: Request,
        response: Response,
        username: str = Form(""),
        password: str = Form(""),
    ) -> Dict[str, Any]:
        # Loopback — always open, no password needed.
        if is_open():
            token, csrf = sessions.issue("anonymous")
            _set_session_cookies(response, token, csrf)
            return {"username": "anonymous", "csrf": csrf}

        # Exposed — credentials required.
        client_ip = request.client.host if request.client else "unknown"
        if rate_limiter.is_locked(client_ip):
            raise HTTPException(status_code=429, detail="Too many failed attempts")

        assert state.auth is not None  # enforced by start_webui()
        if username != state.auth.username or not verify_password(
            password, state.auth.password_hash
        ):
            rate_limiter.record_failure(client_ip)
            raise HTTPException(status_code=401, detail="Invalid credentials")

        rate_limiter.reset(client_ip)
        token, csrf = sessions.issue(username)
        _set_session_cookies(response, token, csrf)
        return {"username": username, "csrf": csrf}

    @app.post("/api/logout")
    async def logout(response: Response) -> Dict[str, Any]:
        response.delete_cookie(SESSION_COOKIE)
        response.delete_cookie(CSRF_COOKIE)
        return {"ok": True}

    @app.get("/api/status")
    async def status(_: str = Depends(require_session)) -> Dict[str, Any]:
        return {
            "build": build,
            "open": is_open(),
            "vnc_enabled": os.environ.get("AIMM_ENABLE_VNC") == "1"
            and Path(os.environ.get("AIMM_NOVNC_DIR", "/usr/share/novnc")).is_dir(),
        }

    @app.get("/api/config/files")
    async def list_config_files(_: str = Depends(require_session)) -> Dict[str, Any]:
        return {"files": [f.__dict__ for f in config_service.list_files()]}

    @app.get("/api/config/context")
    async def config_context(_: str = Depends(require_session)) -> Dict[str, Any]:
        try:
            return config_service.context()
        except (OSError, ValueError) as e:
            raise HTTPException(status_code=400, detail=str(e)) from None

    @app.get("/api/config/file/{file_id}")
    async def get_config_file(file_id: str, _: str = Depends(require_session)) -> Dict[str, Any]:
        try:
            content, mtime = config_service.read(file_id)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from None
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from None
        return {"content": content, "mtime": mtime}

    @app.put("/api/config/file/{file_id}", response_model=None)
    async def put_config_file(
        file_id: str,
        body: Dict[str, Any],
        _: str = Depends(require_session),
        __: None = Depends(require_csrf),
    ) -> Dict[str, Any]:
        content = body.get("content")
        if not isinstance(content, str):
            raise HTTPException(status_code=400, detail="Missing 'content' field")
        base_mtime = body.get("base_mtime")
        try:
            new_mtime, ok, error = config_service.write(
                file_id,
                content,
                base_mtime if isinstance(base_mtime, (int, float)) else None,
                renames=body.get("renames"),
            )
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e)) from None
        if not ok:
            status_code = 409 if error and "conflict" in error else 400
            return JSONResponse(  # type: ignore[return-value]
                status_code=status_code,
                content={"ok": False, "error": error, "mtime": new_mtime},
            )
        return {"ok": True, "mtime": new_mtime}

    @app.post("/api/config/validate")
    async def validate_config(
        body: Dict[str, Any],
        _: str = Depends(require_session),
        __: None = Depends(require_csrf),
    ) -> Dict[str, Any]:
        content = body.get("content")
        if not isinstance(content, str):
            raise HTTPException(status_code=400, detail="Missing 'content' field")
        ok, error = config_service.validate(content, renames=body.get("renames"))
        return {"valid": ok, "error": error}

    @app.post("/api/monitor/restart")
    async def restart_monitor(
        _: str = Depends(require_session),
        __: None = Depends(require_csrf),
    ) -> Dict[str, Any]:
        """Wake the monitor by touching the config file.

        The file watcher interrupts the monitor's doze() sleep, causing
        it to reload the config and run all scheduled searches immediately.
        """
        try:
            if config.request_search is not None:
                config.request_search()
            path = config_service.editable_path
            path.touch()
            return {
                "ok": True,
                "message": "Search requested — all enabled searches run after the current scan.",
            }
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to touch config: {e}") from e

    @app.get("/api/monitor/progress")
    async def search_progress(_: str = Depends(require_session)) -> Dict[str, Any]:
        return config.search_progress() if config.search_progress is not None else {}

    @app.post("/api/monitor/search/cancel")
    async def cancel_search(
        _: str = Depends(require_session),
        __: None = Depends(require_csrf),
    ) -> Dict[str, Any]:
        if config.cancel_search is None:
            raise HTTPException(status_code=503, detail="The monitor is not running")
        config.cancel_search()
        return {
            "ok": True,
            "message": "Cancelling — the current listing finishes first. Remaining searches return to their schedule.",
        }

    @app.get("/api/logs")
    async def get_logs(
        limit: int = 500,
        level: str = "DEBUG",
        kind: str | None = None,
        item: str | None = None,
        min_score: int | None = None,
        _: str = Depends(require_session),
    ) -> Dict[str, Any]:
        level_value = logging.getLevelName(level.upper())
        if not isinstance(level_value, int):
            level_value = 0
        return {
            "records": log_handler.snapshot(
                limit=limit,
                min_level=level_value,
                kind=kind,
                item=item,
                min_score=min_score,
            ),
            "capacity": log_handler._buffer.maxlen,
            "stream_id": log_handler.stream_id,
        }

    @app.websocket("/ws/stream")
    async def ws_stream(websocket: WebSocket) -> None:
        # In open mode (loopback) skip cookie check; otherwise require
        # a valid session cookie on the WebSocket handshake.
        if not is_open():
            session = websocket.cookies.get(SESSION_COOKIE)
            if not session or sessions.validate(session) is None:
                await websocket.close(code=4401)
                return

        await websocket.accept()
        queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue(maxsize=1000)
        log_handler.subscribe(queue)
        try:
            # Send a brief hello so clients know the stream is live.
            await websocket.send_json(
                {"type": "hello", "time": time.time(), "stream_id": log_handler.stream_id}
            )
            while True:
                payload = await queue.get()
                await websocket.send_json({"type": "log", "record": payload})
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: S110 — client disconnected; nothing to handle
            pass
        finally:
            log_handler.unsubscribe(queue)

    # ------------------------------------------------------------------
    # Optional noVNC bridge (Docker deployments)
    # ------------------------------------------------------------------
    novnc_dir = os.environ.get("AIMM_NOVNC_DIR", "/usr/share/novnc")
    vnc_host = os.environ.get("AIMM_VNC_HOST", "127.0.0.1")
    vnc_port = int(os.environ.get("AIMM_VNC_PORT", "5900"))
    if os.environ.get("AIMM_ENABLE_VNC") == "1" and Path(novnc_dir).is_dir():
        app.mount("/vnc", StaticFiles(directory=novnc_dir, html=True), name="vnc")

        @app.websocket("/ws/vnc")
        async def ws_vnc(websocket: WebSocket) -> None:
            if not is_open():
                session = websocket.cookies.get(SESSION_COOKIE)
                if not session or sessions.validate(session) is None:
                    await websocket.close(code=4401)
                    return
            # noVNC 1.3 requests no subprotocol; browsers reject an unrequested one.
            requested = websocket.scope.get("subprotocols") or []
            await websocket.accept(subprotocol="binary" if "binary" in requested else None)
            try:
                reader, writer = await asyncio.open_connection(vnc_host, vnc_port)
            except OSError:
                await websocket.close(code=1011)
                return

            async def ws_to_tcp() -> None:
                try:
                    while True:
                        data = await websocket.receive_bytes()
                        writer.write(data)
                        await writer.drain()
                except WebSocketDisconnect:
                    pass
                finally:
                    writer.close()

            async def tcp_to_ws() -> None:
                try:
                    while True:
                        chunk = await reader.read(65536)
                        if not chunk:
                            break
                        await websocket.send_bytes(chunk)
                finally:
                    try:
                        await websocket.close()
                    except Exception:  # noqa: S110 — already closed
                        pass

            await asyncio.gather(ws_to_tcp(), tcp_to_ws(), return_exceptions=True)

    # ------------------------------------------------------------------
    # Static UI
    # ------------------------------------------------------------------
    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

        @app.get("/")
        async def index() -> FileResponse:
            return FileResponse(STATIC_DIR / "index.html")

    # Sync def (not async): FastAPI runs it in a threadpool and Starlette
    # iterates the sync generator there too, so the blocking cache scan never
    # runs on the event loop. The body streams row-by-row rather than buffering
    # the whole CSV, keeping memory bounded for large exports.
    @app.get("/api/matches")
    def get_matches(
        filters: Annotated[MatchFilters, Depends()],
        limit: int = Query(default=200, ge=1, le=1000),
        cursor: int = Query(default=0, ge=0),
        _: str = Depends(require_session),
    ) -> Dict[str, Any]:
        result = query_matches(cache, **vars(filters), limit=limit, cursor=cursor)
        if config.image_matcher:
            for row in result["matches"]:
                row["related_count"] = sum(
                    pair["review"] != "dismissed" for pair in config.image_matcher.related(row)
                )
        return result

    def require_match(marketplace: str, listing_id: str) -> list[dict[str, Any]]:
        rows = load_matches(cache, marketplace, listing_id)
        if not rows:
            raise HTTPException(status_code=404, detail="Match not found")
        return rows

    @app.get("/api/matches/{marketplace}/{listing_id}/detail")
    def match_detail(
        marketplace: str,
        listing_id: str,
        item: str,
        _: str = Depends(require_session),
    ) -> Dict[str, Any]:
        row = next(
            (row for row in require_match(marketplace, listing_id) if row["item"] == item), None
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Match not found for this search")
        return row

    def read_photo(marketplace: str, listing_id: str, digest: str) -> bytes:
        with reading_library(cache) as store:
            photo = store.db.execute(
                "SELECT data FROM photos WHERE marketplace=? AND listing_id=? AND digest=?",
                (marketplace, listing_id, digest),
            ).fetchone()
        if photo is None:
            raise HTTPException(status_code=404, detail="Photo not found")
        return photo[0]

    # Saved photos are never deleted or changed, so a thumbnail stays valid for its digest.
    # A missing photo raises, and lru_cache does not cache exceptions.
    @lru_cache(maxsize=THUMBNAIL_CACHE_SIZE)
    def photo_thumbnail(marketplace: str, listing_id: str, digest: str) -> bytes:
        photo = read_photo(marketplace, listing_id, digest)
        try:
            return thumbnail_webp(photo)
        except ValueError:
            return photo

    @app.get("/api/matches/{marketplace}/{listing_id}/photos/{digest}.webp")
    def match_photo(
        marketplace: str,
        listing_id: str,
        digest: str,
        request: Request,
        size: Literal["full", "thumb"] = "full",
        _: str = Depends(require_session),
    ) -> Response:
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise HTTPException(status_code=404, detail="Photo not found")
        photo = (
            photo_thumbnail(marketplace, listing_id, digest)
            if size == "thumb"
            else read_photo(marketplace, listing_id, digest)
        )
        headers = {
            "ETag": f'"{digest}-thumb"' if size == "thumb" else f'"{digest}"',
            # Exposed consoles revalidate so photos are not readable from the cache after logout.
            "Cache-Control": (
                "private, no-cache" if state.exposed else "private, max-age=31536000, immutable"
            ),
            "X-Content-Type-Options": "nosniff",
        }
        if request.headers.get("if-none-match") == headers["ETag"]:
            return Response(status_code=304, headers=headers)
        return Response(content=photo, media_type="image/webp", headers=headers)

    @app.get("/api/matches/{marketplace}/{listing_id}/history")
    def match_history(
        marketplace: str,
        listing_id: str,
        cursor: int = Query(default=0, ge=0),
        limit: int = Query(default=25, ge=1, le=100),
        _: str = Depends(require_session),
    ) -> Dict[str, Any]:
        require_match(marketplace, listing_id)
        with library(cache) as store:
            return store.history(marketplace, listing_id, cursor, limit)

    @app.put("/api/matches/{marketplace}/{listing_id}/state")
    def put_match_state(
        marketplace: str,
        listing_id: str,
        body: Dict[str, Any],
        _: str = Depends(require_session),
        __: None = Depends(require_csrf),
    ) -> Dict[str, Any]:
        require_match(marketplace, listing_id)
        try:
            return update_state(cache, marketplace, listing_id, body)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from None

    def image_matcher() -> ImageMatcher:
        if config.image_matcher is None:
            raise HTTPException(
                status_code=503, detail="The monitor is not available for image matching"
            )
        return config.image_matcher

    @app.get("/api/matches/{marketplace}/{listing_id}/related")
    def get_related(
        marketplace: str, listing_id: str, _: str = Depends(require_session)
    ) -> Dict[str, Any]:
        row = require_match(marketplace, listing_id)[0]
        result = image_matcher().status(row)
        with library(cache) as store:
            for pair in result.get("related", []):
                for key in ("source", "other"):
                    snapshot = pair.get(key, {})
                    photo = store.db.execute(
                        "SELECT digest FROM photo_sources WHERE marketplace=? AND listing_id=? AND source_hash=?",
                        (
                            snapshot.get("marketplace"),
                            snapshot.get("listing_id"),
                            source_hash(snapshot.get("image") or ""),
                        ),
                    ).fetchone()
                    pair[key] = {**snapshot, "photos": [{"digest": photo[0]}] if photo else []}
        return result

    @app.post("/api/matches/{marketplace}/{listing_id}/related")
    def find_related(
        marketplace: str,
        listing_id: str,
        body: Dict[str, Any],
        _: str = Depends(require_session),
        __: None = Depends(require_csrf),
    ) -> Dict[str, Any]:
        row = require_match(marketplace, listing_id)[0]
        if body.keys() - {"refresh"} or type(body.get("refresh", False)) is not bool:
            raise HTTPException(status_code=400, detail="refresh must be a boolean")
        try:
            return image_matcher().enqueue(row, refresh=body.get("refresh", False))
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from None

    @app.put("/api/matches/{marketplace}/{listing_id}/related/{pair_id}")
    def review_related(
        marketplace: str,
        listing_id: str,
        pair_id: str,
        body: Dict[str, Any],
        _: str = Depends(require_session),
        __: None = Depends(require_csrf),
    ) -> Dict[str, Any]:
        row = require_match(marketplace, listing_id)[0]
        if set(body) != {"review"} or not isinstance(body["review"], str):
            raise HTTPException(status_code=400, detail="Supply a review state")
        try:
            image_matcher().review(row, pair_id, body["review"])
            return image_matcher().status(row)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from None

    def recheck_queue() -> RecheckQueue:
        if config.rechecks is None:
            raise HTTPException(
                status_code=503, detail="The monitor is not available for re-checks"
            )
        return config.rechecks

    @app.post("/api/matches/recheck")
    def enqueue_recheck(
        body: Dict[str, Any], _: str = Depends(require_session), __: None = Depends(require_csrf)
    ) -> Dict[str, Any]:
        queue = recheck_queue()
        listings, item, refresh = body.get("listings"), body.get("item"), body.get("refresh", True)
        if (
            not isinstance(listings, list)
            or not 1 <= len(listings) <= 25
            or type(refresh) is not bool
            or (item is not None and (not isinstance(item, str) or not item or len(item) > 200))
        ):
            raise HTTPException(
                status_code=400,
                detail="Supply 1-25 listings, an optional search name, and a boolean refresh",
            )
        searches_by_listing: dict[tuple[str, str], set[str]] = {}
        for row in load_matches(cache):
            searches_by_listing.setdefault((row["marketplace"], row["listing_id"]), set()).add(
                row["item"]
            )
        validated = []
        for entry in listings:
            if (
                not isinstance(entry, dict)
                or not isinstance(entry.get("marketplace"), str)
                or not isinstance(entry.get("listing_id"), str)
                or not re.fullmatch(r"[0-9]{1,40}", entry["listing_id"])
            ):
                raise HTTPException(status_code=400, detail="Invalid listing identity")
            searches = searches_by_listing.get((entry["marketplace"], entry["listing_id"]))
            if not searches:
                raise HTTPException(status_code=404, detail="Match not found")
            original_item = entry.get("original_item")
            if original_item is not None and original_item not in searches:
                raise HTTPException(status_code=400, detail="Unknown original search")
            validated.append(
                {
                    name: entry[name]
                    for name in ("marketplace", "listing_id", "original_item")
                    if name in entry
                }
            )
        try:
            return queue.enqueue(validated, item, refresh)
        except ValueError as error:
            raise HTTPException(status_code=429, detail=str(error)) from None

    @app.post("/api/matches/manual")
    def add_manual_listing(
        body: Dict[str, Any], _: str = Depends(require_session), __: None = Depends(require_csrf)
    ) -> Dict[str, Any]:
        queue = recheck_queue()
        with queue.lock:
            try:
                listing_id = facebook_listing_id(body.get("url"))
            except ValueError:
                raise HTTPException(
                    status_code=400, detail="Paste a direct Facebook Marketplace listing URL"
                ) from None
            existing = next(iter(load_matches(cache, "facebook", listing_id)), None)
            if existing is not None:
                return {"existing": True, "match": existing}
            listing = Listing(
                marketplace="facebook",
                name="",
                id=listing_id,
                title="",
                image="",
                price="",
                post_url=f"https://www.facebook.com/marketplace/item/{listing_id}/",
                location="",
                seller="",
                condition="",
                description="",
            )
            record_manual_listing(cache, listing)
            try:
                job = queue.enqueue(
                    [{"marketplace": "facebook", "listing_id": listing_id, "original_item": ""}],
                    None,
                    True,
                )
            except ValueError as error:
                record_manual_listing(cache, listing, status="error", reason=str(error))
                raise HTTPException(status_code=429, detail=str(error)) from None
            return {
                **job,
                "existing": False,
                "match": load_matches(cache, "facebook", listing_id)[0],
            }

    @app.get("/api/matches/recheck/{job_id}")
    def get_recheck(job_id: str, _: str = Depends(require_session)) -> Dict[str, Any]:
        try:
            return recheck_queue().get(job_id)
        except KeyError:
            raise HTTPException(
                status_code=404, detail="Re-check job not found; the monitor may have restarted"
            ) from None

    @app.delete("/api/matches/recheck/{job_id}")
    def stop_recheck(
        job_id: str, _: str = Depends(require_session), __: None = Depends(require_csrf)
    ) -> Dict[str, Any]:
        try:
            return recheck_queue().stop(job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Re-check job not found") from None

    @app.get("/api/matches.csv")
    def export_matches_csv(
        filters: Annotated[MatchFilters, Depends()], _: str = Depends(require_session)
    ) -> StreamingResponse:
        matches = query_matches(cache, **vars(filters), limit=None)["matches"]
        filename = f"matches-{time.strftime('%Y%m%d-%H%M%S')}.csv"
        return StreamingResponse(
            iter_found_csv(iter_match_rows(matches)),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.get("/api/found.csv")
    def export_found_csv(_: str = Depends(require_session)) -> StreamingResponse:
        filename = f"found-items-{time.strftime('%Y%m%d-%H%M%S')}.csv"
        return StreamingResponse(
            iter_found_csv(iter_found_rows(cache)),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    return app


# ----------------------------------------------------------------------
# Thread runner
# ----------------------------------------------------------------------


class WebUIServer:
    """Runs uvicorn in a background thread."""

    def __init__(
        self,
        config: WebUIConfig,
        state: AuthState,
        config_service: ConfigFileService,
    ) -> None:
        if config.log_handler is None:
            raise ValueError("WebUIConfig.log_handler is required")
        self._config = config
        self._app = create_app(config, state, config_service, config.log_handler)
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._ready = threading.Event()

    def start(self) -> None:
        uv_config = uvicorn.Config(
            self._app,
            host=self._config.host,
            port=self._config.port,
            log_level="warning",
            access_log=False,
            lifespan="off",
        )
        self._server = uvicorn.Server(uv_config)

        def runner() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            assert self._config.log_handler is not None
            self._config.log_handler.attach_loop(loop)
            self._ready.set()
            try:
                loop.run_until_complete(self._server.serve())  # type: ignore[union-attr]
            finally:
                loop.close()

        self._thread = threading.Thread(target=runner, name="aimm-webui", daemon=True)
        self._thread.start()
        # Give the loop a moment to bind so attach_loop completes before
        # any log records are emitted.
        self._ready.wait(timeout=5)

    def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True


def start_webui(
    config: WebUIConfig, logger: logging.Logger | None = None
) -> tuple[WebUIServer, StartupInfo]:
    """Resolve auth, build the service, and start the server thread."""
    state, info = _resolve_auth(config)

    # --webui-host requires credentials. Refuse to expose without auth.
    if state.exposed and state.auth is None:
        raise RuntimeError(
            f"--webui-host {config.host} requires authentication. "
            "Set username/password in a [marketplace.*] config section "
            "or set FACEBOOK_USERNAME and FACEBOOK_PASSWORD environment "
            "variables. Omit --webui-host to run on 127.0.0.1 without "
            "a password."
        )

    config_service = ConfigFileService(config.config_files, logger=logger)
    server = WebUIServer(config, state, config_service)
    server.start()
    return server, info
