"""Stage allowlisted profile files and the complete native SQLite database."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import stat
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from uuid import uuid4

from hermes_agui.storage.objects import ObjectStore

_PROFILE_FILES = frozenset({"SOUL.md", "memories/MEMORY.md", "memories/USER.md"})
_MAX_FILES = 256
_MAX_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class BotScope:
    project: str
    principal: str
    bot: str

    def object_namespace(self) -> str:
        return hashlib.sha256(json.dumps([self.project, self.principal, self.bot]).encode()).hexdigest()


@dataclass(frozen=True)
class FileRevision:
    path: str
    generation: str
    sha256: str
    size: int


@dataclass(frozen=True)
class ProfileRevision:
    revision: str
    files: tuple[FileRevision, ...]


def _allowed_path(value: str, approved: frozenset[str]) -> PurePosixPath:
    path = PurePosixPath(value)
    if (not path.parts or path.as_posix() != value or path.is_absolute() or "\\" in value
            or any(part in ("", ".", "..") or part.startswith(".") for part in path.parts)):
        raise ValueError("Invalid profile path")
    if value not in _PROFILE_FILES and value != "state.db":
        if value not in approved or path.parts[0] not in {"skills", "workspace"} or len(path.parts) < 2:
            raise ValueError("Profile path is outside the allowlist")
    return path


def _regular_file(root: Path, relative: PurePosixPath) -> Path | None:
    path = root
    for part in relative.parts[:-1]:
        path /= part
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            return None
        if not stat.S_ISDIR(mode):
            raise ValueError("Unsafe profile directory")
    path /= relative.name
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("Unsafe profile file")
    return path


def _sqlite_snapshot(source: Path, directory: Path) -> Path:
    destination = directory / "state.db"
    # Call only after the native service and its database handles are closed.
    for suffix in ("-wal", "-shm", "-journal"):
        _regular_file(source.parent, PurePosixPath(source.name + suffix))
    with closing(sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)) as reader:
        with closing(sqlite3.connect(destination)) as writer:
            if reader.execute("PRAGMA page_count").fetchone()[0] * reader.execute(
                "PRAGMA page_size"
            ).fetchone()[0] > _MAX_BYTES:
                raise ValueError("Native database exceeds profile quota")
            reader.backup(writer)
            writer.execute("PRAGMA journal_mode=DELETE")
            if writer.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise ValueError("Invalid native session snapshot")
    return destination


class ProfileObjects:
    def __init__(self, objects: ObjectStore, prefix: str = "profiles"):
        self.objects = objects
        self.prefix = prefix.rstrip("/")

    def _key(self, scope: BotScope, revision: str, path: str) -> str:
        return f"{self.prefix}/{scope.object_namespace()}/{revision}/{path}"

    def stage(self, scope: BotScope, root: Path, *, approved: frozenset[str] = frozenset()) -> ProfileRevision:
        """Upload from a quiescent private directory and return an unpublished manifest."""
        root = root.absolute()
        if root.resolve(strict=True) != root or not root.is_dir():
            raise ValueError("Unsafe profile root")
        names = _PROFILE_FILES | {"state.db"} | approved
        if len(names) > _MAX_FILES:
            raise ValueError("Too many profile paths")
        paths = [(name, _allowed_path(name, approved)) for name in sorted(names)]
        revision = uuid4().hex
        size = 0
        files = []
        with TemporaryDirectory() as staging:
            for name, relative in paths:
                path = _regular_file(root, relative)
                if path is None:
                    continue
                if name == "state.db":
                    path = _sqlite_snapshot(path, Path(staging))
                with path.open("rb") as stream:
                    data = stream.read(_MAX_BYTES - size + 1)
                size += len(data)
                if size > _MAX_BYTES:
                    raise ValueError("Profile exceeds byte quota")
                generation = self.objects.create(self._key(scope, revision, name), data)
                files.append(FileRevision(name, generation, hashlib.sha256(data).hexdigest(), len(data)))
        return ProfileRevision(revision, tuple(files))

    def hydrate(self, scope: BotScope, manifest: ProfileRevision, root: Path,
                *, approved: frozenset[str] = frozenset()) -> None:
        """Populate an empty private directory. Discard the directory on any error."""
        root = root.absolute()
        if root.resolve(strict=True) != root or any(root.iterdir()):
            raise ValueError("Hydration requires an empty private directory")
        self._validate_manifest(manifest, approved)
        for item in manifest.files:
            data = self.objects.read(self._key(scope, manifest.revision, item.path), item.generation, limit=item.size)
            if len(data) != item.size or hashlib.sha256(data).hexdigest() != item.sha256:
                raise ValueError("Profile object checksum mismatch")
            target = root / item.path
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with target.open("xb") as stream:
                target.chmod(0o600)
                stream.write(data)

    @staticmethod
    def _validate_manifest(manifest: ProfileRevision, approved: frozenset[str]) -> None:
        if not re.fullmatch(r"[0-9a-f]{32}", manifest.revision):
            raise ValueError("Invalid profile revision")
        names = set()
        total = 0
        for item in manifest.files:
            _allowed_path(item.path, approved)
            if item.path in names or item.size < 0:
                raise ValueError("Invalid profile manifest")
            names.add(item.path)
            total += item.size
        if len(names) > _MAX_FILES or total > _MAX_BYTES:
            raise ValueError("Profile manifest exceeds quota")
