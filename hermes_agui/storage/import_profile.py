"""Offline import of one native Hermes profile into the Host storage schema."""

import argparse
from contextlib import closing
from dataclasses import asdict
import json
import os
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
from uuid import uuid4

from hermes_agui.storage.objects import FilesystemObjects, GCSObjects
from hermes_agui.storage.profile import BotScope, ProfileObjects


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Quiescent profile backup")
    parser.add_argument("--project", required=True)
    parser.add_argument("--principal", required=True)
    parser.add_argument("--bot", required=True)
    parser.add_argument("--session-home-identity", required=True, help="Original AgentConfig home identity")
    parser.add_argument("--prefix", default="profiles")
    parser.add_argument("--approve", action="append", default=[])
    parser.add_argument("--managed-registry", type=Path, help="Quiescent legacy Host registry backup")
    parser.add_argument("--owner-id", help="Trusted Runtime owner for the managed Bot")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    scope = BotScope(args.project, args.principal, args.bot)
    if not all((scope.project, scope.principal, scope.bot, args.session_home_identity)):
        parser.error("Scope and original session identity must be nonempty")
    if bool(args.managed_registry) != bool(args.owner_id):
        parser.error("--managed-registry and --owner-id must be supplied together")
    managed = _managed_spec(args, scope) if args.managed_registry else None
    approved = frozenset(args.approve)
    if args.dry_run:
        with TemporaryDirectory(prefix="agui-profile-import-") as scratch:
            preview = ProfileObjects(FilesystemObjects(Path(scratch)), prefix=args.prefix)
            manifest = preview.stage(scope, args.source, approved=approved)
    else:
        manifest = _publish(args, scope, approved, managed)
    print(json.dumps({
        "dry_run": args.dry_run,
        "scope": asdict(scope),
        "session_home_identity": args.session_home_identity,
        "managed": managed is not None,
        "revision": manifest.revision,
        "file_count": len(manifest.files),
        "bytes": sum(item.size for item in manifest.files),
        "files": [asdict(item) for item in manifest.files],
    }, ensure_ascii=False, indent=2))


def _managed_spec(args, scope):
    from hermes_agui.provisioner import BotSpec

    source = args.managed_registry.resolve(strict=True).as_uri()
    with closing(sqlite3.connect(f"{source}?mode=ro", uri=True)) as connection:
        row = connection.execute("SELECT spec,status FROM bots WHERE id=?", (scope.bot,)).fetchone()
    if row is None or row[1] not in {"active", "disabled", "deleted"}:
        raise SystemExit("Reconcile the source managed Bot to a stable status before import")
    spec = BotSpec.model_validate_json(row[0])
    if (spec.id, spec.principal, spec.projectId) != (scope.bot, scope.principal, scope.project):
        raise SystemExit("Legacy Host registry scope does not match the import")
    if spec.ownerId not in {None, args.owner_id} or set(spec.toolsets) - {"memory", "skills"}:
        raise SystemExit("Legacy Bot owner or toolsets are incompatible with the durable Host")
    value = spec.model_dump(exclude={"token", "memoryKey"})
    value["ownerId"] = args.owner_id
    return value, row[1]


def _publish(args, scope, approved, managed):
    from psycopg import connect

    database = os.environ.get("AGUI_HOST_DATABASE_URL")
    bucket = os.environ.get("AGUI_GCS_BUCKET")
    if not database or not bucket:
        raise SystemExit("Set AGUI_HOST_DATABASE_URL and AGUI_GCS_BUCKET")
    profiles = ProfileObjects(GCSObjects.from_adc(bucket), prefix=args.prefix)
    key = (scope.project, scope.principal, scope.bot)
    with connect(database) as connection:
        if managed:
            connection.execute("SELECT pg_advisory_xact_lock(53859273, hashtext(%s))", (scope.project,))
        # Reserve only an absent scope. The row and manifest become visible together.
        new = connection.execute("""INSERT INTO hermes_agui_host.bot_state (project,principal,bot)
            VALUES (%s,%s,%s) ON CONFLICT DO NOTHING RETURNING bot""", key).fetchone()
        if new is None:
            raise SystemExit("Target scope already exists")
        manifest = profiles.stage(scope, args.source, approved=approved)
        with TemporaryDirectory(prefix="agui-profile-verify-") as scratch:
            profiles.hydrate(scope, manifest, Path(scratch).resolve(), approved=approved)
        connection.execute("""UPDATE hermes_agui_host.bot_state SET profile=%s::jsonb
            WHERE (project,principal,bot)=(%s,%s,%s)""", (json.dumps(asdict(manifest)), *key))
        if managed:
            value, status = managed
            connection.execute("""INSERT INTO hermes_agui_host.managed_bots
                (project,principal,bot,revision,status,spec,session_home_identity)
                VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s)""",
                (*key, uuid4(), status, json.dumps(value), args.session_home_identity))
    return manifest


if __name__ == "__main__":
    main()
