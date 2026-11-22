# 第4〜7表 実装の現在地

2026-11-22。main未マージ、本番DB変更/デプロイなし。全PRはdraft・途中段階のRefs。Issue #165/#166/#94/#96を完了扱いにしない。

## 実装とPRの依存順

|PR|対象|作業ブランチ|
|---|---|---|
|[#167](https://github.com/cloud0327/df-2026-t062-dev/pull/167)|第5表の公式様式・長文印字|codex/care-plan-4-7-foundation|
|[#172](https://github.com/cloud0327/df-2026-t062-dev/pull/172)|第5表の複数記録・一覧・検索・編集・履歴・PDF|codex/165-support-progress-workflow|
|[#173](https://github.com/cloud0327/df-2026-t062-dev/pull/173)|第5表AI候補・出典固定・明示採用|codex/165-support-progress-ai|
|[#174](https://github.com/cloud0327/df-2026-t062-dev/pull/174)|第4表会議記録・出席者・内容/結論/課題・AI候補・PDF|codex/166-meeting-records|
|[#175](https://github.com/cloud0327/df-2026-t062-dev/pull/175)|第6表の月間展開・差分・前月コピーの純粋関数|codex/94-month-expansion|
|[#176](https://github.com/cloud0327/df-2026-t062-dev/pull/176)|第6表の版付き月次API・予定/実績・PDF|codex/94-month-storage|
|[#177](https://github.com/cloud0327/df-2026-t062-dev/pull/177)|第6表のPC/iPad操作・履歴・コピー元保存版・既存書類保持|codex/94-month-workflow|
|[#178](https://github.com/cloud0327/df-2026-t062-dev/pull/178)|第7表の一次資料/限定範囲/独立検算した期待値|codex/96-verified-fee-engine|
|[#181](https://github.com/cloud0327/df-2026-t062-dev/pull/181)|第7表の決定的な限定算定エンジン|codex/96-fee-calculator|
|[#183](https://github.com/cloud0327/df-2026-t062-dev/pull/183)|第7表の版付き保存API・不変マスター・公式PDF|codex/96-fee-storage|
|作成予定|第7表のPC/iPad条件入力・再計算/履歴・明示確定・横断E2E|codex/96-fee-workflow|

各PRは直前のブランチがbase。依存順にレビューし、承認なしにmainへマージしない。#178で示した限定範囲についてユーザーの継続指示を受け、#181以降で実装。実務者レビューと本番適用は未実施。

## 主な変更ファイル

- 値/型: core/fields.json、core/care-record.ts、core/care-month.ts、core/care-month-api.ts、core/care-month-print.ts。
- 保存/認可: db/care-records.ts、db/care-record-drafts.ts、db/care-months.ts、db/care-plans.ts、api/app.ts。
- AI: api/care-record-ai.ts。既存runChat/modelを再利用し、新SDKや自動保存経路を追加しない。
- DB: 0010_support_progress、0011_care_record_creations、0012_care_record_drafts、0013_meeting_records、0014_care_plan_months、0015_care_fees、0016_care_fee_confirmations（db/migrations、全て追加移行）。
- 公式PDF: forms/seed/care_plan_4/5/6/7 のform/template/bindings。core/form.ts、core/print-layout.ts、db/forms.ts、forms/admin/files.ts/pdf.tsの宣言型継続印字/明細原紙。
- UI: src/components/care-record（記録管理/会議固有入力/AI候補）、src/components/care-month（月次操作/予定と実績の入力）、src/components/care-fee（条件/結果/履歴/確定）、src/screens/client-work/PcWork.tsx/PadWork.tsx、src/lib/api.ts。既存第1〜3表の編集器は再実装しない。
- 検証: test/care-record-api/ai/print、meeting-print、care-month/api、既存種類/移行テスト、e2e/care-record.spec.ts、e2e/care-month.spec.tsとsupport。
- 第7表: docs/サービス利用票別表_算定仕様.md、core/fee-masters/2026-06-basic.json、test/fixtures/care-fees/expected.json、core/care-fees.ts、core/care-fee-api.ts、core/care-fee-print.ts、db/care-fees.ts、test/care-fee-api.test.ts、e2e/care-fee.spec.ts。原マスター全文/利用者情報/認証キーは含めない。

## 検証結果

- `npm run typecheck`、`npm run forms:check`、`npm run build`成功。buildには既存の大きいchunkの警告あり。
- ローカルPostgreSQLの全412テスト成功、skip 0。
- 横断Playwright50成功、既存PC専用4件はiPad4サイズでスキップ。Chromium PC2サイズ/WebKit iPad相当4サイズ。最後に第6表テストへアセスメント/入院時情報提供書の独立値と保存版の保持を追加し、6サイズ全て成功。
- 第4/5/6表の日本語PDFと継続ページを合成データで生成。第4表の本表/続頁、第6/7表の本表/明細を画像確認。第6表の明細付き原紙は同じメタデータから同じSHAで再構築できる。
- 401/事業所404/保存409/入力400、再送、過去版の不変、AI候補の非自動適用、日時/出席者の不正AI提案拒否、取消/削除時の実績保持、コピー元の保存版、保存失敗復旧、算定の明示確定/確定記録の不変/再計算版への非継承を検証。
- GitHubの#167〜176および#183のブラウザCI成功、#178のCI/CD Verify成功/Deploy Hostingスキップを確認。最新UIブランチのCIはPR作成後に記録する。本番デプロイ条件はmain限定。
- 実機Safari・実Geminiの文章品質・現場レビューは未実施。E2EのAIは明示的な注入モデルで、実APIの生成成功とは報告しない。非公開の入院時情報提供書の原紙PDFは今回のE2E対象外。

## 残作業と優先度

1. 第7表: 身体介護1（111111、244単位）、1サービス/1事業所/1日1回/昼間/限度内、2026-06〜11の検証範囲に限定。加減算/公費/福祉用具/限度超過等は未対応・金額null。実務者の算定/入力経路レビューとサービス拡張が残る。AI算定は接続しない。
2. 第4/5表: 実Geminiと架空録音による品質検証/実務者レビュー、出典の文単位対応、最終確定の扱い。第4表の関連計画版任意指定、ヘッダー長文別紙も残る。
3. 第6表: 保険者番号等の追加ヘッダー編集、事業所独自様式の互換確認、別計画版をまたぐ前月コピー、実機/現場レビュー。標準用紙の算定欄は未計算の空欄で、0円にしない。
4. 最終受入と依存PRのレビュー。mainへのマージ/デプロイ/本番様式適用は別途明示承認が必要。

API・印字・制度の詳細は [実装記録](care-plan-4-7.md) と [算定仕様](../サービス利用票別表_算定仕様.md) を参照。
