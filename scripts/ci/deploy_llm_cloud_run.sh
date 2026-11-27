#!/usr/bin/env bash
set -euo pipefail
: "${RELEASE_MANIFEST:?}" "${DEPLOY_REPORT:?}"
: "${GCP_DATABASE_JOB:?}" "${GCP_HOST_MIGRATION_JOB:?}" "${GCP_SCHEDULER_JOBS:?}"
python3 -m scripts.ci.llm_rollout --manifest "$RELEASE_MANIFEST" --report "$DEPLOY_REPORT"
