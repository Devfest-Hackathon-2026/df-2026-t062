# 第4〜7表 実装の現在地

2026-11-23。#167で統合した第4〜7表は#191で取り消した後、ユーザーの再採用指示により `codex/restore-care-plan-4-7` で復活作業中。最新main b8ae737を基点とし、録音・独自書類・監査・録音原本の保持処理を維持する。今回のmainマージ、本番DB移行/APIリリースは未実施。Issue #165/#166/#94/#96には未完了事項があり、自動クローズしない。

## 今回の復活とUI変更（2026-11-23）

- 第4〜7表の既存実装を復元する。第7表の限定算定範囲を拡張したものではない。
- 第1〜3表の左側は用紙ナビゲーションだけにする。版選択・追加・改定・AI原案等の管理エリアを削除し、既存データ/APIは保持する。これらの操作導線は今回別の場所へ新設しない。
- 「計画を確定」は用紙上部の保存ボタンの横へ移す。保存済みで未変更の場合のみ操作できる。未保存の内容は確定しない。iPadの書類へ戻る操作は上部に保持する。
- PCの「ケアプランを作成」を書類タブの並びへ戻す。iPadは従来の書類メニューを使う。
- 復活する記録・月次・算定結果の閲覧にもアクセス監査を接続する。入院時情報提供書の録音対応、事業所独自種類、録音原本保持の移行0018〜0023を保持する。
- 0018〜0023適用済みDBへ0010〜0017を後から追加する移行テストと、記録閲覧の監査・越境拒否テストを追加。全452 DB/Nodeテスト成功、スキップ0。型・様式検査・build成功。ブラウザ検証結果は今回のPRに記載する。
- 表示を除いた版の管理・AI原案のテストはAPIで保持する。実Gemini品質、実機Safari、現場レビュー、本番適用は今回実施しない。

以下は前回実装時の履歴。今回の状態・検証結果は上の記載を優先する。

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
|[#184](https://github.com/cloud0327/df-2026-t062-dev/pull/184)|第7表のPC/iPad条件入力・再計算/履歴・明示確定・横断E2E|codex/96-fee-workflow|
|[#185](https://github.com/cloud0327/df-2026-t062-dev/pull/185)|iPad記録一覧の再取得中の操作位置を保持|codex/care-record-refresh-stability|
|[#186](https://github.com/cloud0327/df-2026-t062-dev/pull/186)|第4/5表の明示確定・会議の計画確定snapshot参照|codex/care-record-confirmations|
|[#187](https://github.com/cloud0327/df-2026-t062-dev/pull/187)|第6表の保険者情報/届出日・旧版/PDF保持|codex/care-month-headers|

各PRの元のbaseは直前のブランチ。mainへの中間公開を避けるため、#187から逆順に親ブランチへ統合し、最後に#167で完成形をmainへ反映する。#178で示した限定範囲についてユーザーの継続指示を受け、#181以降で実装。実務者レビューは2026-11-22のユーザー指示で今回の対象外。本番適用は未実施。

## 主な変更ファイル

- 値/型: core/fields.json、core/care-record.ts、core/care-month.ts、core/care-month-api.ts、core/care-month-print.ts。
- 保存/認可: db/care-records.ts、db/care-record-drafts.ts、db/care-months.ts、db/care-plans.ts、api/app.ts。
- AI: api/care-record-ai.ts。既存runChat/modelを再利用し、新SDKや自動保存経路を追加しない。
- DB: 0010_support_progress、0011_care_record_creations、0012_care_record_drafts、0013_meeting_records、0014_care_plan_months、0015_care_fees、0016_care_fee_confirmations、0017_care_record_confirmations（db/migrations、全て追加移行）。
- 公式PDF: forms/seed/care_plan_4/5/6/7 のform/template/bindings。core/form.ts、core/print-layout.ts、db/forms.ts、forms/admin/files.ts/pdf.tsの宣言型継続印字/明細原紙。
- UI: src/components/care-record（記録管理/会議固有入力/AI候補）、src/components/care-month（月次操作/予定と実績の入力）、src/components/care-fee（条件/結果/履歴/確定）、src/screens/client-work/PcWork.tsx/PadWork.tsx、src/lib/api.ts。既存第1〜3表の編集器は再実装しない。
- 検証: test/care-record-api/ai/print、meeting-print、care-month/api、既存種類/移行テスト、e2e/care-record.spec.ts、e2e/care-month.spec.tsとsupport。
- 第7表: docs/サービス利用票別表_算定仕様.md、core/fee-masters/2026-06-basic.json、test/fixtures/care-fees/expected.json、core/care-fees.ts、core/care-fee-api.ts、core/care-fee-print.ts、db/care-fees.ts、test/care-fee-api.test.ts、e2e/care-fee.spec.ts。原マスター全文/利用者情報/認証キーは含めない。

## 検証結果

- `npm run typecheck`、`npm run forms:check`、`npm run build`成功。buildには既存の大きいchunkの警告あり。
- ローカルPostgreSQLの最新main統合後の全416テスト成功、skip 0。
- 横断Playwright50成功、既存PC専用4件はiPad4サイズでスキップ。Chromium PC2サイズ/WebKit iPad相当4サイズ。最後に第6表テストへアセスメント/入院時情報提供書の独立値と保存版の保持を追加し、6サイズ全て成功。
- 第4/5/6表の日本語PDFと継続ページを合成データで生成。第4表の本表/続頁、第6/7表の本表/明細を画像確認。第6表の明細付き原紙は同じメタデータから同じSHAで再構築できる。
- 401/事業所404/保存409/入力400、再送、過去版の不変、AI候補の非自動適用、日時/出席者の不正AI提案拒否、取消/削除時の実績保持、コピー元の保存版、保存失敗復旧、算定の明示確定/確定記録の不変/再計算版への非継承を検証。
- GitHubの#167〜178、#181、#183、#184の最新ブラウザCI成功、#178/#184のCI/CD Verify成功/Deploy Hostingスキップを確認。最新UIブランチのCI/CD実行は [44994445060](https://github.com/cloud0327/df-2026-t062-dev/actions/runs/44994445060)。ブラウザCIと最終状態はPR #184のChecksを参照。本番デプロイ条件はmain限定。
- 実機Safari・実Geminiの文章品質・現場レビューは未実施。E2EのAIは明示的な注入モデルで、実APIの生成成功とは報告しない。非公開の入院時情報提供書の原紙PDFは今回のE2E対象外。

## 残作業と優先度

1. 第7表: 身体介護1（111111、244単位）、1サービス/1事業所/1日1回/昼間/限度内、2026-06〜11の検証範囲に限定。加減算/公費/福祉用具/限度超過等は未対応・金額null。サービス拡張が残る。実務者レビューは今回対象外。AI算定は接続しない。
2. 第4/5表: 実Geminiと架空録音による品質検証、出典の文単位対応、第4表ヘッダー長文別紙が残る。明示確定と確定時の関連計画版指定はcodex/care-record-confirmationsで実装。実務者レビューは今回対象外。
3. 第6表: 保険者番号/名・被保険者番号・届出日は追加済み。残る生年月日/性別/認定変更/限度額等のヘッダー、事業所独自様式の互換確認、別計画版をまたぐ前月コピー、実機検証。現場レビューは今回対象外。標準用紙の算定欄は未計算の空欄で、0円にしない。
4. 最終受入と依存PRのレビュー。mainへのマージ/デプロイ/本番様式適用は別途明示承認が必要。

API・印字・制度の詳細は [実装記録](care-plan-4-7.md) と [算定仕様](../サービス利用票別表_算定仕様.md) を参照。


## 一覧再取得中の操作位置の補足修正

`codex/care-record-refresh-stability`は#184をbaseとする補足修正。第7表の先行CI（44994443901）で第5表iPad縦画面の保存操作が1回失敗し、最新の同一実装CI（44994479471）は50成功/4スキップだった。失敗トレースでは保存リクエストが送られておらず、AI候補採用後の一覧再取得で一覧が縮小して、スクロール後の保存ボタン位置がずれていた。

一覧を再取得中も既存行を表示し、狭い画面で一覧領域の高さを保つ。E2Eに一覧取得の遅延を加え、一覧と高さの保持・保存リクエストの送信・保存版3を検証。第4/5表の12ケース成功、型/build成功。これは保存API/履歴検証を省く変更や、テストの自動再試行ではない。


2026-11-22追加: 第4/5表の保存版ごとの明示確定と、第4表の確定時の関連計画版指定を#186で実装。第6表の保険者番号/名・被保険者番号・届出日をcodex/care-month-headersで追加。入力値は既存documents/field_values/revisionsを使い、ヘッダーなしの過去保存版に現在値を混ぜない。実務者レビューは今回の対象外とするが、人の明示確認・確定操作は維持する。


## main統合時の関係確認（2026-11-22）

- 最新main c575bceの認定調査6項目追加（#170）と文言修正（#164）を統合。競合なし。既存の辞書/選択肢/文言テストも維持する。
- 未マージの#168（書類ごとの録音）/ #179（独自書類種類）とは利用者画面・api.ts等に接点があるが、今回混ぜない。#180/#182（監査）はAPI/DB/移行テストに接点がある。後続のマージ時に最新mainを取り込み、移行一覧や画面分岐を再検証する必要がある。#171の実Gemini品質評価も今回の依存とはしない。
- DB追加は0010〜0017、値は既存documents/field_values/revisions。既存書類の自動移し替え・値共有を行わない。公開中API/DBは手動Cloud Runリリースまで変更されず、Hostingのmain公開だけで第4〜7表が本番利用可能になったとは報告しない。
- マージ前の確認はmain統合後の全416 DB/Node成功、型/様式/build成功。最終ブラウザ/VerifyはPR #167のChecksを参照する。
