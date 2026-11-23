
locals {
  recording_cleanup_log_filter = join(" AND ", [
    "resource.type=\"cloud_run_job\"",
    "resource.labels.job_name=\"${var.recording_cleanup_job_name}\"",
    "jsonPayload.service=\"recording-cleanup\"",
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
  filter          = "${local.recording_cleanup_log_filter} AND jsonPayload.event=\"recording.retention.cleanup\" AND (jsonPayload.eligible_stuck_count > 0 OR jsonPayload.deleting_stuck_count > 0 OR jsonPayload.failed_past_retry_count > 0)"
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
