#!/usr/bin/env bash
# One-time infrastructure setup for jiangweitaiwan/hermes_agui. Requires a project IAM administrator.
set -euo pipefail
project=copilotkit-agui
project_number=746997613973
ci_sa="github-hermes-build@${project}.iam.gserviceaccount.com"
deploy_sa="github-hermes-deploy@${project}.iam.gserviceaccount.com"
smoke_sa="github-hermes-smoke@${project}.iam.gserviceaccount.com"
build_sa="hermes-build-executor@${project}.iam.gserviceaccount.com"
pool=github-hermes
provider=github
repo_id=1456731156
owner_id=108518895
bucket=copilotkit-agui-hermes-data

actual_number="$(gcloud projects describe "$project" --format='value(projectNumber)')"
[[ "$actual_number" == "$project_number" ]]
gcloud services enable cloudbuild.googleapis.com artifactregistry.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com run.googleapis.com --project="$project" --quiet

for account in "$ci_sa" "$deploy_sa" "$smoke_sa" "$build_sa"; do
  existing="$(gcloud iam service-accounts list --project="$project" --filter="email=${account}" --format='value(email)')"
  if [[ -z "$existing" ]]; then
    gcloud iam service-accounts create "${account%%@*}" --project="$project" --quiet
  fi
done
existing="$(gcloud iam workload-identity-pools list --project="$project" --location=global \
  --filter="name:/${pool}" --format='value(name)')"
if [[ -z "$existing" ]]; then
  gcloud iam workload-identity-pools create "$pool" --project="$project" \
    --location=global --display-name='Hermes GitHub Actions' --quiet
fi
condition="assertion.repository_id == '${repo_id}' && assertion.repository_owner_id == '${owner_id}' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == 'jiangweitaiwan/hermes_agui/.github/workflows/llm-images.yml@refs/heads/main' && (assertion.sub == 'repo:jiangweitaiwan/hermes_agui:environment:llm-build' || assertion.sub == 'repo:jiangweitaiwan/hermes_agui:environment:llm-deploy')"
existing="$(gcloud iam workload-identity-pools providers list --project="$project" --location=global \
  --workload-identity-pool="$pool" --filter="name:/${provider}" --format='value(name)')"
if [[ -z "$existing" ]]; then
  gcloud iam workload-identity-pools providers create-oidc "$provider" --project="$project" \
    --location=global --workload-identity-pool="$pool" \
    --issuer-uri=https://token.actions.githubusercontent.com \
    --attribute-mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref' \
    --attribute-condition="$condition" --quiet
else
  actual_condition="$(gcloud iam workload-identity-pools providers describe "$provider" \
    --project="$project" --location=global --workload-identity-pool="$pool" --format='value(attributeCondition)')"
  [[ "$actual_condition" == "$condition" ]] || { echo 'Existing provider condition differs; review before changing trust.' >&2; exit 1; }
fi

for binding in "llm-build:$ci_sa" "llm-deploy:$deploy_sa"; do
  environment="${binding%%:*}"
  account="${binding#*:}"
  gcloud iam service-accounts add-iam-policy-binding "$account" --project="$project" \
    --role=roles/iam.workloadIdentityUser \
    --member="principal://iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${pool}/subject/repo:jiangweitaiwan/hermes_agui:environment:${environment}" \
    --condition=None --quiet > /dev/null
done
for role in roles/cloudbuild.builds.editor roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$project" --member="serviceAccount:${ci_sa}" \
    --role="$role" --condition=None --quiet > /dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$build_sa" --project="$project" \
  --member="serviceAccount:${ci_sa}" --role=roles/iam.serviceAccountUser --condition=None --quiet > /dev/null
for account in "hermes-runtime@${project}.iam.gserviceaccount.com" \
  "hermes-host@${project}.iam.gserviceaccount.com" "hermes-worker@${project}.iam.gserviceaccount.com"; do
  gcloud iam service-accounts add-iam-policy-binding "$account" --project="$project" \
    --member="serviceAccount:${deploy_sa}" --role=roles/iam.serviceAccountUser --condition=None --quiet > /dev/null
done
for service in hermes-runtime hermes-host hermes-worker; do
  gcloud run services add-iam-policy-binding "$service" --project="$project" --region=asia-east1 \
    --member="serviceAccount:${deploy_sa}" --role=roles/run.developer --condition=None --quiet > /dev/null
  gcloud run services add-iam-policy-binding "$service" --project="$project" --region=asia-east1 \
    --member="serviceAccount:${smoke_sa}" --role=roles/run.invoker --condition=None --quiet > /dev/null
done
for job in hermes-completion hermes-reconcile; do
  gcloud run jobs add-iam-policy-binding "$job" --project="$project" --region=asia-east1 \
    --member="serviceAccount:${deploy_sa}" --role=roles/run.developer --condition=None --quiet > /dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$smoke_sa" --project="$project" \
  --member="serviceAccount:${deploy_sa}" --role=roles/iam.serviceAccountOpenIdTokenCreator --condition=None --quiet > /dev/null
for grant in "${deploy_sa}:roles/artifactregistry.reader" "${build_sa}:roles/artifactregistry.writer"; do
  account="${grant%%:*}"
  role="${grant#*:}"
  gcloud artifacts repositories add-iam-policy-binding hermes --project="$project" --location=asia-east1 \
    --member="serviceAccount:${account}" --role="$role" --condition=None --quiet > /dev/null
done
gcloud projects add-iam-policy-binding "$project" --member="serviceAccount:${build_sa}" \
  --role=roles/logging.logWriter --condition=None --quiet > /dev/null

# CI can inspect bucket metadata/list names, but can read/write object contents only
# under llm-source/. No CI object delete permission is granted on application data.
source_condition="expression=resource.name.startsWith('projects/_/buckets/${bucket}/objects/llm-source/'),title=hermes-build-source"
gcloud storage buckets add-iam-policy-binding "gs://${bucket}" --member="serviceAccount:${ci_sa}" \
  --role=roles/storage.legacyBucketReader --condition=None --quiet > /dev/null
for role in roles/storage.objectCreator roles/storage.objectViewer; do
  gcloud storage buckets add-iam-policy-binding "gs://${bucket}" --member="serviceAccount:${ci_sa}" \
    --role="$role" --condition="$source_condition" --quiet > /dev/null
done
gcloud storage buckets add-iam-policy-binding "gs://${bucket}" --member="serviceAccount:${build_sa}" \
  --role=roles/storage.objectViewer --condition="$source_condition" --quiet > /dev/null

echo "WIF provider: projects/${project_number}/locations/global/workloadIdentityPools/${pool}/providers/${provider}"
echo "Build submit: ${ci_sa}; executor: ${build_sa}; deploy: ${deploy_sa}; smoke: ${smoke_sa}"
echo "Review and revoke obsolete shared CI IAM separately; this script does not remove existing grants."
