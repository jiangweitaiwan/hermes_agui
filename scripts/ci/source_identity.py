"""Hash the archived tracked source, then verify it inside Cloud Build."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath


MANIFEST = ".cicd-source.json"


def hashes(root: Path) -> dict[str, str]:
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("Source archive must not contain symlinks")
        if path.is_file() and path.relative_to(root).as_posix() != MANIFEST:
            result[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def verify(root: Path, expected_sha256: str) -> None:
    raw = (root / MANIFEST).read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError("Source manifest checksum mismatch")
    expected = json.loads(raw)
    for name, digest in expected.items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Invalid source path")
        path = root / name
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError("Source content mismatch: " + name)
    if hashes(root) != expected:
        raise ValueError("Unexpected source files")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("create", "verify"))
    parser.add_argument("root", type=Path)
    parser.add_argument("--sha256")
    args = parser.parse_args()
    if args.operation == "create":
        raw = (json.dumps(hashes(args.root), sort_keys=True, separators=(",", ":")) + "\n").encode()
        (args.root / MANIFEST).write_bytes(raw)
        print(hashlib.sha256(raw).hexdigest())
    else:
        verify(args.root, args.sha256)


if __name__ == "__main__":
    main()
