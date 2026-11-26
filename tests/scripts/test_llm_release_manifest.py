"""A successful build is insufficient without source-bound CI and both exact artifacts."""

from copy import deepcopy

import pytest

from scripts.ci.llm_release_manifest import OFFLINE_GATES, create_manifest


COMMIT = "b" * 40
SOURCE = "c" * 64
PREFIX = "region-docker.pkg.dev/isolated/repository"
TAG = COMMIT + "-123-1"


def candidate():
    return {"id": "build-123", "status": "SUCCESS", "substitutions": {
        "_SOURCE_COMMIT": COMMIT, "_SOURCE_SHA256": SOURCE,
        "_IMAGE_TAG": TAG, "_IMAGE_PREFIX": PREFIX,
    }, "results": {"images": [
        {"name": f"{PREFIX}/{name}:{TAG}", "digest": "sha256:" + digest * 64}
        for name, digest in (("hermes-host", "a"), ("hermes-runtime", "d"))
    ]}}


def evidence():
    return {"commit": COMMIT, "gates": dict.fromkeys(OFFLINE_GATES, "PASS"),
            "code_contract": {"accepted_release_contracts": ["fixture-v1"], "task_fingerprint": "f" * 64}}


@pytest.mark.parametrize("failure", ["commit", "source", "tag", "build", "digest", "duplicate",
                                      "ci_commit", "ci_failed", "ci_missing", "ci_skipped", "contract"])
def test_failure_injection_rejects_ineligible_artifacts(failure):
    build, gates = candidate(), evidence()
    image = build["results"]["images"][0]
    mutations = {
        "commit": lambda: build["substitutions"].update(_SOURCE_COMMIT="e" * 40),
        "source": lambda: build["substitutions"].update(_SOURCE_SHA256="e" * 64),
        "tag": lambda: image.update(name=f"{PREFIX}/hermes-host:stale"),
        "build": lambda: build.update(status="FAILURE"),
        "digest": lambda: image.update(digest="latest"),
        "duplicate": lambda: build["results"]["images"].append(deepcopy(image)),
        "ci_commit": lambda: gates.update(commit="e" * 40),
        "ci_failed": lambda: gates["gates"].update(postgres="FAILED"),
        "ci_missing": lambda: gates["gates"].pop("security"),
        "ci_skipped": lambda: gates["gates"].update(browser="SKIPPED"),
        "contract": lambda: gates.pop("code_contract"),
    }
    mutations[failure]()
    with pytest.raises(ValueError):
        create_manifest(build, PREFIX, COMMIT, TAG, SOURCE, gates, {})


def test_built_candidate_is_not_cloud_acceptance_and_contains_no_raw_metadata():
    build = candidate()
    build["secret"] = "must-not-escape"
    manifest = create_manifest(build, PREFIX, COMMIT, TAG, SOURCE, evidence(), {"migration.sql": "abc"})
    assert manifest["phase"] == "BUILT"
    assert manifest["production"] == "BLOCKED" and manifest["staging"] == "NOT_RUN"
    assert manifest["images"]["host_image"].endswith("@sha256:" + "a" * 64)
    assert "secret" not in manifest
