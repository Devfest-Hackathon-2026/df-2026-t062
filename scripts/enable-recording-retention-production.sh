#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
project="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
region="${GCP_REGION:?Set GCP_REGION}"
job="${CLOUD_RUN_RECORDING_CLEANUP_JOB:?Set CLOUD_RUN_RECORDING_CLEANUP_JOB}"
channels="${MONITORING_NOTIFICATION_CHANNEL_IDS:?Set MONITORING_NOTIFICATION_CHANNEL_IDS as comma-separated resource names}"
apply="${APPLY:-false}"
enable_scheduler="${ENABLE_RECORDING_CLEANUP_SCHEDULER:-true}"
enable_lifecycle="${ENABLE_SOURCE_LIFECYCLE:-false}"
plan_path="${TF_PLAN_PATH:-$(mktemp "${TMPDIR:-/tmp}/recording-retention.XXXXXX.tfplan")}"

cleanup() {
  if [[ -z "${TF_PLAN_PATH:-}" ]]; then rm -f "$plan_path"; fi
}
trap cleanup EXIT

for command in gcloud jq terraform; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is not available: $command" >&2
    exit 127
  }
done

if [[ "$channels" == *\"* || "$channels" == *"'"* || "$channels" == *" "* ]]; then
  echo "MONITORING_NOTIFICATION_CHANNEL_IDS must not contain quotes or spaces" >&2
  exit 2
fi

channel_json="$(printf '%s' "$channels" | jq -Rsc 'split(",") | map(select(length > 0))')"
if [[ "$(jq 'length' <<< "$channel_json")" -eq 0 ]]; then
  echo "At least one Monitoring notification channel is required" >&2
  exit 2
fi
while IFS= read -r channel; do
  [[ "$channel" == "projects/$project/notificationChannels/"* ]] || {
    echo "Notification channel must belong to GCP_PROJECT_ID: $channel" >&2
    exit 2
  }
  [[ "$channel" =~ ^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/notificationChannels/[0-9]+$ ]] || {
    echo "Invalid Monitoring notification channel: $channel" >&2
    exit 2
  }
done < <(jq -r '.[]' <<< "$channel_json")

case "$enable_scheduler" in true|false) ;; *) echo "ENABLE_RECORDING_CLEANUP_SCHEDULER must be true or false" >&2; exit 2 ;; esac
case "$enable_lifecycle" in true|false) ;; *) echo "ENABLE_SOURCE_LIFECYCLE must be true or false" >&2; exit 2 ;; esac
case "$apply" in true|false) ;; *) echo "APPLY must be true or false" >&2; exit 2 ;; esac
if [[ "$enable_lifecycle" == true && "$enable_scheduler" != true ]]; then
  echo "ENABLE_SOURCE_LIFECYCLE=true requires ENABLE_RECORDING_CLEANUP_SCHEDULER=true" >&2
  exit 2
fi

scheduler_paused=true
if [[ "$enable_scheduler" == true ]]; then
  scheduler_paused=false
fi

echo "Checking recording retention readiness before Terraform changes"
gcloud run jobs execute "$job" --project "$project" --region "$region" \
  --args=worker/recording-cleanup.ts,--verify-lifecycle-readiness --wait

terraform_args=(
  -input=false
  -var="recording_cleanup_alerts_enabled=true"
  -var="monitoring_notification_channel_ids=$channel_json"
  -var="recording_cleanup_scheduler_paused=$scheduler_paused"
  -var="source_recording_lifecycle_enabled=$enable_lifecycle"
)

terraform -chdir="$repo_root/infra/gcp" plan "${terraform_args[@]}" -out="$plan_path"
if [[ "$apply" != true ]]; then
  echo "Plan only. Review the plan, then rerun with APPLY=true to apply it."
  exit 0
fi

terraform -chdir="$repo_root/infra/gcp" apply -input=false "$plan_path"
echo "Recording retention production controls are enabled. Verify the first Scheduler run and alert delivery."
