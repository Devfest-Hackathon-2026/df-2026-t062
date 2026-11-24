output "workload_identity_provider" {
  description = "Full provider name for google-github-actions/auth."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deploy_service_account" {
  description = "Service account email for google-github-actions/auth."
  value       = google_service_account.github_deploy.email
}

output "artifact_registry_repository" {
  description = "Docker repository path. Append /IMAGE:TAG when pushing."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.api.repository_id}"
}

output "cloud_run_url" {
  description = "Cloud Run API service URL (public; the app verifies Firebase ID tokens itself)."
  value       = google_cloud_run_v2_service.api.uri
}

output "worker_cloud_run_service" {
  description = "worker の Cloud Run サービス名（GitHub Environment 変数 CLOUD_RUN_WORKER_SERVICE）。"
  value       = google_cloud_run_v2_service.worker.name
}

output "migrate_job" {
  description = "DB 移行の Cloud Run ジョブ名（GitHub Environment 変数 CLOUD_RUN_MIGRATE_JOB）。"
  value       = google_cloud_run_v2_job.migrate.name
}

output "recording_cleanup_job" {
  description = "録音原本のCleanup Job名。"
  value       = google_cloud_run_v2_job.recording_cleanup.name
}

output "worker_url" {
  description = "api・Cloud Tasks・Scheduler が使う worker の URL（組み立てた値）。worker_uri と同じことを確かめる。"
  value       = local.worker_url
}

output "worker_uri" {
  description = "worker の実際の URL。worker_url と同じになる。"
  value       = google_cloud_run_v2_service.worker.uri
}

output "sql_connection_name" {
  description = "Cloud SQL の接続名（CLOUD_SQL_INSTANCE）。"
  value       = google_sql_database_instance.main.connection_name
}

output "api_db_user" {
  description = "api の IAM DB ユーザー名。"
  value       = local.api_db_user
}

output "worker_db_user" {
  description = "worker の IAM DB ユーザー名。"
  value       = local.worker_db_user
}

output "buckets" {
  description = "source / output / work / forms のバケット名。"
  value       = { for k, b in local.buckets : k => b }
}

output "tasks_queue" {
  description = "Cloud Tasks キューの完全名（TASKS_QUEUE）。"
  value       = google_cloud_tasks_queue.jobs.id
}

output "bootstrap_sql" {
  description = "初回に一度だけ、管理者が実行する SQL。README の「DB の初期設定」を参照。"
  value       = <<-EOT
    CREATE ROLE app NOLOGIN;
    GRANT app TO "${local.api_db_user}", "${local.worker_db_user}";
    ALTER SCHEMA public OWNER TO app;
    ALTER ROLE "${local.api_db_user}" SET role = 'app';
    ALTER ROLE "${local.worker_db_user}" SET role = 'app';

    CREATE ROLE recording_cleanup NOLOGIN;
    GRANT recording_cleanup TO "${local.cleanup_db_user}";
    ALTER ROLE "${local.cleanup_db_user}" SET role = 'recording_cleanup';
    GRANT USAGE ON SCHEMA public TO recording_cleanup;
    GRANT SELECT, UPDATE ON recordings TO recording_cleanup;
    GRANT SELECT ON jobs TO recording_cleanup;
    GRANT SELECT, DELETE ON transcripts, recording_summaries TO recording_cleanup;
    GRANT SELECT, UPDATE ON care_record_drafts TO recording_cleanup;
    GRANT INSERT (office_id, staff_id, client_id, document_id, action, outcome, request_id, correlation_id, trace_id, source, route, schema_version, detail)
      ON audit_events TO recording_cleanup;
    GRANT USAGE, SELECT ON SEQUENCE audit_events_id_seq TO recording_cleanup;
  EOT
}
