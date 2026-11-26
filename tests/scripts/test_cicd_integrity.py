"""Tampering or unreviewed migrations cannot become a verified release."""

import hashlib
import json

import pytest

from scripts.ci.migration_gate import GRANTS, ROOTS, inventory, verify as verify_sql
from scripts.ci.python_audit import validate_report
from scripts.ci.source_identity import MANIFEST, hashes, verify


def test_audit_requires_real_results_and_only_exempts_the_local_project():
    validate_report({"dependencies": [{"name": "requests", "vulns": []},
                                      {"name": "hermes-agent", "skip_reason": "local project"}]})
    for dependencies in ([], [{"name": "hermes-agent", "skip_reason": "local project"}],
                         [{}],
                         [{"name": "requests", "skip_reason": "unavailable"}],
                         [{"name": "requests", "vulns": []}, {"name": "unknown", "skip_reason": "unavailable"}],
                         [{"name": "requests", "vulns": [{"id": "advisory"}]}]):
        with pytest.raises(ValueError):
            validate_report({"dependencies": dependencies})


def test_source_verification_rejects_tampered_content_and_manifest(tmp_path):
    source = tmp_path / "app.py"
    source.write_text("original")
    raw = json.dumps(hashes(tmp_path)).encode()
    (tmp_path / MANIFEST).write_bytes(raw)
    digest = hashlib.sha256(raw).hexdigest()
    verify(tmp_path, digest)
    unexpected = tmp_path / "sitecustomize.py"
    unexpected.write_text("injected")
    with pytest.raises(ValueError, match="Unexpected source"):
        verify(tmp_path, digest)
    unexpected.unlink()
    source.write_text("modified")
    with pytest.raises(ValueError, match="content mismatch"):
        verify(tmp_path, digest)
    (tmp_path / MANIFEST).write_text("{}")
    with pytest.raises(ValueError, match="checksum mismatch"):
        verify(tmp_path, digest)


@pytest.mark.parametrize("mutation", ["edit", "add", "delete", "grants"])
def test_migration_integrity_rejects_unknown_bytes(tmp_path, mutation):
    for directory in ROOTS:
        target = tmp_path / directory
        target.mkdir(parents=True)
        (target / "001.sql").write_text("SELECT 1;")
    for name in GRANTS:
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("SELECT 1;")
    declaration = {"format": 1, "files": inventory(tmp_path)}
    assert verify_sql(tmp_path, declaration) == declaration["files"]
    migration = tmp_path / ROOTS[0] / "001.sql"
    if mutation == "edit":
        migration.write_text("DROP TABLE preserved;")
    elif mutation == "add":
        (migration.parent / "002.sql").write_text("ALTER TABLE preserved ADD x text;")
    elif mutation == "delete":
        migration.unlink()
    else:
        (tmp_path / GRANTS[0]).write_text("GRANT ALL ON SCHEMA public TO PUBLIC;")
    with pytest.raises(ValueError, match="BLOCKED"):
        verify_sql(tmp_path, declaration)
