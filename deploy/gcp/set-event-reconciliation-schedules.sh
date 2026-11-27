#!/usr/bin/env bash
# Explicit operator action, only after normal event delivery and active-drain acceptance.
set -euo pipefail
[[ "${1:-}" == --apply && "${EVENT_PATH_ACCEPTED:-false}" == true ]] || {
  echo 'Requires --apply and EVENT_PATH_ACCEPTED=true after event-path and rollout acceptance.' >&2; exit 2;
}
: "${GCP_PROJECT_ID:?}"
region="${GCP_BUILD_REGION:-asia-east1}"
jobs=(hermes-completion-schedule hermes-reconcile-schedule hermes-worker-schedule)
crons=('0,30 * * * *' '5,35 * * * *' '10,40 * * * *')
for index in 0 1 2; do
  gcloud scheduler jobs update http "${jobs[$index]}" --project="$GCP_PROJECT_ID" --location="$region" \
    --schedule="${crons[$index]}" --time-zone=Asia/Taipei --quiet --format='value(name,schedule,timeZone,state)'
done
