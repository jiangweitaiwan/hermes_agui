"""Verify reviewed migration bytes without executing DDL or replacing either migrator."""

import argparse
import hashlib
import json
from pathlib import Path


ROOTS = ("hermes_agui/storage/migrations", "examples/copilotkit/server/storage/migrations")
GRANTS = ("deploy/gcp/database-grants.sql", "deploy/gcp/llm-control-grants.sql")


def inventory(root: Path) -> dict[str, str]:
    paths = [path for directory in ROOTS for path in (root / directory).glob("*.sql")]
    paths.extend(root / name for name in GRANTS)
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths)}


def verify(root: Path, declaration: dict) -> dict[str, str]:
    """A new or edited SQL file always needs a separate compatibility review."""
    if declaration.get("format") != 1:
        raise ValueError("BLOCKED: unknown migration declaration format")
    actual = inventory(root)
    expected = declaration["files"]
    if actual != expected:
        changed = sorted(name for name in actual.keys() | expected.keys()
                         if actual.get(name) != expected.get(name))
        raise ValueError("BLOCKED: unreviewed migration/grants bytes: " + ", ".join(changed))
    # The initial checksum baseline is not an old-reader compatibility attestation.
    return actual


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    declaration = json.loads((args.root / "deploy/gcp/cicd/migration-baseline.json").read_text(encoding="utf-8-sig"))
    print(json.dumps({"status": "PASS", "scope": "SQL integrity only",
                      "files": verify(args.root, declaration)}, sort_keys=True))


if __name__ == "__main__":
    main()
