#!/usr/bin/env bash
set -euo pipefail

project="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
region="${GCP_REGION:?Set GCP_REGION}"
job="${CLOUD_RUN_RECORDING_CLEANUP_JOB:?Set CLOUD_RUN_RECORDING_CLEANUP_JOB}"

# readiness が非0なら、Terraform applyは一切呼ばない。
gcloud run jobs execute "$job" --project "$project" --region "$region" \
  --args=worker/recording-cleanup.ts,--verify-lifecycle-readiness --wait

terraform -chdir=infra/gcp apply -auto-approve \
  -var="source_recording_lifecycle_enabled=true"
