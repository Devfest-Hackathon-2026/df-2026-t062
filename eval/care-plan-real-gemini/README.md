# 実Gemini品質検証（手動実行専用）

結果・評価は [検証レポート](../../docs/verification/care-plan-real-gemini.md)。本番コード・プロンプトは変更しない。
`cases.json` は全件架空。`results/` は2026-11-22の実応答と隔離DBでの適用記録であり、正解例ではない。
生の回答は `captured.text`、正規化後は `generated.draft.proposal`、適用後は `persisted`。
認証ヘッダー・トークン・ADC内容は記録しない。実利用者データを入力しないこと。

## オフラインで記録を検算

```sh
node eval/care-plan-real-gemini/summarize.ts
```

12件のJSON・responseIdの重複なし・同一入力ハッシュ・曜日/時刻/serviceRef・適用チェック・トークン数を検算し、`results/summary.json` を再計算する。通信しない。文章の意味・臨床的な正しさは判定しない。

## 再実行（実API料金が発生）

前提：依存関係をインストール済み、ローカルPostgreSQL、既存のADCとVertex AI利用権限。
公式料金とモデルの提供状況を再確認すること。コード内の単価は2026-11-22時点であり、将来の予算保証には使わない。
例のDBは使い捨てローカル用。稼働中の本番DB・実データのあるDBへ向けない。

```sh
export EVAL_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/careman
export AI_PROVIDER=vertex
export GEMINI_MODEL=gemini-3.8-flash
export GOOGLE_CLOUD_PROJECT=YOUR_TEST_PROJECT
export GEMINI_LOCATION=global

# 接続確認のA1も12回の予算に含む（新規の出力先を指定）
node eval/care-plan-real-gemini/run.ts --live --out .data/care-plan-quality-rerun --limit 1

# A1の実応答をレビューしてから、残り11回だけ実行する
node eval/care-plan-real-gemini/run.ts --live --resume --out .data/care-plan-quality-rerun --limit 12
```

`--limit` は今回追加分ではなく、同じledgerでの累積上限。送信前にledgerを書き、エラーも1回として消費する。失敗したケースを自動リトライしない。
既存ledgerは `--resume` なしでは上書きしない。別の出力先を作ると別枠になるため、**同じ評価の再試行目的で出力先を作り直さないこと**。
同じledgerで同時実行しない。ローカルDB以外を拒否し、専用ランダムスキーマだけを作成・削除する。
強制終了時にはスキーマが残る場合がある。手動で削除する際は当該実行の `eval_cp_live_…` のみを特定する。

実経路は `defaultApiDeps(...).carePlanAi` → `createApp` の生成/適用API。
`Models.prototype.generateContentInternal`（SDK 3.0.0）を観測し、実SDKへ委譲する。非公開箇所が変われば停止する。
プロンプト/温度/出力上限は本番と同じ。検証時だけHTTPタイムアウト120秒・SDK試行数1を加える。
入力7500 bytes上限、12回上限、見積もり$1超停止はこの検証用ガードであり、本番機能ではない。
クラッシュで記録が欠けた場合もledgerの送信回数を減らさない。

## 追加課金なしの故障注入・UIリプレイ

```sh
export EVAL_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/careman
node eval/care-plan-real-gemini/check-boundaries.ts eval/care-plan-real-gemini/results
node eval/care-plan-real-gemini/replay-ui.ts eval/care-plan-real-gemini/results/F1.json
```

故障注入は記録済みA1を変更して適用APIを通す。`invalid_json` と `api_error` はdrafterから例外を投げる模擬障害で、実Geminiの失敗回数には含めない。
`boundaries.json` を更新する。既知の不正保険区分受け入れも記録するので、実行終了コードだけを合格判定にしない。
UIリプレイは起動ログにURLを表示する。メール `cp-ui@example.com` でローカル開発ログインし、「ケアプランを作成」→「前回のAI原案を開く」。再生成は拒否する。終了はCtrl+C（専用スキーマと一時ストレージを削除）。
フォームPDFがローカルにない場合は既存の `ensurePdf` が公式様式を取得するが、Geminiは呼ばない。

## 型チェック

```sh
./node_modules/.bin/tsc --project eval/care-plan-real-gemini/tsconfig.json
```

ファイルを `.test.ts` / `.spec.ts` にせず、package.json・CIには追加しない。通常の `npm test` が実モデルを起動することはない。
