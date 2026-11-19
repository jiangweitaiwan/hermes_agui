"""Resolve the same metrics engine in repositories with multiple Node packages."""
import json

import pytest

from scripts.code_health.ts_measure import pinned_typescript, resolve_typescript
from tests.scripts.test_code_health import _commit, _repo


def test_nested_packages_resolve_installed_engine_without_root_manifest(tmp_path):
    repo, _ = _repo(tmp_path)
    manifest = json.dumps({"devDependencies": {"typescript": "5.9.3"}})
    _commit(repo, {"examples/a/package.json": manifest, "web/package.json": manifest})
    engine = repo / "web/node_modules/typescript"
    engine.mkdir(parents=True)
    (engine / "package.json").write_text(json.dumps({"version": "5.9.3"}), encoding="utf-8")
    assert pinned_typescript(repo) == "5.9.3"
    assert resolve_typescript(repo) == engine


def test_conflicting_package_engines_fail_instead_of_selecting_one(tmp_path):
    repo, _ = _repo(tmp_path)
    _commit(repo, {f"{name}/package.json": json.dumps({"devDependencies": {"typescript": pin}})
                   for name, pin in (("a", "5.9.3"), ("b", "5.8.3"))})
    with pytest.raises(RuntimeError, match="consistent TypeScript pin"):
        resolve_typescript(repo)
