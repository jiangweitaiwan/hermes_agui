#!/usr/bin/env bash
set -euo pipefail

: "${GCP_PROJECT_ID:?}" "${GCP_BUILD_REGION:?}" "${HOST_IMAGE:?}" "${RUNTIME_IMAGE:?}"
image_prefix="asia-east1-docker.pkg.dev/${GCP_PROJECT_ID}/hermes"
[[ "$HOST_IMAGE" =~ ^${image_prefix}/hermes-host@sha256:[a-f0-9]{64}$ ]]
[[ "$RUNTIME_IMAGE" =~ ^${image_prefix}/hermes-runtime@sha256:[a-f0-9]{64}$ ]]
services=(hermes-runtime hermes-host hermes-worker)
images=("$RUNTIME_IMAGE" "$HOST_IMAGE" "$RUNTIME_IMAGE")
revisions=()
trap 'echo "Rollout failed. Keep admission/delivery paused; inspect candidate revisions and traffic before recovery." >&2' ERR

# Preflight all consumers before mutating Runtime. Never recreate a missing service
# with incomplete config, identities, SQL, secrets, IAM or worker command.
for service in "${services[@]}"; do
  gcloud run services describe "$service" \
    --project="$GCP_PROJECT_ID" --region="$GCP_BUILD_REGION" --format='value(metadata.name)' > /dev/null
done

for index in 0 1 2; do
  service="${services[$index]}"
  revision="$(gcloud run services update "$service" \
    --project="$GCP_PROJECT_ID" --region="$GCP_BUILD_REGION" \
    --image="${images[$index]}" --no-traffic --deploy-health-check \
    --startup-probe='httpGet.path=/health,httpGet.port=8080,periodSeconds=10,timeoutSeconds=5,failureThreshold=24' \
    --format='value(status.latestReadyRevisionName)' --quiet)"
  [[ -n "$revision" ]]
  # A failed new revision must never be mistaken for the previous ready one.
  created="$(gcloud run services describe "$service" \
    --project="$GCP_PROJECT_ID" --region="$GCP_BUILD_REGION" \
    --format='value(status.latestCreatedRevisionName)')"
  [[ "$revision" == "$created" ]]
  revisions+=("$revision")
  echo "Candidate ready: $revision"
done

# All three startup gates have passed. Admission/delivery remains paused until
# the operator completes cross-service acceptance and explicitly resumes it.
for index in 0 1 2; do
  gcloud run services update-traffic "${services[$index]}" \
    --project="$GCP_PROJECT_ID" --region="$GCP_BUILD_REGION" \
    --to-revisions="${revisions[$index]}=100" --quiet
  echo "Deployed ${services[$index]}: ${images[$index]}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "- ${services[$index]}: ${revisions[$index]} — ${images[$index]}" >> "$GITHUB_STEP_SUMMARY"
  fi
done
