"""SQLite persistence for the hub (design §6, v3 §5.3): nodes, their session index and deliveries.

All methods are synchronous and must be called through `Store.run()`, which executes them on
a single dedicated worker thread. That serialises access to the one sqlite3 connection and
keeps the event loop free of disk I/O.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Iterable, TypeVar

log = logging.getLogger("omni.hub.store")

T = TypeVar("T")

# Ordered list of migrations; index i upgrades user_version i -> i+1.
MIGRATIONS: list[str] = [
    """
    CREATE TABLE nodes (
        node_id    TEXT PRIMARY KEY,
        info_json  TEXT NOT NULL DEFAULT '{}',
        online     INTEGER NOT NULL DEFAULT 0,
        last_seen  REAL,
        first_seen REAL
    );
    CREATE TABLE deliveries (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL DEFAULT 'message',
        parent_id   TEXT,
        from_node   TEXT,
        from_stored TEXT,
        from_addr   TEXT,
        to_node     TEXT NOT NULL,
        to_addr     TEXT NOT NULL,
        to_path     TEXT,
        to_stored   TEXT,
        message     TEXT NOT NULL,
        reply       TEXT,
        status      TEXT NOT NULL DEFAULT 'queued',
        expect_reply INTEGER NOT NULL DEFAULT 0,
        wait        INTEGER NOT NULL DEFAULT 0,
        chain_json  TEXT NOT NULL DEFAULT '[]',
        error       TEXT,
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL,
        user_row_id INTEGER,
        partial     INTEGER NOT NULL DEFAULT 0,
        dispatched_at REAL
    );
    CREATE INDEX deliveries_status ON deliveries(status, created_at);
    CREATE INDEX deliveries_to ON deliveries(to_node, to_stored);
    CREATE INDEX deliveries_from ON deliveries(from_node, from_stored);
    CREATE INDEX deliveries_created ON deliveries(created_at);
    """,
    # v2 -> v3: the session index of every node, delivery titles and conversations.
    """
    CREATE TABLE node_sessions (
        node_id    TEXT NOT NULL,
        stored_id  TEXT NOT NULL,
        row_json   TEXT NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY (node_id, stored_id)
    );
    ALTER TABLE deliveries ADD COLUMN from_title TEXT;
    ALTER TABLE deliveries ADD COLUMN to_title TEXT;
    ALTER TABLE deliveries ADD COLUMN conv_id TEXT;
    CREATE INDEX deliveries_conv ON deliveries(conv_id);
    """,
]

ACTIVE_STATUSES = ("queued", "dispatched")
DELIVERY_COLUMNS = (
    "id", "kind", "parent_id", "from_node", "from_stored", "from_addr", "to_node", "to_addr",
    "to_path", "to_stored", "message", "reply", "status", "expect_reply", "wait", "chain_json",
    "error", "created_at", "updated_at", "user_row_id", "partial", "dispatched_at", "from_title", "to_title",
    "conv_id",
)


def delivery_to_json(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    """Convert a deliveries row to its API form (chain parsed, flags as bools)."""
    d = dict(row)
    try:
        d["chain"] = json.loads(d.pop("chain_json") or "[]")
    except (TypeError, ValueError):
        d["chain"] = []
    for flag in ("expect_reply", "wait", "partial"):
        d[flag] = bool(d.get(flag))
    return d


class Store:
    def __init__(self, path: Path):
        self.path = path
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="omni-db")
        self._conn: sqlite3.Connection | None = None

    # --- lifecycle -------------------------------------------------------------------
    async def open(self) -> None:
        await self.run(self._open)

    async def close(self) -> None:
        if self._conn is not None:
            await self.run(self._conn.close)
            self._conn = None
        self._pool.shutdown(wait=True)

    async def run(self, fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._pool, lambda: fn(*args, **kwargs))

    def _open(self) -> None:
        conn = sqlite3.connect(self.path, isolation_level=None, check_same_thread=False, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        for i in range(version, len(MIGRATIONS)):
            log.info("migrating hub.db to schema v%d", i + 1)
            conn.executescript("BEGIN;\n" + MIGRATIONS[i] + f"\nPRAGMA user_version={i + 1};\nCOMMIT;")
        self._conn = conn

    @property
    def db(self) -> sqlite3.Connection:
        assert self._conn is not None, "store not open"
        return self._conn

    # --- nodes -----------------------------------------------------------------------
    def load_nodes(self) -> list[dict[str, Any]]:
        out = []
        for r in self.db.execute("SELECT * FROM nodes ORDER BY node_id"):
            try:
                info = json.loads(r["info_json"] or "{}")
            except ValueError:
                info = {}
            out.append({"node_id": r["node_id"], "info": info, "online": bool(r["online"]),
                        "last_seen": r["last_seen"], "first_seen": r["first_seen"]})
        return out

    def upsert_node(self, node_id: str, info: dict[str, Any], online: bool, last_seen: float) -> None:
        self.db.execute(
            "INSERT INTO nodes(node_id, info_json, online, last_seen, first_seen) VALUES (?,?,?,?,?) "
            "ON CONFLICT(node_id) DO UPDATE SET info_json=excluded.info_json, online=excluded.online, "
            "last_seen=excluded.last_seen",
            (node_id, json.dumps(info, ensure_ascii=False), int(online), last_seen, last_seen),
        )

    def set_node_online(self, node_id: str, online: bool, last_seen: float) -> None:
        self.db.execute("UPDATE nodes SET online=?, last_seen=? WHERE node_id=?",
                        (int(online), last_seen, node_id))

    def mark_all_offline(self) -> None:
        self.db.execute("UPDATE nodes SET online=0")

    def delete_node(self, node_id: str) -> None:
        """Forget a node. Its delivery history stays; undelivered work to it is cancelled."""
        self.db.execute("DELETE FROM nodes WHERE node_id=?", (node_id,))
        self.db.execute("DELETE FROM node_sessions WHERE node_id=?", (node_id,))
        self.db.execute(
            "UPDATE deliveries SET status='cancelled', error='node_forgotten', updated_at=? "
            "WHERE to_node=? AND status IN ('queued','dispatched')", (time.time(), node_id))

    # --- session index ---------------------------------------------------------------
    def load_node_sessions(self) -> list[tuple[str, str, dict[str, Any]]]:
        out = []
        for r in self.db.execute("SELECT node_id, stored_id, row_json FROM node_sessions"):
            try:
                row = json.loads(r["row_json"])
            except ValueError:
                continue
            if isinstance(row, dict):
                out.append((r["node_id"], r["stored_id"], row))
        return out

    def replace_node_sessions(self, node_id: str, rows: list[dict[str, Any]]) -> None:
        now = time.time()
        self.db.execute("BEGIN")
        try:
            self.db.execute("DELETE FROM node_sessions WHERE node_id=?", (node_id,))
            self.db.executemany(
                "INSERT OR REPLACE INTO node_sessions(node_id, stored_id, row_json, updated_at) VALUES (?,?,?,?)",
                [(node_id, r["stored_id"], json.dumps(r, ensure_ascii=False), now) for r in rows])
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def upsert_node_sessions(self, node_id: str, rows: list[dict[str, Any]], remove: list[str]) -> None:
        now = time.time()
        self.db.execute("BEGIN")
        try:
            self.db.executemany(
                "INSERT OR REPLACE INTO node_sessions(node_id, stored_id, row_json, updated_at) VALUES (?,?,?,?)",
                [(node_id, r["stored_id"], json.dumps(r, ensure_ascii=False), now) for r in rows])
            self.db.executemany("DELETE FROM node_sessions WHERE node_id=? AND stored_id=?",
                                [(node_id, s) for s in remove])
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def count_pair_messages(self, conv_id: str, a: tuple[str, str], b: tuple[str, str]) -> int:
        """kind='message' deliveries between sessions a and b (either direction) in a conversation."""
        row = self.db.execute(
            "SELECT COUNT(*) FROM deliveries WHERE conv_id=? AND kind='message' AND status!='cancelled' AND ("
            "(from_node=? AND from_stored=? AND to_node=? AND to_stored=?) OR "
            "(from_node=? AND from_stored=? AND to_node=? AND to_stored=?))",
            (conv_id, a[0], a[1], b[0], b[1], b[0], b[1], a[0], a[1])).fetchone()
        return int(row[0])

    # --- deliveries ------------------------------------------------------------------
    def insert_delivery(self, d: dict[str, Any]) -> bool:
        """Insert a delivery; returns False if the id already exists (idempotent send)."""
        now = time.time()
        row = {c: None for c in DELIVERY_COLUMNS}
        row.update({"kind": "message", "status": "queued", "expect_reply": 0, "wait": 0,
                    "chain_json": "[]", "partial": 0, "created_at": now, "updated_at": now})
        for k, v in d.items():
            if k == "chain":
                row["chain_json"] = json.dumps(list(v), ensure_ascii=False)
            elif k in row:
                row[k] = int(v) if isinstance(v, bool) else v
        cols = ",".join(DELIVERY_COLUMNS)
        marks = ",".join("?" for _ in DELIVERY_COLUMNS)
        cur = self.db.execute(f"INSERT OR IGNORE INTO deliveries({cols}) VALUES ({marks})",
                              [row[c] for c in DELIVERY_COLUMNS])
        return cur.rowcount == 1

    def get_delivery(self, delivery_id: str) -> dict[str, Any] | None:
        r = self.db.execute("SELECT * FROM deliveries WHERE id=?", (delivery_id,)).fetchone()
        return delivery_to_json(r) if r else None

    def update_delivery(self, delivery_id: str, only_if_status: Iterable[str] | None = None,
                        **fields: Any) -> dict[str, Any] | None:
        """Update fields (+updated_at). With only_if_status, the update is conditional and
        None is returned when the row is not in one of those statuses."""
        fields["updated_at"] = time.time()
        for k in list(fields):
            if k not in DELIVERY_COLUMNS:
                raise KeyError(k)
            if isinstance(fields[k], bool):
                fields[k] = int(fields[k])
        sets = ",".join(f"{k}=?" for k in fields)
        args: list[Any] = list(fields.values()) + [delivery_id]
        sql = f"UPDATE deliveries SET {sets} WHERE id=?"
        if only_if_status is not None:
            statuses = tuple(only_if_status)
            sql += f" AND status IN ({','.join('?' for _ in statuses)})"
            args += list(statuses)
        cur = self.db.execute(sql, args)
        if cur.rowcount == 0:
            return None
        return self.get_delivery(delivery_id)

    def list_deliveries(self, limit: int = 100, address: str | None = None,
                        status: str | None = None) -> list[dict[str, Any]]:
        where, args = [], []
        if address:
            node, _, rest = address.partition("/")
            sid = None
            if "#" in address:
                sid = address.split("#", 1)[1]
            if not rest and "#" not in address:
                where.append("(from_node=? OR to_node=?)")
                args += [node, node]
            else:
                # "n/p" also matches "n/p#sid" rows; LIKE wildcards in the address are escaped.
                clause = ("(from_addr=? OR to_addr=? OR from_addr LIKE ? ESCAPE '\\' "
                          "OR to_addr LIKE ? ESCAPE '\\'")
                like = address.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "#%"
                args += [address, address, like, like]
                if sid:
                    clause += " OR from_stored=? OR to_stored=?"
                    args += [sid, sid]
                where.append(clause + ")")
        if status:
            where.append("status=?")
            args.append(status)
        sql = "SELECT * FROM deliveries"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
        args.append(max(1, min(int(limit), 1000)))
        return [delivery_to_json(r) for r in self.db.execute(sql, args)]

    def deliveries_for_session(self, node: str, stored_id: str, limit: int = 20) -> list[dict[str, Any]]:
        sql = ("SELECT * FROM deliveries WHERE (to_node=? AND to_stored=?) OR (from_node=? AND from_stored=?) "
               "ORDER BY created_at DESC, rowid DESC LIMIT ?")
        return [delivery_to_json(r) for r in
                self.db.execute(sql, (node, stored_id, node, stored_id, max(1, min(int(limit), 200))))]

    def deliveries_by_status(self, status: str, node: str | None = None) -> list[dict[str, Any]]:
        sql, args = "SELECT * FROM deliveries WHERE status=?", [status]
        if node is not None:
            sql += " AND to_node=?"
            args.append(node)
        sql += " ORDER BY created_at, rowid"
        return [delivery_to_json(r) for r in self.db.execute(sql, args)]

    def find_dispatched_by_row(self, node: str, stored_id: str, user_row_id: int) -> dict[str, Any] | None:
        r = self.db.execute(
            "SELECT * FROM deliveries WHERE status='dispatched' AND to_node=? AND to_stored=? AND user_row_id=?",
            (node, stored_id, user_row_id)).fetchone()
        return delivery_to_json(r) if r else None

    def retarget_session(self, node: str, old: str, new: str) -> int:
        """Follow a compression tip rotation for active deliveries."""
        n = self.db.execute(
            "UPDATE deliveries SET to_stored=? WHERE to_node=? AND to_stored=? AND status IN ('queued','dispatched')",
            (new, node, old)).rowcount
        n += self.db.execute(
            "UPDATE deliveries SET from_stored=? WHERE from_node=? AND from_stored=? AND status IN ('queued','dispatched')",
            (new, node, old)).rowcount
        return n
