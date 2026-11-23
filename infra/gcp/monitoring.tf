
locals {
  recording_cleanup_log_filter = join(" AND ", [
    "resource.type=\"cloud_run_job\"",
    "resource.labels.job_name=\"${var.recording_cleanup_job_name}\"",
    "jsonPayload.service=\"recording-cleanup\"",
  ])
  ai_job_log_filter = join(" AND ", [
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=\"${var.worker_service_name}\"",
    "jsonPayload.service=\"worker\"",
  ])
}

resource "terraform_data" "recording_cleanup_alert_configuration" {
  input = {
    enabled = var.recording_cleanup_alerts_enabled
  }

  lifecycle {
    precondition {
      condition     = !var.recording_cleanup_alerts_enabled || length(var.monitoring_notification_channel_ids) > 0
      error_message = "Enable recording cleanup alerts only when monitoring_notification_channel_ids is configured."
    }

    precondition {
      condition     = !var.source_recording_lifecycle_enabled || !var.recording_cleanup_scheduler_paused
      error_message = "The source recording Lifecycle safety net requires the recording cleanup Scheduler to be active."
    }

    precondition {
      condition     = !var.source_recording_lifecycle_enabled || var.recording_cleanup_alerts_enabled
      error_message = "The source recording Lifecycle safety net requires recording cleanup alerts to be enabled."
    }
  }
}

resource "terraform_data" "ai_job_alert_configuration" {
  input = {
    enabled = var.ai_job_alerts_enabled
  }

  lifecycle {
    precondition {
      condition     = !var.ai_job_alerts_enabled || length(var.monitoring_notification_channel_ids) > 0
      error_message = "Enable AI job alerts only when monitoring_notification_channel_ids is configured."
    }
  }
}

# =========================================================
# Cloud Logging Metrics
# =========================================================

resource "google_logging_metric" "recording_cleanup_success" {
  name            = "recording_cleanup_success_count"
  filter          = "${local.recording_cleanup_log_filter} AND jsonPayload.event=\"recording.retention.cleanup\" AND jsonPayload.result=\"success\""
  value_extractor = "EXTRACT(jsonPayload.success_count)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "recording_cleanup_failure" {
  name            = "recording_cleanup_failure_count"
  filter          = "${local.recording_cleanup_log_filter} AND jsonPayload.event=\"recording.retention.cleanup\" AND jsonPayload.result=\"failed\""
  value_extractor = "EXTRACT(jsonPayload.failure_count)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "recording_cleanup_overdue" {
  name            = "recording_cleanup_overdue_count"
  filter          = "${local.recording_cleanup_log_filter} AND jsonPayload.event=\"recording.retention.overdue\" AND jsonPayload.result=\"detected\""
  value_extractor = "EXTRACT(jsonPayload.overdue_count)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "recording_cleanup_hold_mismatch" {
  name            = "recording_cleanup_hold_mismatch_count"
  filter          = "${local.recording_cleanup_log_filter} AND jsonPayload.event=\"recording.retention.hold_mismatch\" AND jsonPayload.result=\"detected\""
  value_extractor = "EXTRACT(jsonPayload.hold_alert_count)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "recording_cleanup_final_failure" {
  name            = "recording_cleanup_final_failure_count"
  filter          = "${local.recording_cleanup_log_filter} AND jsonPayload.event=\"recording.retention.delete\" AND jsonPayload.result=\"failed\" AND jsonPayload.retryable=false"
  value_extractor = "EXTRACT(jsonPayload.failure_count)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "recording_cleanup_retry" {
  name            = "recording_cleanup_retry_count"
  filter          = "${local.recording_cleanup_log_filter} AND jsonPayload.event=\"recording.retention.delete\" AND jsonPayload.result=\"failed\" AND jsonPayload.retryable=true"
  value_extractor = "EXTRACT(jsonPayload.failure_count)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "recording_cleanup_stuck" {
  name            = "recording_cleanup_stuck_count"
  filter          = "${local.recording_cleanup_log_filter} AND jsonPayload.event=\"recording.retention.cleanup\" AND (jsonPayload.eligible_stuck_count > 0 OR jsonPayload.deleting_stuck_count > 0 OR jsonPayload.failed_past_retry_count > 0 OR jsonPayload.intermediate_overdue_count > 0 OR jsonPayload.intermediate_stuck_count > 0 OR jsonPayload.intermediate_failed_past_retry_count > 0)"
  value_extractor = "EXTRACT(jsonPayload.stuck_count)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "recording_cleanup_hold_sync_failure" {
  name            = "recording_cleanup_hold_sync_failure_count"
  filter          = "${local.recording_cleanup_log_filter} AND jsonPayload.event=\"recording.retention.cleanup\" AND jsonPayload.hold_sync_failure_count > 0"
  value_extractor = "EXTRACT(jsonPayload.hold_sync_failure_count)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "recording_cleanup_verification_truncated" {
  name   = "recording_cleanup_hold_verification_truncated_count"
  filter = "${local.recording_cleanup_log_filter} AND jsonPayload.event=\"recording.retention.cleanup\" AND jsonPayload.hold_verification_truncated=true"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "recording_cleanup_failure_rate_breach" {
  name   = "recording_cleanup_failure_rate_breach_count"
  filter = "${local.recording_cleanup_log_filter} AND jsonPayload.event=\"recording.retention.cleanup\" AND jsonPayload.failure_count >= 3 AND jsonPayload.failure_rate_percent > 5"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "recording_cleanup_duration" {
  name            = "recording_cleanup_duration"
  filter          = "${local.recording_cleanup_log_filter} AND jsonPayload.event=\"recording.retention.cleanup\""
  value_extractor = "EXTRACT(jsonPayload.duration_ms)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }

  bucket_options {
    explicit_buckets {
      bounds = [
        1000,
        5000,
        10000,
        30000,
        60000,
        120000,
        300000,
        600000,
        900000,
      ]
    }
  }
}

resource "google_logging_metric" "recording_cleanup_scheduler_error" {
  name   = "recording_cleanup_scheduler_error_count"
  filter = "resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id=\"${var.recording_cleanup_scheduler_job_name}\" AND severity>=ERROR"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

# =========================================================
# AI job observability
# =========================================================

resource "google_logging_metric" "ai_job_success" {
  name   = "ai_job_success_count"
  filter = "${local.ai_job_log_filter} AND jsonPayload.event=\"ai.job\" AND jsonPayload.phase=\"succeeded\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "ai_job_partial" {
  name   = "ai_job_partial_count"
  filter = "${local.ai_job_log_filter} AND jsonPayload.event=\"ai.job\" AND jsonPayload.phase=\"partial\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "ai_job_failure" {
  name   = "ai_job_failure_count"
  filter = "${local.ai_job_log_filter} AND jsonPayload.event=\"ai.job\" AND jsonPayload.phase=\"failed\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "ai_job_retry" {
  name   = "ai_job_retry_count"
  filter = "${local.ai_job_log_filter} AND jsonPayload.event=\"ai.job\" AND jsonPayload.phase=\"retry\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "ai_job_lease_expired" {
  name   = "ai_job_lease_expired_count"
  filter = "${local.ai_job_log_filter} AND jsonPayload.event=\"ai.job\" AND jsonPayload.phase=\"lease_expired\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "ai_job_duration" {
  name            = "ai_job_duration"
  filter          = "${local.ai_job_log_filter} AND jsonPayload.event=\"ai.job\" AND jsonPayload.duration_ms >= 0"
  value_extractor = "EXTRACT(jsonPayload.duration_ms)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }

  bucket_options {
    explicit_buckets {
      bounds = [1000, 5000, 10000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000]
    }
  }
}

resource "google_logging_metric" "ai_job_queue_wait" {
  name            = "ai_job_queue_wait"
  filter          = "${local.ai_job_log_filter} AND jsonPayload.event=\"ai.job\" AND jsonPayload.queue_wait_ms >= 0"
  value_extractor = "EXTRACT(jsonPayload.queue_wait_ms)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }

  bucket_options {
    explicit_buckets {
      bounds = [1000, 5000, 10000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000]
    }
  }
}

resource "google_logging_metric" "ai_job_cost" {
  name            = "ai_job_estimated_cost_yen"
  filter          = "${local.ai_job_log_filter} AND jsonPayload.event=\"ai.job\" AND jsonPayload.estimated_cost_yen >= 0"
  value_extractor = "EXTRACT(jsonPayload.estimated_cost_yen)"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DOUBLE"
    unit        = "{JPY}"
  }
}

resource "google_logging_metric" "ai_job_backlog_age" {
  name            = "ai_job_backlog_age_seconds"
  filter          = "${local.ai_job_log_filter} AND jsonPayload.event=\"ai.queue\" AND jsonPayload.queue_oldest_queued_age_seconds >= 0"
  value_extractor = "EXTRACT(jsonPayload.queue_oldest_queued_age_seconds)"

  metric_descriptor {
    metric_kind = "GAUGE"
    value_type  = "INT64"
    unit        = "s"
  }
}

resource "google_logging_metric" "ai_job_processing_age" {
  name            = "ai_job_processing_age_seconds"
  filter          = "${local.ai_job_log_filter} AND jsonPayload.event=\"ai.queue\" AND jsonPayload.queue_oldest_processing_age_seconds >= 0"
  value_extractor = "EXTRACT(jsonPayload.queue_oldest_processing_age_seconds)"

  metric_descriptor {
    metric_kind = "GAUGE"
    value_type  = "INT64"
    unit        = "s"
  }
}

resource "google_logging_metric" "ai_job_queue_depth" {
  name            = "ai_job_queue_depth"
  filter          = "${local.ai_job_log_filter} AND jsonPayload.event=\"ai.queue\" AND jsonPayload.queue_queued_count >= 0"
  value_extractor = "EXTRACT(jsonPayload.queue_queued_count)"

  metric_descriptor {
    metric_kind = "GAUGE"
    value_type  = "INT64"
    unit        = "1"
  }
}

# =========================================================
# Cloud Monitoring Alert Policies
#
# アラート自体は常にTerraformで管理する。
# 初期状態では enabled=false にして停止する。
# =========================================================

resource "google_monitoring_alert_policy" "recording_cleanup_overdue" {
  display_name = "[${var.monitoring_environment}] Recording cleanup overdue"
  combiner     = "OR"
  enabled      = var.recording_cleanup_alerts_enabled

  documentation {
    content   = "録音原本の保持期限を超過した削除候補があります。Cloud Run Job、Cloud SQLの保全状態、GCS Object Holdを確認し、保全中の音声を手動削除しないでください。"
    mime_type = "text/markdown"
  }

  notification_channels = var.monitoring_notification_channel_ids

  conditions {
    display_name = "overdue cleanup report"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.recording_cleanup_overdue.name}\" resource.type=\"cloud_run_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "900s"

      aggregations {
        alignment_period   = "900s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "recording_cleanup_final_failure" {
  display_name = "[${var.monitoring_environment}] Recording cleanup final failure"
  combiner     = "OR"
  enabled      = var.recording_cleanup_alerts_enabled

  documentation {
    content   = "録音原本の削除が最終失敗しました。エラーコード、Cloud Run Job実行履歴、GCS IAM、Cloud SQLの状態をRunbookに従って確認してください。"
    mime_type = "text/markdown"
  }

  notification_channels = var.monitoring_notification_channel_ids

  conditions {
    display_name = "final deletion failure"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.recording_cleanup_final_failure.name}\" resource.type=\"cloud_run_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "recording_cleanup_hold_mismatch" {
  display_name = "[${var.monitoring_environment}] Recording hold mismatch"
  combiner     = "OR"
  enabled      = var.recording_cleanup_alerts_enabled

  documentation {
    content   = "DBの保全状態とGCS Object Holdが一致しません。DB側の保全解除や音声削除を先に行わず、GCSメタデータとCloud Run Jobログを確認してください。"
    mime_type = "text/markdown"
  }

  notification_channels = var.monitoring_notification_channel_ids

  conditions {
    display_name = "DB and GCS hold mismatch"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.recording_cleanup_hold_mismatch.name}\" resource.type=\"cloud_run_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "recording_cleanup_failure_rate" {
  display_name = "[${var.monitoring_environment}] Recording cleanup failure rate"
  combiner     = "OR"
  enabled      = var.recording_cleanup_alerts_enabled

  documentation {
    content   = "1時間以内に録音削除の失敗率が5%を超え、3件以上の失敗が発生しました。"
    mime_type = "text/markdown"
  }

  notification_channels = var.monitoring_notification_channel_ids

  conditions {
    display_name = "failure rate breach"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.recording_cleanup_failure_rate_breach.name}\" resource.type=\"cloud_run_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "3600s"

      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "recording_cleanup_stuck" {
  display_name = "[${var.monitoring_environment}] Recording cleanup state stuck"
  combiner     = "OR"
  enabled      = var.recording_cleanup_alerts_enabled

  documentation {
    content   = "Cloud SQL上で録音削除状態が滞留しています。eligible/deleting/failedの件数と最終エラーを確認してください。"
    mime_type = "text/markdown"
  }

  notification_channels = var.monitoring_notification_channel_ids

  conditions {
    display_name = "stuck cleanup state"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.recording_cleanup_stuck.name}\" resource.type=\"cloud_run_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "900s"

      aggregations {
        alignment_period   = "900s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "recording_cleanup_hold_sync_failure" {
  display_name = "[${var.monitoring_environment}] Recording hold synchronization failure"
  combiner     = "OR"
  enabled      = var.recording_cleanup_alerts_enabled

  documentation {
    content   = "録音のDB保全状態とGCS Object Holdの同期が失敗または長期滞留しています。保全中の音声を削除せず、GCSとDBを確認してください。"
    mime_type = "text/markdown"
  }

  notification_channels = var.monitoring_notification_channel_ids

  conditions {
    display_name = "hold synchronization failure"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.recording_cleanup_hold_sync_failure.name}\" resource.type=\"cloud_run_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "900s"

      aggregations {
        alignment_period   = "900s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "recording_cleanup_verification_truncated" {
  display_name = "[${var.monitoring_environment}] Recording hold verification truncated"
  combiner     = "OR"
  enabled      = var.recording_cleanup_alerts_enabled

  documentation {
    content   = "GCS Object Holdの全件照合がJobの上限時間またはページ上限に達しました。監視対象が未確認のまま残っている可能性があります。"
    mime_type = "text/markdown"
  }

  notification_channels = var.monitoring_notification_channel_ids

  conditions {
    display_name = "hold verification truncated"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.recording_cleanup_verification_truncated.name}\" resource.type=\"cloud_run_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "900s"

      aggregations {
        alignment_period   = "900s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "recording_cleanup_no_success" {
  display_name = "[${var.monitoring_environment}] Recording cleanup has no recent success"
  combiner     = "OR"
  enabled      = var.recording_cleanup_alerts_enabled

  documentation {
    content   = "2時間以内に録音削除Jobの成功ログがありません。Scheduler、Cloud Run Job、Cloud SQLを順番に確認してください。"
    mime_type = "text/markdown"
  }

  notification_channels = var.monitoring_notification_channel_ids

  conditions {
    display_name = "no successful cleanup report"

    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.recording_cleanup_success.name}\" resource.type=\"cloud_run_job\""
      duration = "7200s"
    }
  }
}

resource "google_monitoring_alert_policy" "recording_cleanup_scheduler_error" {
  display_name = "[${var.monitoring_environment}] Recording cleanup Scheduler error"
  combiner     = "OR"
  enabled      = var.recording_cleanup_alerts_enabled

  documentation {
    content   = "録音削除用Cloud Schedulerの実行エラーです。Schedulerの実行履歴、OAuth権限、Cloud Run Jobの起動状態を確認してください。"
    mime_type = "text/markdown"
  }

  notification_channels = var.monitoring_notification_channel_ids

  conditions {
    display_name = "Scheduler execution error"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.recording_cleanup_scheduler_error.name}\" resource.type=\"cloud_scheduler_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "ai_job_failure" {
  display_name = "[${var.monitoring_environment}] AI job failures"
  combiner     = "OR"
  enabled      = var.ai_job_alerts_enabled

  documentation {
    content   = "AI非同期ジョブの最終失敗が直近1時間に3件以上あります。個人情報をログ検索せず、AI処理監視Runbookに従ってジョブ状態・安全なエラーコード・Workerを確認してください。"
    mime_type = "text/markdown"
  }

  notification_channels = var.monitoring_notification_channel_ids

  conditions {
    display_name = "AI job failures"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_job_failure.name}\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2
      duration        = "3600s"

      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "ai_job_backlog" {
  display_name = "[${var.monitoring_environment}] AI job backlog"
  combiner     = "OR"
  enabled      = var.ai_job_alerts_enabled

  documentation {
    content   = "AIジョブの最古queued滞留が閾値を超えています。Cloud Tasks、Worker、Cloud SQLのジョブ状態を確認してください。"
    mime_type = "text/markdown"
  }

  notification_channels = var.monitoring_notification_channel_ids

  conditions {
    display_name = "oldest queued AI job"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_job_backlog_age.name}\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.ai_job_backlog_age_threshold_seconds
      duration        = "0s"

      aggregations {
        alignment_period   = "900s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "ai_job_processing_stuck" {
  display_name = "[${var.monitoring_environment}] AI job processing stuck"
  combiner     = "OR"
  enabled      = var.ai_job_alerts_enabled

  documentation {
    content   = "processing状態のAIジョブが長時間滞留しています。Worker、Cloud Tasks、Vertex AIの状態とDBのlease_untilを確認してください。"
    mime_type = "text/markdown"
  }

  notification_channels = var.monitoring_notification_channel_ids

  conditions {
    display_name = "oldest processing AI job"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_job_processing_age.name}\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.ai_job_processing_age_threshold_seconds
      duration        = "0s"

      aggregations {
        alignment_period   = "900s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "ai_job_cost" {
  display_name = "[${var.monitoring_environment}] AI estimated cost spike"
  combiner     = "OR"
  enabled      = var.ai_job_alerts_enabled

  documentation {
    content   = "24時間のAI費用推定値が閾値を超えています。これは請求額ではないため、Cloud Billingと処理件数を併せて確認してください。"
    mime_type = "text/markdown"
  }

  notification_channels = var.monitoring_notification_channel_ids

  conditions {
    display_name = "estimated AI cost"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_job_cost.name}\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.ai_job_cost_alert_yen
      duration        = "86400s"

      aggregations {
        alignment_period   = "86400s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

# =========================================================
# Cloud Monitoring Dashboard
# =========================================================

resource "google_monitoring_dashboard" "recording_cleanup" {
  dashboard_json = jsonencode({
    displayName = "[${var.monitoring_environment}] Recording retention cleanup"

    gridLayout = {
      columns = 2

      widgets = [
        {
          title = "Cleanup success and failure"

          xyChart = {
            dataSets = [
              for metric in [
                google_logging_metric.recording_cleanup_success.name,
                google_logging_metric.recording_cleanup_failure.name
                ] : {
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${metric}\" resource.type=\"cloud_run_job\""
                  }
                }
              }
            ]
          }
        },
        {
          title = "Overdue and hold mismatch"

          xyChart = {
            dataSets = [
              for metric in [
                google_logging_metric.recording_cleanup_overdue.name,
                google_logging_metric.recording_cleanup_hold_mismatch.name
                ] : {
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${metric}\" resource.type=\"cloud_run_job\""
                  }
                }
              }
            ]
          }
        },
        {
          title = "Cleanup duration"

          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.recording_cleanup_duration.name}\" resource.type=\"cloud_run_job\""
                }
              }
            }]
          }
        },
      ]
    }
  })
}

resource "google_monitoring_dashboard" "ai_jobs" {
  dashboard_json = jsonencode({
    displayName = "[${var.monitoring_environment}] AI job operations"

    gridLayout = {
      columns = 2

      widgets = [
        {
          title = "AI job outcome"
          xyChart = {
            dataSets = [
              for metric in [
                google_logging_metric.ai_job_success.name,
                google_logging_metric.ai_job_partial.name,
                google_logging_metric.ai_job_failure.name,
                google_logging_metric.ai_job_retry.name,
                ] : {
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${metric}\" resource.type=\"cloud_run_revision\""
                  }
                }
              }
            ]
          }
        },
        {
          title = "AI job duration"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_job_duration.name}\" resource.type=\"cloud_run_revision\""
                }
              }
            }]
          }
        },
        {
          title = "AI queue wait"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_job_queue_wait.name}\" resource.type=\"cloud_run_revision\""
                }
              }
            }]
          }
        },
        {
          title = "AI queue backlog"
          xyChart = {
            dataSets = [
              for metric in [
                google_logging_metric.ai_job_queue_depth.name,
                google_logging_metric.ai_job_backlog_age.name,
                google_logging_metric.ai_job_processing_age.name,
                ] : {
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${metric}\" resource.type=\"cloud_run_revision\""
                  }
                }
              }
            ]
          }
        },
        {
          title = "Estimated AI cost"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_job_cost.name}\" resource.type=\"cloud_run_revision\""
                }
              }
            }]
          }
        },
      ]
    }
  })
}

# =========================================================
# Terraform State Migration
#
# 以前 count = 1 で作成された既存アラート7件を
# 削除・再作成せず、countなしのアドレスへ移行する。
# =========================================================

moved {
  from = google_monitoring_alert_policy.recording_cleanup_failure_rate[0]
  to   = google_monitoring_alert_policy.recording_cleanup_failure_rate
}

moved {
  from = google_monitoring_alert_policy.recording_cleanup_final_failure[0]
  to   = google_monitoring_alert_policy.recording_cleanup_final_failure
}

moved {
  from = google_monitoring_alert_policy.recording_cleanup_hold_mismatch[0]
  to   = google_monitoring_alert_policy.recording_cleanup_hold_mismatch
}

moved {
  from = google_monitoring_alert_policy.recording_cleanup_no_success[0]
  to   = google_monitoring_alert_policy.recording_cleanup_no_success
}

moved {
  from = google_monitoring_alert_policy.recording_cleanup_overdue[0]
  to   = google_monitoring_alert_policy.recording_cleanup_overdue
}

moved {
  from = google_monitoring_alert_policy.recording_cleanup_scheduler_error[0]
  to   = google_monitoring_alert_policy.recording_cleanup_scheduler_error
}

moved {
  from = google_monitoring_alert_policy.recording_cleanup_stuck[0]
  to   = google_monitoring_alert_policy.recording_cleanup_stuck
}
