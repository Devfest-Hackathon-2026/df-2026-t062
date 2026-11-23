# DB 設計（PostgreSQL）

本体は [`db/migrations/`](../db/migrations/)。読み書きは [`db/repo.ts`](../db/repo.ts) に集めた。api と worker は同じ関数を使う。

## 決まり

| 決まり | 中身 |
|---|---|
| 事業所で分ける | すべての表に `office_id` を持つ。`db/repo.ts` の関数は、どれも事業所で絞る。ほかの事業所の利用者は 404 になる（`test/api.test.ts` で確かめている） |
| 欄の値は fields.json の key で持つ | 用紙の印字欄（pdfme の欄）ではなく、意味の単位（`person.name`、`cert.careLevel` など）で持つ。印字欄との行き来（表示と直し）は、書類が指す様式の版の対応（`bindings`）を共通の仕組み（`core/binding.ts`）で動かす |
| 様式はデータ | 様式（`form_templates`）と様式の版（`form_template_versions`）を DB に持つ。版の中身（欄の位置・対応・ページ）は書き換えない・消さない（トリガーで止める）。直すときは新しい版を出し、書類の向き先を `npm run forms:rebase` で移す。書類は作ったときの版を指し、保存した版（`revisions`）と出した PDF（`exports`）にも、そのときの版を残す |
| 様式のファイルは非公開の置き場 | 元の PDF とページの画像は、Cloud Storage の `forms` の置き場の `pdf/<元の PDF の sha256>/`（`base.pdf`・`pages/p<PDF のページ>.png`）。場所が中身で決まるので上書きは起きず、同じ PDF の版どうしは同じファイルを使う。版は `base_pdf_sha256` で PDF を指す。画面には期限つきの URL で渡す |
| 印字欄ごとの値は持たない | どの印字欄も対応があり、直しは key の値になるか、理由を出して断る（例: 受付方法が「電話」なのに「その他」の中身を書いた）。年だけ・年月だけの日付は、日付の値のまま持つ |
| 誰が書いたか | 欄ごとに `by`（`ai`／`cm`）を持つ。AI はケアマネの欄を書き換えない |
| 保存は書類ごと | 今の値（`field_values`）と、その書類で保存した値（`document_saved`）を分けて持つ。画面の印（橙・黄・緑の下線）は、この 2 つの違いで出す |
| 版は書き換えない | 保存のたびに、保存した値の全部を `revisions` に残す。PDF は最新の版から作る（保存していない AI の値は出ない） |
| 値は書類ごと | どの値も、どれか 1 つの書類に属する（`field_values.document_id` は必須）。基本情報（氏名・住所など 7 欄）も書類ごと。書類を作るときに、元にする種類（`form_kinds.create_from`）の書類から同じ key の値を写し、写したあとはつながない。利用者一覧の氏名（`clients.name`）は、主な書類（`form_kinds.is_primary`）の氏名を直したときだけ変わる（2026-11-18） |
| 用紙を変える AI の入口は 1 つ | `applyBatch`。書類の行を `FOR UPDATE` で止め、今の用紙を読み直し、書き換えの決まりで書く（1 回のトランザクション）。ケアマネの直し（`patchFields`）も同じ行を止めるので、同時に来ても順に入る |

## 表

| 表 | 中身 | 主な列 |
|---|---|---|
| `offices` | 事業所 | `name`、`phone`、`fax`（入院時情報提供書の事業所欄に写す） |
| `staff` | ケアマネ | `auth_uid`（Identity Platform の uid）、`name`、`email`、`role` |
| `clients` | 利用者 | `name`、`status`（在宅／入院中／入所中）、`next_visit_at`（iPad の一覧の「次の訪問」） |
| `people` | 話した人 | `label`（春子など）、`role`（本人・家族・専門職・ケアマネ・不明）、`relation`。次の録音でも同じ人にする |
| `form_templates` | 様式 | `kind`（`form_kinds` の key）、`name`、`title`、`publisher`、`source_url`、`office_id`（NULL なら全事業所）。種類と使う範囲ごとに 1 つ。事業所の様式があれば、その事業所ではそれを使う |
| `form_template_versions` | 様式の版 | `version`、`status`（draft → published → retired）、`schemas`（欄の位置）、`bindings`（対応）、`pages`、`local_fields`（その様式だけの欄）、`content_sha`、`base_pdf_sha256`。使う版（published）は様式に 1 つ。公開した版と退いた版の中身は書き換えない・消さない。下書きの間は直せて、消せる |
| `documents` | 書類 | `kind`（`form_kinds` の key）、`seq`（同じ利用者・同じ種類の何通目か）、`template_version_id`（使う様式の版。下書きの版は指せない）。一意: `(client_id, kind, seq)` |
| `field_values` | 今の値（シート） | `key`、`value`、`ai_value`（最後に AI が書いた値）、`by`、`batch_id`、`cite`（根拠の発言の id）。`document_id` は必須。一意: `(client_id, document_id, key)` |
| `field_history` | 前の値 | 書き換えるたびに追記 |
| `document_saved` | 保存した値 | `(document_id, key)` ごとに `value`・`by` |
| `document_sync_reviews` | 使わない（2026-11-18 に書類どうしの食い違いを知らせる機能をやめた。行を足さない。表は消さない） | |
| `revisions` | 版 | `rev`、`scope`（`hunk`／`page`／`document`）、`values`（保存した値の全部）、`template_version_id`（PDF はこの様式の版から作る） |
| `batches` | 書き込み | `kind`（`recording`／`copy`／`seed`）、`label`（「AI 書き込み 2・1/25 の録音」など）、`changes`（key・op・before・after）、`kept`（書き換えなかったケアマネの欄） |
| `recordings` | 録音（原本の音声） | `object_path`（Cloud Storage の source バケットの場所）、`mime`、`bytes`、`duration_ms`、`status`、`source_expires_at`（原本を保持できる期限）、`source_delete_status`（削除候補などの状態）、`source_deleted_at`、`source_purge_expected_at`（GCS Soft Deleteを含む完全消去見込み）、`intermediate_expires_at`／`intermediate_delete_status`／`intermediate_deleted_at`（文字起こしなど中間データの期限・削除状態）、`retention_policy_version`、`retention_hold`／`retention_hold_target`／`retention_hold_sync_status`（GCS Object Hold の実状態・目標状態・同期状態）、`retention_hold_until`／`retention_hold_reason_code`／`retention_hold_set_at`／`retention_hold_set_by` |
| `transcripts` | 文字起こし（原本の文字） | `utterances`（id・時刻・話者の記号・人・文）、`speakers`、`model` |
| `jobs` | 録音 1 本の処理 | `status`（queued／processing／succeeded／partial／failed）、`step`（transcribe／speakers／write／apply）、`steps`（段ごとの結果・時間・トークン・円）、`lease_until`、`run_token`、`attempts`、`error_kind`、`batch_id`。録音 1 つに 1 つ、同じ書類で処理中は 1 つだけ |
| `exports` | 出した PDF | `revision_rev`、`template_version_id`、`object_path` |
| `audit_events` | 操作の記録（追記だけ） | `action`（client.create／document.edit／document.save／document.pdf／recording.start／form.rebase など）、`detail`（数だけ。欄の値や話の中身は入れない。form.rebase は移した版の番号と中身の指紋） |

### 再設計で足した表

`form_kinds`（書類の種類と種類ごとの動き）・`form_imports`・`site_admins`・`inspections`・`inspection_findings`・`recording_summaries`・`office_topics` と、`staff.disabled_at`、`document_fills`（書類を作るときに AI が書く仕事。#195、`db/migrations/0034_document_fills.sql`。あわせて `batches.kind` に `fill` を足した）。列と決まりは [再設計/13_DB設計.md](再設計/13_DB設計.md)（移行は `db/migrations/0003_redesign.sql`・`0004_field_values_per_document.sql`）。

## 録音ジョブの失敗と再配信

- 一時的な例外では `queued` に戻して Cloud Tasks の再配信または 5 分ごとの見回りで再開する。3 回失敗したら `failed` とし、それ以上は自動実行しない。
- Worker が取得するたび `run_token` を発行する。段階の更新と完了時に照合し、リースを失った古い実行を拒む。処理中は定期的にリースを延長する。
- 録音の `applyBatch` とジョブの `succeeded`／`partial` への更新は同じトランザクションで行う。`batches.job_id` は録音処理で一意。反映直後に通信が切れても、次の配信で同じ変更を重ねない。
- 原本の保持期限は録音時に `recorded_at + 14日` で設定し、録音完了時に再計算する。AI処理の成功・部分成功・失敗・再試行では期限を短縮・延長しない。正式な書類・監査ログは原本の期限とは別に残す。文字起こしと録音要約の保持・削除方針は別途定める。
- 録音原本の保持期限はDBで管理する。GCS Soft Deleteは、削除後の誤操作から復旧するための安全措置として3日間（259200秒）に設定する。
- 録音原本の長期保管は行わず、正式なケア記録および監査ログとは分離して管理する。3日間は現行システムで採用する運用上の復旧期間であり、法令上の保存期間を意味しない。事業要件や運用上の復旧要件が変更された場合は、保持期間を再評価する。
- `retention_hold` は無期限を許さず、未来の `retention_hold_until` を必須にする。設定・解除は `recording.retention_hold_set`／`recording.retention_hold_released` として、期限・理由・手動解除か期限切れ解除かを `audit_events` に追記する。
- 保全の確認・設定・解除は、専用の苦情画面ではなく既存の利用者画面に置く管理者限定の保持管理欄で行う。画面には音声本文・文字起こし・GCS の object path を表示せず、録音日時、原本と中間データの期限・削除状態、保全状態だけを表示する。保全終了日時と理由を必須入力にし、解除後は削除ジョブの対象へ戻る。
- 原本削除は `pending → eligible → requested → deleting → deleted` の順に進める。候補取得時に `requested` へ更新して `recording.delete_requested` を残す。`requested` までは保全設定で `pending` に戻せるが、Storage 削除を始める `deleting` 以降は保全設定を拒否する。候補取得と削除開始はいずれも条件付き更新にし、保全設定との競合で削除してはいけない原本を削除しない。
- 既存録音への期限付与は小分けにコミットし、候補検索用の索引は `CREATE INDEX CONCURRENTLY` で作る。移行中に旧 API が期限列を指定せず録音を追加しても失敗しないよう、DB の既定値を先に設定してから既存行を補完し、最後に `NOT NULL` を有効にする。
- 保持期限の変更は `recording.retention_set` として、録音完了時と AI の正式記録反映時に追記する。`recording.retention_set` の detail には録音 ID・旧状態・新状態・契機・ポリシー版だけを入れ、音声・文字起こし・要約・氏名などの中身は入れない。
- `partial` は確定済みの結果であり、自動再配信しない。AI が処理できなかった欄と形式不一致で反映できなかった欄の key を `jobs.steps.write.incompleteFields` に保存し、ジョブ API に出す。PDF プレビューでは該当欄を赤枠で示す。失敗項目だけを補完する別ジョブは作らず、担当者が録音し直す。

## 保存の 3 段

| 段 | 画面 | `document_saved` に入るもの |
|---|---|---|
| 1 か所 | 差分のふきだしの「保存」 | その欄の「前の文＋その 1 か所」。サーバーが前の文と今の文から組み立てる |
| ページ | 「このページを保存」 | そのページの印字欄が読む key |
| 書類 | 「書類を保存」 | 全部の欄 |

どの段でも、保存のあとの `document_saved` の全部を版にする。

## 2 層改にしたので持たないもの

設計の途中では 3 層（原本・事実・シート）を考えていたが、2026-11-09 に「2 層改」（記録から直接欄の値を書き、作り話を抑える 4 つの工夫を足す）にした。そのため、次のものは持たない。

- 事実（2 層目）と「確かめること」の表
- ケアマネの直しを `judge` の事実として入れること（直しは `by: "cm"` の値として持つ）
- 見直しの候補（`proposals`）と、書き込みの「元に戻す」（画面に入口がないため）

## 移行の流し方

```sh
npm run db:migrate   # db/migrations/*.sql を名前の順に流す（流したものは schema_migrations に残る）
npm run db:seed      # 見本のデータ（ローカルと demo だけ）
```

移行は足すだけにする（デプロイを戻しても DB が壊れないように）。Cloud SQL での初回の準備（`app` ロール）は [`infra/gcp/README.md`](../infra/gcp/README.md)。
