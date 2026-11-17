"""Immutable object I/O. A manifest pins each object to a specific generation."""

import hashlib
import os
from pathlib import Path, PurePosixPath
from tempfile import NamedTemporaryFile
from typing import Protocol


class ObjectStore(Protocol):
    def create(self, key: str, data: bytes) -> str: ...
    def read(self, key: str, generation: str, *, limit: int) -> bytes: ...


class FilesystemObjects:
    """Immutable objects in a private, service-owned directory."""

    def __init__(self, root: Path):
        self.root = root.resolve()

    def _path(self, key: str) -> Path:
        path = PurePosixPath(key)
        if path.is_absolute() or not path.parts or any(part.startswith(".") for part in path.parts):
            raise ValueError("Invalid object key")
        result = self.root / path
        if result.resolve() != result:
            raise ValueError("Unsafe object path")
        return result

    def create(self, key: str, data: bytes) -> str:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with NamedTemporaryFile(dir=path.parent) as staging:
            staging.write(data)
            staging.flush()
            os.fsync(staging.fileno())
            os.link(staging.name, path)
        return hashlib.sha256(data).hexdigest()

    def read(self, key: str, generation: str, *, limit: int) -> bytes:
        with self._path(key).open("rb") as stream:
            data = stream.read(limit + 1)
        if len(data) > limit or hashlib.sha256(data).hexdigest() != generation:
            raise ValueError("Invalid object generation or size")
        return data


class GCSObjects:
    def __init__(self, bucket):
        self.bucket = bucket

    @classmethod
    def from_adc(cls, bucket_name: str):
        from google.cloud.storage import Client

        return cls(Client().bucket(bucket_name))

    def create(self, key: str, data: bytes) -> str:
        blob = self.bucket.blob(key)
        blob.upload_from_string(data, if_generation_match=0, timeout=30, checksum="crc32c")
        if blob.generation is None:
            raise RuntimeError("Object upload did not return a generation")
        return str(blob.generation)

    def read(self, key: str, generation: str, *, limit: int) -> bytes:
        version = int(generation)
        blob = self.bucket.blob(key, generation=version)
        blob.reload(if_generation_match=version, timeout=30)
        if blob.size is None or blob.size > limit:
            raise ValueError("Object exceeds download limit")
        return blob.download_as_bytes(if_generation_match=version, raw_download=True, timeout=30)
