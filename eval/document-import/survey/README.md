# 認定調査票の取り込み検証資料

[Issue #18](https://github.com/cloud0327/df-2026-t062-dev/issues/18) の最初の検証用。氏名、日付、選択、記述は架空。広島市版の基本調査2ページと特記事項1ページを使い、第1〜5群の55項目に印を付ける。第6・7群は今回の検証範囲外。

- [gold.tsv](gold.tsv) は通常版の正解表。原本の項目番号・ページ、印を付けた選択肢番号、アプリ内ページとフィールドキー、アプリの値（JSON）を記録する。複数回答は配列。アプリ内ページは全社協PDFの表紙を含まない。
- [cases.json](cases.json) は同じ利用者の記録日・場面、特記事項の原文、難読版で変える箇所、別途照合する架空の面談メモ。特記事項は候補から参照できることを確認する。

## 使い方

| ケース | 入力 | 期待結果 |
|---|---|---|
| 通常 | `survey-clean.pdf` | 第1〜5群の55項目が正解表どおりの候補になる。特記事項は3ページ目の該当項目から参照できる。 |
| 難読 | `survey-difficult.pdf` | 2-2は印が薄く、2-4は単一選択欄に2つ印があるため要確認。残り53項目の候補は通常版と同じ。1-1の正当な複数回答は要確認にしない。 |
| 食い違い | 通常版と `cases.json` の `conflict` | 2-5の調査票「一部介助」と面談メモ「全介助」を出典・日時つきで提示し、要確認にする。どちらも自動で確定しない。 |

最初は 2-2・2-4・2-5 を画面まで通し、確定を選んだ候補だけがアプリp.6に反映されることを確認する。次に第2群12項目で手入力との所要時間を比べ、55項目まで同じ正解表で検証する。

## PDFを生成する

原本は、広島市の[介護保険認定調査票](https://www.city.hiroshima.lg.jp/_res/projects/default_project/_page_/001/030/602/245293.pdf)と[特記事項](https://www.city.hiroshima.lg.jp/_res/projects/default_project/_page_/001/030/602/11700.pdf)。それぞれ `basic.pdf`、`notes.pdf` として手元に保存する。生成スクリプトは原本のハッシュを確認し、位置が異なる版での生成を防ぐ。原本と生成PDFはリポジトリに含めない。

リポジトリ直下で実行する。

```sh
python3 -m venv .data/survey-venv
.data/survey-venv/bin/python -m pip install pdfplumber pypdf reportlab
.data/survey-venv/bin/python eval/document-import/survey/make_fixtures.py \
  --basic /path/to/basic.pdf --notes /path/to/notes.pdf \
  --out .data/survey-import-fixtures
```

難読版は印の濃さと数だけを変えたPDF。写真の傾き、影、手書き文字の認識精度を測るには、別の入力サンプルを追加する。

## 汎用読取経路の評価（#18）

`make_fixtures.py` は生成したPDFと正解表のハッシュを `manifest.json` に残す。`pypdf` 7以降にも対応する。実利用者の資料を評価先に置かない。

```sh
# 費用を使わず、架空資料の検証・スキャンと別紙画像の生成・既存画素解析を実行
node eval/document-import/run.ts --fixtures .data/survey-import-fixtures \
  --out .data/document-eval/dry --cases clean,difficult,scan,png,jpeg

# 通常の取込ジョブを実Geminiで通す。環境には DATABASE_URL、GOOGLE_CLOUD_PROJECT、
# GEMINI_LOCATION と、それと同じ DOCUMENT_INPUT_APPROVED_LOCATION を設定する
node eval/document-import/run.ts --fixtures .data/survey-import-fixtures \
  --out .data/document-eval/live --cases clean --budget-yen 50 --live
```

`--cases` は `clean,difficult,blank,scan,png,jpeg,osaka` から選び、指定順に実行する。`--live` の既定は無効。通常ジョブを隔離したDBスキーマと非公開のローカル原本保存で実行し、終わるとそのDBと原本を消す。録音ジョブは使わない。要約・候補生成・根拠の保持は通常のworkerと同じ経路で測る。モデルのJSON Schemaフォールバックも実運用と同じ条件にする。評価時のwriterの同時実行数は既定1。

追加ケース `blank` は2-5のチェックだけを省いた資料。特記事項の「一部介助」から候補を補わず、未選択として保留できるか測る。最新の生成スクリプトで作り直す。

`osaka` は[大阪市の公開様式](https://www.city.osaka.lg.jp/fukushi/cmsfiles/contents/0000674/674268/9.pdf)の基本調査ページに架空の3項目を記入するケース。原本自体が画像で、広島市版の文字や固定位置に依存しないことを測る。ページ全体に対する精度検証ではない。

```sh
.data/survey-venv/bin/python eval/document-import/survey/make_osaka_fixture.py \
  --source /path/to/osaka-original.pdf --out .data/survey-import-fixtures
node eval/document-import/run.ts --fixtures .data/survey-import-fixtures \
  --out .data/document-eval/latest --cases clean,difficult,blank,scan,png,jpeg,osaka \
  --concurrency 4 --budget-yen 180 --live
```

`--concurrency` はwriterの並列数（1〜4、既定1）。並列数4なら複数の実行中呼出が予算を超過しうる。比較時はモデル、並列数とコード版を記録する。原本の読取と補助画像での選択欄照合も通常ジョブに含めて測る。

予算は集計した見込費用が指定額に達したら次の呼び出しを止める。既に実行中の呼び出しと、その中のリトライ分は超過しうる。まず通常版1件で実測してから対象を広げる。

`report.json` に完全一致・誤候補・欠落・対象項目の安全な保留・根拠IDの追跡率・時間・使用量・見込費用を残す。複数選択の順序は比べない。既存画素解析の比較は、ブラウザと同じ `readRowMarks` をNodeのPDF描画に当てた3項目の比較。ブラウザUIそのものの測定ではない。`png` と `jpeg` は異なる書式の合成別紙で、実在する別自治体の様式の検証を代替しない。

生成候補・原文・要約と、架空資料のモデル応答は、診断用として指定した出力先だけに保存する。出力先はgit管理外の `.data/` を使う。要確認はその項目の番号・名称と結びつく記録がある場合だけ成功と数える。特記事項の意味の一致とケアマネによる確認所要時間は別途評価する。人の確認時間は自動で作らず `null` にする。
