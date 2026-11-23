# --- Cloud Storage ---
# source: ブラウザから直接送る録音（api が再開できる送信を開始する）
# output: 保存した版から作った PDF
# work:   worker の作業用（30 日で消す）
# forms:  様式の元の PDF とページの画像（pdf/<元の PDF の sha256>/…、事業所の様式は offices/<office_id>/pdf/<sha256>/…）。
#         画面には期限つきの URL で渡す。場所が中身のハッシュなので上書きは起きない。全体の様式は管理者が入れる（npm run forms:assets）。
#         責任者・サイト管理者が上げた PDF は、いったん imports/<id>.pdf（事業所は offices/<office_id>/imports/<id>.pdf）に
#         ブラウザから直接送り、worker が変換して pdf/<sha256>/ に写し、imports/ のほうは消す（docs/再設計/13_DB設計.md）

locals {
  buckets = {
    source = "${local.bucket_prefix}-source"
    output = "${local.bucket_prefix}-output"
    work   = "${local.bucket_prefix}-work"
    forms  = "${local.bucket_prefix}-forms"
  }
}

resource "google_storage_bucket" "source" {
  name                        = local.buckets.source
  location                    = local.bucket_location
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = false
  }

  soft_delete_policy {
    retention_duration_seconds = 259200
  }

  dynamic "lifecycle_rule" {
    for_each = var.source_recording_lifecycle_enabled ? [1] : []

    content {
      action {
        type = "Delete"
      }

      condition {
        age            = 14
        with_state     = "LIVE"
        matches_prefix = ["recordings/"]
      }
    }
  }

  # 録音の直接送信（resumable upload）のための CORS。画面の Origin だけを許す
  dynamic "cors" {
    for_each = length(var.app_origins) > 0 ? [1] : []

    content {
      origin          = var.app_origins
      method          = ["PUT", "POST", "GET", "OPTIONS"]
      response_header = ["Content-Type", "Content-Range", "x-goog-resumable", "Range"]
      max_age_seconds = 3600
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket" "output" {
  name                        = local.buckets.output
  location                    = local.bucket_location
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = false
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket" "work" {
  name                        = local.buckets.work
  location                    = local.bucket_location
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = false
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }

    condition {
      age = 30
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_storage_bucket" "forms" {
  name                        = local.buckets.forms
  location                    = local.bucket_location
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = false
  }

  # 様式の PDF の直接送信（resumable upload）のための CORS。画面の Origin だけを許す
  dynamic "cors" {
    for_each = length(var.app_origins) > 0 ? [1] : []

    content {
      origin          = var.app_origins
      method          = ["PUT", "POST", "OPTIONS"]
      response_header = ["Content-Type", "Content-Range", "x-goog-resumable", "Range"]
      max_age_seconds = 3600
    }
  }

  depends_on = [google_project_service.required]
}
