# Part 1 final acceptance evidence

Tested code candidate: `c9e7a56d46d4eb70e6ac9f26edb29c0a685796c9`.
Source digest (all tracked files outside docs/): `3dfd47ac67b3e26de62b0e42d7a10ff800f001e201df846757a8259eaeb96795`.

Each step JSON records the exact command, candidate SHA, UTC start/end, elapsed, exit code and log SHA-256.
Final acceptance flags and G1–G8 mapping are in [status](../../docs/cloud-native-part1-status.json).

| Step | Exit | Elapsed seconds | Metadata | Log |
| --- | --- | --- | --- | --- |
| final-browser | 0 | 298.04 | [final-browser.json](final-browser.json) | [final-browser.log](final-browser.log) |
| final-container | 0 | 235.081 | [final-container.json](final-container.json) | [final-container.log](final-container.log) |
| final-diff-candidate | 0 | 0.311 | [final-diff-candidate.json](final-diff-candidate.json) | [final-diff-candidate.log](final-diff-candidate.log) |
| final-diff-worktree | 0 | 0.068 | [final-diff-worktree.json](final-diff-worktree.json) | [final-diff-worktree.log](final-diff-worktree.log) |
| final-fixture-image | 0 | 2.7 | [final-fixture-image.json](final-fixture-image.json) | [final-fixture-image.log](final-fixture-image.log) |
| final-guard-contracts | 0 | 21.416 | [final-guard-contracts.json](final-guard-contracts.json) | [final-guard-contracts.log](final-guard-contracts.log) |
| final-host-image | 0 | 23.894 | [final-host-image.json](final-host-image.json) | [final-host-image.log](final-host-image.log) |
| final-legacy-container-probe | 0 | 21.727 | [final-legacy-container-probe.json](final-legacy-container-probe.json) | [final-legacy-container-probe.log](final-legacy-container-probe.log) |
| final-migrate | 0 | 1.856 | [final-migrate.json](final-migrate.json) | [final-migrate.log](final-migrate.log) |
| final-regression | 0 | 713.124 | [final-regression.json](final-regression.json) | [final-regression.log](final-regression.log) |
| final-report-diff | 0 | 0.158 | [final-report-diff.json](final-report-diff.json) | [final-report-diff.log](final-report-diff.log) |
| final-repository-check | 0 | 130.156 | [final-repository-check.json](final-repository-check.json) | [final-repository-check.log](final-repository-check.log) |
| final-runtime-image | 0 | 2.169 | [final-runtime-image.json](final-runtime-image.json) | [final-runtime-image.log](final-runtime-image.log) |
| final-test-pg-stop | 0 | 0.16 | [final-test-pg-stop.json](final-test-pg-stop.json) | [final-test-pg-stop.log](final-test-pg-stop.log) |

## Direct proof and scope

- [Owner decisions](owner-decisions.json): fresh_deployment, local data retained, historical full migration N/A; approved run-local untrusted reference contract.
- [Restart proof](restart-proof.json), [JUnit](container.junit.xml), [read-only DB snapshots](restart-db-snapshots.jsonl), [container diagnostics](container-diagnostics/).
- [Environment](environment.json), [image IDs/digests](images.json), [frozen manifest](source-manifest.json).
- [Report revision and source verification](report-revision.json) is recorded after the documentation-only commit.
- [Validation commands](../../docs/cloud-native-part1-validation.md); the production legacy probe body is exactly the one called by test_runtime_container.py, using the candidate image and all original assertions.

## Preserved development failures (never counted as final PASS)

- `graph-browser-focused.log`: sandbox HTTP bind EPERM; `graph-browser-authorized.log`: same 11 tests pass with normal loopback permissions, original deadline retained.
- `check-baseline.log` / `check-baseline-tools.log`: missing pinned tool then six missing guards, no-tmp and root package assumption. `resolver-base-red.log`: two new contracts fail on the base.
- `pg-setup.log` / `migrate-focused.log`: initial local PG listen argument mistake; corrected startup/migration logs retained. No existing DB was touched.
- `focused-python.log`: busy-run release used positional keyword-only arguments; focused fixed rerun retained.
- `health-focused.log`: restored lazy-deps guard lacked bounded git subprocesses; `check-focused-fixed.log` verifies the real 17 checks after repair.
- [61bd4fd attempt](attempt-61bd4fd/): production smoke passes; scenario fails in the optional Tmpfs diagnostic field.
- [1a55972 attempt](attempt-1a55972/): unrelated query returns no knowledge; first-system expectation fails. Actual API comparison and targeted diagnostic stop are recorded.
- [89eadbf attempt](attempt-89eadbf/): relevant query produces multipart untrusted reference; old fake-model parser rejects it. Targeted diagnostic stop and FAIL retained. Its complete regression PASS was superseded and rerun on the final candidate.
- [c259c3a attempt](attempt-c259c3a/): complete suites passed, final diff check found trailing whitespace and blank EOF lines; corrected and all required suites rerun on the final candidate.
- [Contract proposal](PROPOSED_REFERENCE_CONTRACT.md) and proposed/approved patches are historical review artifacts; the committed candidate fixture is authoritative.

Only synthetic fixture logs/operational fields were retained; deployment templates, private keys, real profiles and full environment dumps were not copied.
Real GCS generation/IAM, Cloud SQL/PITR and Part 2 deployment work are NOT RUN.

`SHA256SUMS` indexes the saved artifacts; large logs and manifests are kept locally rather than added to the source commit.
