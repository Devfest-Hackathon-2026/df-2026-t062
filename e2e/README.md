# ケアプランのブラウザE2E（PR #140）

実際のReact画面 → Hono API → PostgreSQL → 保存版・PDFを通す。認証はE2E専用サーバーの開発用ログインを使用し、実利用者・本番API・外部AIは使わない。3表とアセスメントは公式PDF・公開済みの座標定義から表示する。

## 実行

必要: `.nvmrc` のNode.js、ローカルPostgreSQL 17、Popplerの `pdftoppm`。DB接続ユーザーにはスキーマの作成・削除権限が必要。

```sh
npm ci
npx playwright install chromium   # iPad も流すときは chromium webkit
# macOS: brew install poppler
# Ubuntu: sudo apt-get install poppler-utils fonts-noto-cjk
# Linuxでブラウザ用ライブラリがなければ npx playwright install --with-deps chromium
E2E_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/careman npm run test:e2e
```

- いつもは PC（`pc-1920`）だけで流す。CI もこれだけ（#189。開発の途中は、6 構成を毎回流すと遅く、iPad の WebKit で関係のない理由でも落ちるため）。
- ほかの大きさと iPad も流すときは `E2E_ALL=1` を付ける。リリースの前や、iPad の画面を変えたときに流す。

```sh
E2E_ALL=1 E2E_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/careman npm run test:e2e
```

- 通常の `.env` / `DATABASE_URL` は読み込まない。`E2E_DATABASE_URL` はローカルホストに限定。
- 実行ごとにランダムな専用スキーマと一時ストレージを作り、正常終了・SIGINT・SIGTERMで削除する。既存の事業所や利用者は変更しない。SIGKILLやOS停止では後始末ができないため、残った `e2e_care_plan_<UUID>` スキーマは管理者が確認して削除する。
- ポート4178はE2E専用。既存サーバーを再利用しない。API側は空きポートを選ぶ。
- 初回は `ensurePdf` が公式サイトからPDFを取得し、ハッシュを検証する。公式PDFが改訂された場合はテストを失敗させる。キャッシュはgit管理外の `forms/tools/templates/*/base.pdf`。
- 非公開の入院時情報提供書PDFは不要。外部Google Fontsの通信も止め、OSの日本語フォントで検証するため、OS間のピクセル一致を判定するテストではない。

個別実行:

```sh
E2E_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/careman npm run test:e2e -- --project=pc-1920
E2E_ALL=1 E2E_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/careman npm run test:e2e -- --project=ipad-11-portrait
npx playwright show-report
# 失敗時はレポート内のtrace.zip、または npx playwright show-trace <trace.zip>
```

## 表示条件

`E2E_ALL=1` のときは全6構成で、同じシナリオを実行する（いつもは pc-1920 だけ）。`?ui=pad` は指定せず、タッチ入力によるiPad画面への自動切替も検証する。`innerWidth` が設定値と一致することを検査し、ブラウザズームで寸法が変わった検証を除外する。

| プロジェクト | CSS px（幅 × 高さ） | ブラウザ / 入力 |
| --- | --- | --- |
| pc-1920 | 1920 × 1080 | Chromium / マウス |
| pc-2560 | 2560 × 1440 | Chromium / マウス |
| ipad-11-portrait | 834 × 1194 | WebKit / タッチ・DPR 2 |
| ipad-11-landscape | 1194 × 834 | WebKit / タッチ・DPR 2 |
| ipad-129-portrait | 1024 × 1366 | WebKit / タッチ・DPR 2 |
| ipad-129-landscape | 1366 × 1024 | WebKit / タッチ・DPR 2 |

iPadは11型・12.9型相当の画面寸法を再現したもの。**実機iPad/Safari・ソフトウェアキーボード・実際のピンチ操作の検証ではない。** ブラウザのアドレスバーやキーボードによる表示領域変化も含まない。WebKitとSafariの違いは[Playwright公式の説明](https://playwright.dev/docs/browsers#webkit)を参照。

## シナリオと証跡

1. 3表の新規作成、第1表の入力、第2表のニーズ・目標・サービス、第3表の週間予定・独立した氏名・生活リズムをUIで編集。3表を一括保存し、APIの永続値と再表示後のUIを照合。PDFのダウンロード・3ページを確認し、確定後の入力禁止と改定版へのサービスID対応を検査。
2. 保存APIを1回だけ503にして、成功表示を出さず、入力・未保存状態・出力/確定禁止を維持することを検査。移動確認のキャンセル、保存の再試行、自動送信と保存の区別、実際のPDF overflow 422と訂正後の200を確認。
3. 3表すべてで公式画像の読み込み、ページ全体の横はみ出し、用紙からはみ出す入力欄、PCの3列の重なり、ヘッダーの高さ、作成ボタンの独立配置、iPad縦向きの操作欄の高さ、保存ボタンとダイアログの収まり、100→120→100%の拡大縮小を検査。

表示テストは各表のPNGをHTMLレポートに添付する。ブラウザのバージョン・CSS viewport・DPR・入力欄の文字サイズは `display-metrics` に記録する。全テストで未処理のブラウザ例外がないことを検査。失敗時はスクリーンショットとトレースを保存する。

CIは `.github/workflows/browser-e2e.yml`。main以外をbaseにする積み上げPRでも起動し、レポート・PNG・失敗トレースを7日間保存する。2026-11-22に候補ありAI原案の生成・再開（再生成なし）・第2表サービスと第3表週間枠の対応・明示適用・保存再表示を全6構成へ追加。PC2構成では相談履歴と参照元を保ったケアプランとの往復も検証する。iPadの相談パネルはPCの導線のため対象外。計30ケース中、この4件は対象外skipとなる。原案は専用サーバーの合成drafterを使用し、実Geminiの精度は検証しない。
