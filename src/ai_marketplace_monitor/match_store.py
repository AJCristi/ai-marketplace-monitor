"""Durable library storage. Connections belong to one operation/thread, never Playwright."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


class MatchStore:
    def __init__(self, path: Path) -> None:
        self.db = sqlite3.connect(path, timeout=10)
        self.db.row_factory = sqlite3.Row
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1, 2):
            self.db.close()
            raise RuntimeError("The Matches library requires a newer application version")
        if version == 2:
            return
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(
            """
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS listings (
                marketplace TEXT, listing_id TEXT, data TEXT NOT NULL,
                PRIMARY KEY (marketplace, listing_id));
            CREATE TABLE IF NOT EXISTS matches (
                marketplace TEXT, listing_id TEXT, item TEXT, data TEXT NOT NULL,
                PRIMARY KEY (marketplace, listing_id, item));
            CREATE TABLE IF NOT EXISTS sightings (
                marketplace TEXT, listing_id TEXT, item TEXT, last_run TEXT NOT NULL,
                first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, count INTEGER NOT NULL,
                PRIMARY KEY (marketplace, listing_id, item));
            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY, marketplace TEXT, listing_id TEXT,
                at TEXT NOT NULL, kind TEXT NOT NULL, item TEXT, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS history_listing ON history(marketplace, listing_id, id);
            CREATE TABLE IF NOT EXISTS photos (
                marketplace TEXT, listing_id TEXT, digest TEXT, position INTEGER NOT NULL,
                data BLOB NOT NULL, saved_at TEXT NOT NULL,
                PRIMARY KEY (marketplace, listing_id, digest));
            CREATE TABLE IF NOT EXISTS photo_sources (
                marketplace TEXT, listing_id TEXT, source_hash TEXT, digest TEXT NOT NULL,
                PRIMARY KEY (marketplace, listing_id, source_hash));
            PRAGMA user_version=2;
            COMMIT;
        """
        )

    def __enter__(self) -> MatchStore:
        """Serialize a short library operation, including migration."""
        self.db.execute("BEGIN IMMEDIATE")
        return self

    def __exit__(self, *error: Any) -> None:
        """Commit only a complete operation and always close the connection."""
        try:
            if error[0] is None:
                self.db.commit()
            else:
                self.db.rollback()
        finally:
            self.db.close()

    def listing(self, market: str, listing_id: str) -> dict[str, Any] | None:
        row = self.db.execute(
            "SELECT data FROM listings WHERE marketplace=? AND listing_id=?", (market, listing_id)
        ).fetchone()
        return json.loads(row[0]) if row else None

    def photos(self, market: str, listing_id: str) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self.db.execute(
                "SELECT digest,saved_at FROM photos WHERE marketplace=? AND listing_id=? "
                "ORDER BY position,digest",
                (market, listing_id),
            )
        ]

    def save_photo(
        self, market: str, listing_id: str, source_hash: str, digest: str, data: bytes
    ) -> None:
        self.db.execute(
            "INSERT OR IGNORE INTO photos SELECT ?,?,?,COALESCE(MAX(position)+1,0),?,? "
            "FROM photos WHERE marketplace=? AND listing_id=?",
            (market, listing_id, digest, data, now(), market, listing_id),
        )
        self.db.execute(
            "INSERT INTO photo_sources VALUES (?,?,?,?) ON CONFLICT(marketplace,listing_id,"
            "source_hash) DO UPDATE SET digest=excluded.digest",
            (market, listing_id, source_hash, digest),
        )

    def save_listing(self, market: str, listing_id: str, data: dict[str, Any]) -> None:
        self.db.execute(
            "INSERT INTO listings VALUES (?, ?, ?) ON CONFLICT(marketplace, listing_id) "
            "DO UPDATE SET data=excluded.data",
            (market, listing_id, json.dumps(data)),
        )

    def match(self, market: str, listing_id: str, item: str) -> dict[str, Any] | None:
        row = self.db.execute(
            "SELECT data FROM matches WHERE marketplace=? AND listing_id=? AND item=?",
            (market, listing_id, item),
        ).fetchone()
        return json.loads(row[0]) if row else None

    def save_match(self, market: str, listing_id: str, item: str, data: dict[str, Any]) -> None:
        self.db.execute(
            "INSERT INTO matches VALUES (?, ?, ?, ?) ON CONFLICT(marketplace, listing_id, item) "
            "DO UPDATE SET data=excluded.data",
            (market, listing_id, item, json.dumps(data)),
        )

    def event(self, market: str, listing_id: str, kind: str, item: str | None, data: Any) -> None:
        self.db.execute(
            "INSERT INTO history(marketplace,listing_id,at,kind,item,data) VALUES (?,?,?,?,?,?)",
            (market, listing_id, now(), kind, item, json.dumps(data)),
        )

    def observe(self, market: str, listing_id: str, item: str, run: str) -> bool:
        previous = self.db.execute(
            "SELECT last_run FROM sightings WHERE marketplace=? AND listing_id=? AND item=?",
            (market, listing_id, item),
        ).fetchone()
        if previous and previous[0] == run:
            return False
        at = now()
        self.db.execute(
            "INSERT INTO sightings VALUES (?,?,?,?,?,?,1) "
            "ON CONFLICT(marketplace,listing_id,item) DO UPDATE SET "
            "last_run=excluded.last_run,last_seen=excluded.last_seen,count=count+1",
            (market, listing_id, item, run, at, at),
        )
        return True

    def snapshot(self, market: str, listing_id: str, fields: dict[str, Any], source: str) -> None:
        saved = self.listing(market, listing_id)
        if saved is None:
            return
        changes = {
            key: {"before": saved.get(key), "after": value}
            for key, value in fields.items()
            if key in ("title", "price", "description") and value and value != saved.get(key)
        }
        # Empty summary fields cannot erase a previously collected detail snapshot.
        saved.update({key: value for key, value in fields.items() if value not in (None, "", [])})
        self.save_listing(market, listing_id, saved)
        if changes:
            self.event(market, listing_id, "changed", None, {"source": source, "changes": changes})

    def history(self, market: str, listing_id: str, cursor: int, limit: int) -> dict[str, Any]:
        rows = self.db.execute(
            "SELECT * FROM history WHERE marketplace=? AND listing_id=? AND (?=0 OR id<?) "
            "ORDER BY id DESC LIMIT ?",
            (market, listing_id, cursor, cursor, limit + 1),
        ).fetchall()
        return {
            "events": [dict(row) | {"data": json.loads(row["data"])} for row in rows[:limit]],
            "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
        }
