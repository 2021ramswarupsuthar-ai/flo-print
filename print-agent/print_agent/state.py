import json, sqlite3
from pathlib import Path


class Journal:
    def __init__(self, path):
        path.parent.mkdir(exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,job TEXT NOT NULL,state TEXT NOT NULL,result TEXT,reported INTEGER NOT NULL DEFAULT 0,spool_id INTEGER)"
        )
        self.db.commit()

    def get(self, jid):
        return self.db.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()

    def prepare(self, job):
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO jobs(id,job,state) VALUES(?,?,'PREPARING')",
                (job["id"], json.dumps(job)),
            )

    def set(self, jid, state, result=None, spool_id=None, reported=0):
        with self.db:
            self.db.execute(
                "UPDATE jobs SET state=?,result=?,spool_id=coalesce(?,spool_id),reported=? WHERE id=?",
                (
                    state,
                    json.dumps(result) if result else None,
                    spool_id,
                    reported,
                    jid,
                ),
            )

    def recovery(self):
        with self.db:
            self.db.execute(
                "UPDATE jobs SET state='NEEDS_REVIEW',result=?,reported=0 WHERE state IN ('ARMED','PRINTING')",
                (
                    json.dumps(
                        {
                            "status": "NEEDS_REVIEW",
                            "error": "Agent stopped around print submission. Check Windows queue and physical output.",
                        }
                    ),
                ),
            )

    def pending(self):
        return self.db.execute(
            "SELECT * FROM jobs WHERE result IS NOT NULL AND reported=0"
        ).fetchall()
