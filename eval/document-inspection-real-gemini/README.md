# 書類別点検の実Gemini評価

すべて架空の日本語データ。対象は第1〜5表とモニタリング。各書類の十分な記載と不足・矛盾を対にして、33〜60番の28項目・延べ62判定を比較する。期待値は実行前に元の段階基準から作成した開発評価用の仮正解で、専門職の確定正解ではない。

通常の `npm test`・CIからは実行しない。料金と認証を確認後、次の順に明示実行する。

```sh
node eval/document-inspection-real-gemini/run.ts --dry --out /tmp/inspection-dry
# GOOGLE_CLOUD_PROJECTは既存ADCと一致させる。秘密鍵・トークンを出力しない。
AI_PROVIDER=vertex GEMINI_MODEL=gemini-3.8-flash GEMINI_LOCATION=global GOOGLE_CLOUD_PROJECT=<project> node eval/document-inspection-real-gemini/run.ts --live --limit 1 --out <new-output-dir>
# 最初の実応答と請求メタデータを確認してから残りを実行
AI_PROVIDER=vertex GEMINI_MODEL=gemini-3.8-flash GEMINI_LOCATION=global GOOGLE_CLOUD_PROJECT=<project> node eval/document-inspection-real-gemini/run.ts --live --resume --limit 12 --out <same-output-dir>
node eval/document-inspection-real-gemini/summarize.ts <same-output-dir>
npx tsc -p eval/document-inspection-real-gemini/tsconfig.json
```

`worker/inspect/index.ts`、プロンプト・基準、既存 `geminiFactory` と `@google/genai` の実Vertex接続を使用。本番の生成条件（LOW、最大65536tokens、JSON schema）は保持し、検証時だけアプリとSDKの再試行を無効にする。DBを使わず、同じ様式の辞書と現在値の射影形で `inspect` を直接評価する。DB/API/UIの検証とは分ける。

送信前にledgerを保存し、累積12回、入力＋schema 60000bytes、出力設定65536tokensを上限にする。既存ledgerを上書きしない。SDK非公開の観測箇所 `generateContentInternal` が存在しなければ停止する。再実行は別予算になるので、成功したデータの再集計には必ずsummarizeを使う。

事前の保守的上限は `(60000×0.75 + 65536×3.75)×12/1e6 = $3.48912`。2026-11-24の[公式単価](https://cloud.google.com/model-garden/pricing)、global、2026-12-31まで。出力に思考を含める。キャッシュ値引き・税・為替を含めない。

各結果は実応答ID、モデル版、時刻、入力/schemaのハッシュ、利用量、実生成JSON、アプリ解析後の判定、事前期待値との比較を含む。生のモデルとアプリの機械判定による上書きを別に集計する。既存アセスメント点検の精度・同一入力の再現性・臨床的妥当性の統計評価ではない。
