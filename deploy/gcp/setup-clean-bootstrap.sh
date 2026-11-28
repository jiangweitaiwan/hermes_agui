#!/usr/bin/env bash
# Operator-only provisioning support. No reset, migration, service deploy or queue purge.
set -euo pipefail
mode="${1:-check}"
[[ "$mode" == check || "$mode" == apply ]] || { echo 'Usage: setup-clean-bootstrap.sh check|apply' >&2; exit 2; }
: "${GCP_PROJECT_ID:?}" "${CLEAN_JOURNAL_BUCKET:?}" "${CLEAN_PREPARATION_SA:?}" "${CLEAN_APPLICATION_SA:?}" "${GCP_DEPLOY_SERVICE_ACCOUNT:?}"
[[ "$GCP_PROJECT_ID" == copilotkit-agui ]] || exit 2
for account in "$CLEAN_PREPARATION_SA" "$CLEAN_APPLICATION_SA" "$GCP_DEPLOY_SERVICE_ACCOUNT"; do
  [[ "$account" =~ ^[a-zA-Z0-9._-]+@copilotkit-agui\.iam\.gserviceaccount\.com$ ]] || exit 2
done
[[ "$CLEAN_PREPARATION_SA" != "$CLEAN_APPLICATION_SA" && "$CLEAN_PREPARATION_SA" != "$GCP_DEPLOY_SERVICE_ACCOUNT" && "$CLEAN_APPLICATION_SA" != "$GCP_DEPLOY_SERVICE_ACCOUNT" ]] || exit 2
common=(--project="$GCP_PROJECT_ID" --quiet)
if [[ "$mode" == check ]]; then
  gcloud storage buckets describe "gs://$CLEAN_JOURNAL_BUCKET" --format=json
  for name in "$CLEAN_PREPARATION_SA" "$CLEAN_APPLICATION_SA"; do
    gcloud iam service-accounts describe "$name" "${common[@]}" --format='value(email)'
  done
  echo 'Review scoped Secret access, old role inventory and application binding hash before apply/dispatch.'
  exit
fi
for account in "$CLEAN_PREPARATION_SA" "$CLEAN_APPLICATION_SA"; do
  if ! gcloud iam service-accounts describe "$account" "${common[@]}" --format='value(email)' >/dev/null 2>&1; then
    gcloud iam service-accounts create "${account%%@*}" "${common[@]}" --display-name='Hermes clean bootstrap identity' --format=none
  fi
  gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" --member="serviceAccount:$account" --role=roles/cloudsql.client --condition=None --quiet --format=none
  gcloud iam service-accounts add-iam-policy-binding "$account" "${common[@]}" --member="serviceAccount:$GCP_DEPLOY_SERVICE_ACCOUNT" --role=roles/iam.serviceAccountUser --format=none
 done
# CAS overwrite needs delete, but only inside this dedicated non-application prefix.
role=hermesCleanJournal
if gcloud iam roles describe "$role" "${common[@]}" >/dev/null 2>&1; then action=update; else action=create; fi
gcloud iam roles "$action" "$role" "${common[@]}" --title='Hermes deployment journal CAS' \
  --permissions=storage.objects.get,storage.objects.create,storage.objects.delete --stage=GA --format=none
condition="expression=resource.name.startsWith('projects/_/buckets/${CLEAN_JOURNAL_BUCKET}/objects/deployment-journal/clean/'),title=hermes-clean-journal"
gcloud storage buckets add-iam-policy-binding "gs://$CLEAN_JOURNAL_BUCKET" --member="serviceAccount:$GCP_DEPLOY_SERVICE_ACCOUNT" \
  --role="projects/$GCP_PROJECT_ID/roles/$role" --condition="$condition" --quiet --format=none
gcloud services enable policytroubleshooter.googleapis.com "${common[@]}" --format=none
gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" --member="serviceAccount:$GCP_DEPLOY_SERVICE_ACCOUNT" \
  --role=roles/policytroubleshooter.iamTroubleshooter --condition=None --quiet --format=none
# Do not revoke broad legacy IAM automatically: it may also serve unrelated workloads.
echo 'Core identities/journal provisioning complete. Follow CICD_CLEAN_BOOTSTRAP_REPORT.md for scoped Secret, queue, scheduler and DB provision Job bindings.'
