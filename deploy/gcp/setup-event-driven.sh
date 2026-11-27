#!/usr/bin/env bash
# Operator-only: check and apply infrastructure; never execute Jobs, SQL or schedules.
set -euo pipefail
mode="${1:-check}"
[[ "$mode" == check || "$mode" == apply ]] || { echo 'Usage: setup-event-driven.sh check|apply' >&2; exit 2; }
: "${GRAPH_QUEUE:?Existing Graph queue name}" "${GRAPH_COMPLETION_TOKEN_SECRET:?Existing Runtime completion credential Secret}"
: "${GCP_PROJECT_ID:?}" "${HOST_EXECUTION_SA:?}" "${COMPLETION_DISPATCH_SA:?}" "${COMPLETION_TOKEN_SECRET:?}"
region="${GCP_BUILD_REGION:-asia-east1}"
queue="${COMPLETION_QUEUE:-hermes-completion-delivery}"
for item in "$GCP_PROJECT_ID" "$region" "$queue" "$COMPLETION_TOKEN_SECRET" "$GRAPH_QUEUE" "$GRAPH_COMPLETION_TOKEN_SECRET"; do
  [[ "$item" =~ ^[a-z][a-z0-9-]{0,99}$ ]] || { echo 'Invalid resource name' >&2; exit 2; }
done
for item in "$HOST_EXECUTION_SA" "$COMPLETION_DISPATCH_SA"; do
  [[ "$item" =~ ^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com$ ]] || exit 2
done
common=(--project="$GCP_PROJECT_ID" --quiet)
if [[ "$mode" == check ]]; then
  gcloud tasks queues describe "$queue" --location="$region" "${common[@]}" --format='json(name,state,rateLimits,retryConfig)'
  gcloud secrets describe "$COMPLETION_TOKEN_SECRET" "${common[@]}" --format='value(name)'
  gcloud run services describe hermes-host --region="$region" "${common[@]}" --format='value(status.url)'
  echo 'Check IAM, pinned secret version and managed producer inventory before rollout.'
  exit
fi
gcloud services enable cloudtasks.googleapis.com "${common[@]}"
if gcloud tasks queues describe "$queue" --location="$region" "${common[@]}" --format='value(name)' >/dev/null 2>&1; then
  action=update
else
  action=create
fi
gcloud tasks queues "$action" "$queue" --location="$region" "${common[@]}" \
  --max-concurrent-dispatches=2 --max-dispatches-per-second=2 --max-attempts=8 \
  --min-backoff=10s --max-backoff=300s --max-retry-duration=1800s --format='value(name)'
gcloud tasks queues add-iam-policy-binding "$queue" --location="$region" "${common[@]}" \
  --member="serviceAccount:$HOST_EXECUTION_SA" --role=roles/cloudtasks.enqueuer --format=none
gcloud iam service-accounts add-iam-policy-binding "$COMPLETION_DISPATCH_SA" "${common[@]}" \
  --member="serviceAccount:$HOST_EXECUTION_SA" --role=roles/iam.serviceAccountUser --format=none
gcloud run services add-iam-policy-binding hermes-host --region="$region" "${common[@]}" \
  --member="serviceAccount:$COMPLETION_DISPATCH_SA" --role=roles/run.invoker --format=none
# Secret content and versions are supplied separately by the operator, never printed here.
gcloud secrets add-iam-policy-binding "$COMPLETION_TOKEN_SECRET" "${common[@]}" \
  --member="serviceAccount:$HOST_EXECUTION_SA" --role=roles/secretmanager.secretAccessor --format=none
role_file="$(mktemp)"
trap 'rm -f "$role_file"' EXIT
cat > "$role_file" <<'YAML'
title: Hermes queue deployment control
stage: GA
includedPermissions:
- cloudtasks.queues.get
- cloudtasks.queues.pause
- cloudtasks.queues.resume
YAML
gcloud iam roles create hermesQueueDeployment --file="$role_file" "${common[@]}" --format=none 2>/dev/null || \
  gcloud iam roles update hermesQueueDeployment --file="$role_file" "${common[@]}" --format=none
for name in "$queue" "$GRAPH_QUEUE"; do
  gcloud tasks queues add-iam-policy-binding "$name" --location="$region" "${common[@]}" \
    --member="serviceAccount:github-hermes-cicd@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
    --role="projects/$GCP_PROJECT_ID/roles/hermesQueueDeployment" --format=none
done
gcloud secrets add-iam-policy-binding "$GRAPH_COMPLETION_TOKEN_SECRET" "${common[@]}" \
  --member="serviceAccount:$HOST_EXECUTION_SA" --role=roles/secretmanager.secretAccessor --format=none
# RunJob does not download the Scheduler's business token to the CI runner.
cat > "$role_file" <<'YAML'
title: Hermes reconciliation evidence
stage: GA
includedPermissions:
- cloudscheduler.jobs.run
- logging.logEntries.list
YAML
gcloud iam roles create hermesReconciliationEvidence --file="$role_file" "${common[@]}" --format=none 2>/dev/null || \
  gcloud iam roles update hermesReconciliationEvidence --file="$role_file" "${common[@]}" --format=none
gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" --quiet \
  --member="serviceAccount:github-hermes-cicd@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
  --role="projects/$GCP_PROJECT_ID/roles/hermesReconciliationEvidence" --format=none
echo 'Infrastructure applied. No feature activation, Job execution or Scheduler changes performed.'
