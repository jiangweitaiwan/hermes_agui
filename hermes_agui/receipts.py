"""Durable admission tombstones, separate from Hermes-owned conversation storage."""

from contextlib import contextmanager
import sqlite3


class ReceiptStore:
    """Reserve both IDs atomically before execution; never replay uncertain work."""

    def __init__(self, home, principal, limit):
        home.mkdir(parents=True, exist_ok=True)
        self.path = home / "agui-receipts.db"
        self.principal, self.limit = principal, limit
        with self._connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS receipts (
                principal TEXT NOT NULL, thread TEXT NOT NULL, kind TEXT NOT NULL,
                identifier TEXT NOT NULL,
                PRIMARY KEY (principal, thread, kind, identifier))""")

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path, timeout=1)
        try:
            with db:
                yield db
        finally:
            db.close()

    def reserve(self, turn):
        """Return accepted/duplicate/full; a crash leaves the reservation intact."""
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            keys = [(self.principal, turn.thread_id, "run", turn.run_id),
                    (self.principal, turn.thread_id, "message", turn.message_id)]
            for key in keys:
                if db.execute("SELECT 1 FROM receipts WHERE principal=? AND thread=? AND kind=? AND identifier=?",
                              key).fetchone():
                    return "duplicate"
            count = db.execute("SELECT COUNT(*) FROM receipts WHERE principal=?", (self.principal,)).fetchone()[0]
            if count + 2 > self.limit:
                return "full"
            db.executemany("INSERT INTO receipts VALUES (?, ?, ?, ?)", keys)
        return "accepted"
