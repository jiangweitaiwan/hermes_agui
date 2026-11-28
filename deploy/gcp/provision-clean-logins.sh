#!/usr/bin/env bash
# Operator-only, one-time permissions/credential provisioning. Never resets data.
set -euo pipefail
: "${GCP_PROJECT_ID:?}" "${GCP_DATABASE_JOB:?Existing preparation Job with the new Runtime image}"
: "${CLEAN_PREPARATION_SA:?}" "${CLEAN_APPLICATION_SA:?}" "${CLEAN_SECURITY_ADMIN_SECRET:?name:numeric-version}"
: "${CLEAN_PROVISION_CONFIG:?Non-secret JSON project/instance/hostOwner/secrets}"
[[ "$GCP_PROJECT_ID" == copilotkit-agui && "$CLEAN_SECURITY_ADMIN_SECRET" =~ ^[a-zA-Z0-9_-]+:[1-9][0-9]*$ ]] || exit 2
region="${GCP_BUILD_REGION:-asia-east1}"
common=(--project="$GCP_PROJECT_ID" --quiet)
# Validate via the same fixed inventory, without evaluating any JSON as shell code.
mapfile -t secrets < <(python3 - <<'PY'
import json, os, re
c=json.loads(os.environ['CLEAN_PROVISION_CONFIG'])
roles={'hermes_host','hermes_runtime','hermes_llm_admin','hermes_llm_runtime','hermes_llm_reader','hermes_llm_host_reader'}
assert set(c)=={'project','instance','hostOwner','secrets'} and c['project']=='copilotkit-agui'
assert set(c['secrets'])==roles
assert len(set(c['secrets'].values()))==len(roles)
assert all(re.fullmatch(r'[a-zA-Z0-9_-]+',s) for s in c['secrets'].values())
assert '|' not in os.environ['CLEAN_PROVISION_CONFIG']
print('\n'.join(c['secrets'].values()))
PY
)
[[ "${#secrets[@]}" == 6 ]] || { echo 'Invalid clean provisioning config' >&2; exit 2; }
for secret in "${secrets[@]}"; do
  if ! gcloud secrets describe "$secret" "${common[@]}" --format='value(name)' >/dev/null 2>&1; then
    gcloud secrets create "$secret" "${common[@]}" --replication-policy=automatic --format=none
  fi
  for account in "$CLEAN_PREPARATION_SA" "$CLEAN_APPLICATION_SA"; do
    gcloud secrets add-iam-policy-binding "$secret" "${common[@]}" --member="serviceAccount:$account" --role=roles/secretmanager.secretAccessor --format=none
  done
  gcloud secrets add-iam-policy-binding "$secret" "${common[@]}" --member="serviceAccount:$CLEAN_PREPARATION_SA" --role=roles/secretmanager.secretVersionAdder --format=none
done
admin_secret="${CLEAN_SECURITY_ADMIN_SECRET%%:*}"
cleanup() {
  gcloud run jobs update "$GCP_DATABASE_JOB" "${common[@]}" --region="$region" --remove-secrets=AGUI_PROVISION_DATABASE_URL --format=none
  gcloud secrets remove-iam-policy-binding "$admin_secret" "${common[@]}" --member="serviceAccount:$CLEAN_PREPARATION_SA" --role=roles/secretmanager.secretAccessor --format=none
}
trap cleanup EXIT
gcloud secrets add-iam-policy-binding "$admin_secret" "${common[@]}" --member="serviceAccount:$CLEAN_PREPARATION_SA" --role=roles/secretmanager.secretAccessor --format=none
gcloud run jobs update "$GCP_DATABASE_JOB" "${common[@]}" --region="$region" --service-account="$CLEAN_PREPARATION_SA" \
  --update-secrets="AGUI_PROVISION_DATABASE_URL=$CLEAN_SECURITY_ADMIN_SECRET" --format=none
gcloud run jobs execute "$GCP_DATABASE_JOB" "${common[@]}" --region="$region" --wait \
  --args=--import,tsx,server/storage/provision-clean.ts \
  --update-env-vars="^|^CLEAN_PROVISION_CONFIG=$CLEAN_PROVISION_CONFIG" --format='value(metadata.name)'
echo 'Read role/secretVersion receipts in this execution logs; mount those numeric versions in the preparation Job and LLM_CLEAN_APPLICATION_BINDINGS. Credentials were never returned to the operator/CI.'
