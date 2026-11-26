"""Bind immutable Cloud Build artifacts to the submitted source and offline CI gates.

This manifest describes a BUILT candidate, never staging or production approval.
No Cloud Build response, credential, config or application data is copied verbatim.
"""

import argparse
import hashlib
import json
import re
from pathlib import Path

from scripts.ci.llm_build_outputs import resolve_images
from scripts.ci.migration_gate import verify


OFFLINE_GATES = {"runtime_api", "typecheck_build", "postgres", "migration_integrity", "rollout_policy"}


def create_manifest(build: dict, prefix: str, commit: str, tag: str,
                    source_sha256: str, gates: dict, sql: dict) -> dict:
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Invalid source commit")
    if not re.fullmatch(r"[a-f0-9]{64}", source_sha256):
        raise ValueError("Invalid source archive checksum")
    substitutions = build.get("substitutions", {})
    expected = {"_SOURCE_COMMIT": commit, "_SOURCE_SHA256": source_sha256,
                "_IMAGE_TAG": tag, "_IMAGE_PREFIX": prefix}
    if any(substitutions.get(key) != value for key, value in expected.items()):
        raise ValueError("Cloud Build source metadata mismatch")
    if not tag.startswith(commit + "-") or not build.get("id"):
        raise ValueError("Missing build identity or mismatched image tag")
    required_steps = {"host-image", "verify-source", "host-job-integrity", "node-contracts", "runtime-image", "image-integrity"}
    successful = {step.get("id") for step in build.get("steps", []) if step.get("status") == "SUCCESS"}
    if not required_steps.issubset(successful):
        raise ValueError("Image integrity/build step evidence incomplete")
    images = resolve_images(build, prefix)
    names = {image["name"] for image in build["results"]["images"]}
    if names != {f"{prefix}/hermes-host:{tag}", f"{prefix}/hermes-runtime:{tag}"}:
        raise ValueError("Cloud Build published unexpected image tags")
    if gates.get("commit") != commit or set(gates.get("gates", {})) != OFFLINE_GATES:
        raise ValueError("Missing or mismatched offline CI evidence")
    if any(value != "PASS" for value in gates["gates"].values()):
        raise ValueError("Offline CI gate failed")
    contract = gates.get("code_contract", {})
    accepted = contract.get("accepted_release_contracts")
    if not isinstance(accepted, list) or not accepted or any(not isinstance(v, str) or not v for v in accepted):
        raise ValueError("Missing code contract evidence")
    if not re.fullmatch(r"[a-f0-9]{64}", contract.get("task_fingerprint", "")):
        raise ValueError("Missing task contract fingerprint")
    policy = gates.get("policy", {})
    if not re.fullmatch(r"[a-f0-9]{64}", policy.get("contract", "")) or not re.fullmatch(r"[a-f0-9]{40}", policy.get("baseline", "")):
        raise ValueError("Missing rollout policy evidence")
    return {"policy": policy, "format": 1, "phase": "BUILT", "commit": commit, "build_id": build["id"],
            "source_sha256": source_sha256, "images": images,
            "offline_ci": gates["gates"], "image_integrity": "PASS", "code_contract": {
                "accepted_release_contracts": accepted, "task_fingerprint": contract["task_fingerprint"]},
            "migration_checksums": sql,
            "schema_contract_sha256": hashlib.sha256(
                json.dumps(sql, sort_keys=True).encode()).hexdigest(),
            "staging": "DEFERRED", "production": "CANDIDATE_ONLY"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("build", "gates", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    for name in ("prefix", "commit", "tag", "source-sha256"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    sql = verify(root, json.loads((root / "deploy/gcp/cicd/migration-baseline.json").read_text(encoding="utf-8-sig")))
    result = create_manifest(json.loads(args.build.read_text(encoding="utf-8-sig")), args.prefix, args.commit,
                             args.tag, args.source_sha256, json.loads(args.gates.read_text(encoding="utf-8-sig")), sql)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
