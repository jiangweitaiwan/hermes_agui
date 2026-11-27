#!/usr/bin/env bash
# Operator-only provisioning. Never called by GitHub Actions; does not execute Jobs/SQL.
set -euo pipefail
: "${GCP_PROJECT_ID:?}" "${CLOUD_SQL_INSTANCE:?}"
: "${HOST_IMAGE:?Existing immutable Host image}" "${RUNTIME_IMAGE:?Existing immutable Runtime image}"
: "${HOST_OWNER_SECRET:?secret-name:numeric-version}" "${RUNTIME_OWNER_SECRET:?secret-name:numeric-version}"
: "${LLM_ADMIN_SECRET:?secret-name:numeric-version}" "${RUNTIME_CONFIG_SECRET:?secret-name:numeric-version}"
region="${GCP_BUILD_REGION:-asia-east1}"
account="github-hermes-cicd@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
for value in "$HOST_IMAGE" "$RUNTIME_IMAGE"; do
  [[ "$value" =~ @sha256:[a-f0-9]{64}$ ]] || { echo 'Immutable image digest required' >&2; exit 1; }
done
for value in "$HOST_OWNER_SECRET" "$RUNTIME_OWNER_SECRET" "$LLM_ADMIN_SECRET" "$RUNTIME_CONFIG_SECRET"; do
  [[ "$value" =~ ^[a-zA-Z0-9_-]+:[1-9][0-9]*$ ]] || { echo 'Pinned Secret Manager version required' >&2; exit 1; }
done
# Pass the same --network / --subnet / --vpc-egress flags used by the existing
# Cloud SQL-connected services as this script's arguments, where applicable.
gcloud run jobs deploy hermes-host-migrate \
  --project="$GCP_PROJECT_ID" --region="$region" --image="$HOST_IMAGE" \
  --service-account="$account" --set-cloudsql-instances="$CLOUD_SQL_INSTANCE" \
  --command=python --args=-m,hermes_agui.storage.migrate \
  --set-env-vars=AGUI_APPLY_DATABASE_GRANTS=true \
  --set-secrets="AGUI_HOST_DATABASE_URL=${HOST_OWNER_SECRET}" \
  --tasks=1 --parallelism=1 --max-retries=0 --task-timeout=900s --cpu=1 --memory=1Gi \
  "$@" --quiet

gcloud run jobs deploy hermes-database-prepare \
  --project="$GCP_PROJECT_ID" --region="$region" --image="$RUNTIME_IMAGE" \
  --service-account="$account" --set-cloudsql-instances="$CLOUD_SQL_INSTANCE" \
  --command=node --args=--import,tsx,server/storage/deployment-cli.ts,check \
  --set-env-vars=RUNTIME_CONFIG=/etc/hermes/runtime.json \
  --set-secrets="/etc/hermes/runtime.json=${RUNTIME_CONFIG_SECRET},AGUI_HOST_DATABASE_URL=${HOST_OWNER_SECRET},AGUI_RUNTIME_DATABASE_URL=${RUNTIME_OWNER_SECRET},AGUI_LLM_ADMIN_DATABASE_URL=${LLM_ADMIN_SECRET}" \
  --tasks=1 --parallelism=1 --max-retries=0 --task-timeout=900s --cpu=1 --memory=1Gi \
  "$@" --quiet
