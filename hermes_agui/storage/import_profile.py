"""Offline import of one native Hermes profile into the Host storage schema."""

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

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
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    scope = BotScope(args.project, args.principal, args.bot)
    if not all((scope.project, scope.principal, scope.bot, args.session_home_identity)):
        parser.error("Scope and original session identity must be nonempty")
    approved = frozenset(args.approve)
    if args.dry_run:
        with TemporaryDirectory(prefix="agui-profile-import-") as scratch:
            preview = ProfileObjects(FilesystemObjects(Path(scratch)), prefix=args.prefix)
            manifest = preview.stage(scope, args.source, approved=approved)
    else:
        manifest = _publish(args, scope, approved)
    print(json.dumps({
        "dry_run": args.dry_run,
        "scope": asdict(scope),
        "session_home_identity": args.session_home_identity,
        "revision": manifest.revision,
        "file_count": len(manifest.files),
        "bytes": sum(item.size for item in manifest.files),
        "files": [asdict(item) for item in manifest.files],
    }, ensure_ascii=False, indent=2))


def _publish(args, scope, approved):
    from psycopg import connect

    database = os.environ.get("AGUI_HOST_DATABASE_URL")
    bucket = os.environ.get("AGUI_GCS_BUCKET")
    if not database or not bucket:
        raise SystemExit("Set AGUI_HOST_DATABASE_URL and AGUI_GCS_BUCKET")
    profiles = ProfileObjects(GCSObjects.from_adc(bucket), prefix=args.prefix)
    key = (scope.project, scope.principal, scope.bot)
    with connect(database) as connection:
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
    return manifest


if __name__ == "__main__":
    main()
