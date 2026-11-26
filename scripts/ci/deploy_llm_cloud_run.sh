#!/usr/bin/env bash
set -euo pipefail
: "${RELEASE_MANIFEST:?}" "${DEPLOY_REPORT:?}"
python3 -m scripts.ci.llm_rollout --manifest "$RELEASE_MANIFEST" --report "$DEPLOY_REPORT"
