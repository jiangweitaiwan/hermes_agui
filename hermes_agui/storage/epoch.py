"""Database authority for task and object generations; never cache across requests."""
from uuid import UUID


def epoch(connection):
    row = connection.execute("SELECT epoch::text FROM hermes_agui_host.deployment_epoch WHERE singleton").fetchone()
    if row is None:
        raise RuntimeError("Deployment epoch authority missing")
    return row[0]


def payload_status(value, current, key):
    """Return current/stale after strict validation, before any work-ID lookup."""
    if not isinstance(value, dict) or type(value.get("schema")) is not int:
        raise ValueError("Invalid task schema")
    version = value["schema"]
    if version == 1 and set(value) == {"schema", key}:
        return "stale" if current else "current"
    if version != 2 or set(value) != {"schema", key, "epoch"}:
        raise ValueError("Invalid task schema")
    if not isinstance(value["epoch"], str) or str(UUID(value["epoch"])) != value["epoch"]:
        raise ValueError("Invalid task epoch")
    if current is None:
        raise ValueError("Epoch task before clean bootstrap")
    return "current" if value["epoch"] == current else "stale"
