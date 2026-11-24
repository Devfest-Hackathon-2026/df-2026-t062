# #101 図欄の編集とチャット提案

参照試作: https://care-assessment-editor-sena.senasura03273.chatgpt.site/

家屋見取図・家族構成図・障害等の部位の3欄を、既存の書類のフィールドとして扱う。画像だけを別に保存しない。試作のデータ構造・人物図形・人体の画像を移植し、追加ライブラリを使わずSVGで編集する。

## 境界と更新経路

| 場所 | 担当 |
| --- | --- |
| `core/diagram/fields.ts`, `model.ts` | 図欄ID、種類、版、オブジェクトID、家族関係の検証 |
| `DiagramFieldEditor.tsx` | 欄ID・表示名・種類・値だけを受ける。編集・履歴・反映前確認。PDF座標は持たない |
| `forms/seed/assessment` | 検証済みの全社協様式の固定枠（mm）。未知の様式へ推測で追加しない |
| `DiagramSlot.tsx`, `useDocument.applyDiagram` | 欄ごとのプレビュー、開いた時点の値をbaseにして既存PATCHへ送る。他の図を送信しない |
| `api/chat.ts` | 既存のread_form/propose_editで構造化図を提案。型・kind・baseRevisionを確認。自動反映しない |
| `PetChat.tsx`, `petChat.ts` | 提案の前後を図で表示。1フィールド更新として反映・取り消し。送信成功後に状態変更 |
| `db/repo.ts` | 書類ロック内でbase全体とrevisionを照合し、既存の監査履歴へ記録 |
| `core/diagram/svg.ts` | 編集・用紙・PDFで同じ描画。部屋は常に最背面。ラベルをXMLエスケープ |
| `api/diagram-image.ts`, `api/pdf.ts` | 同じSVGを既存canvasで画像化し、保存版だけPDFへ出力。フォントと人体画像を同梱 |

### 値の形

```json
{"version":1,"kind":"house","revision":1,"data":{"items":[],"background":""}}
```

- `family.genogram` → `family`（people・relations）
- `housing.floorPlan` → `house`（items・background）
- `health.bodyMap` → `body`（items）

初回は空欄をbaseにしてrevision=1。以後は現在のrevision+1。図全体を消す場合も空の構造化図として版を進め、nullへ戻して版をリセットしない。AIの取り消しも新しい版として1回で行う。保存した版・仮の値・編集画面の履歴は別。

人物と関係のID重複、不明な接続先、親子の循環、本人の複数指定、異なる図種の値、古い版・飛ばした版は拒否する。AIには既存IDの維持を指示する。モデルが根拠のない人物や図形を作らないことを型だけで保証するものではなく、提案を人が確認する。

## 操作

家屋・家族はパレットのクリックで仮配置して選択、ドラッグで位置指定も可能。拡大・縮小時はSVGの実画面変換を使う。枠外ドロップでは追加せず、ドラッグ直後のクリックを抑制する。部屋の重なり順を変える操作は不要。

身体図は記号を選んでから図上で位置を指定する。パレットからのドラッグは使わない。正面・背面、記号、名称、幅・高さ・回転を編集できる。

矢印移動、Undo/Redo、人物属性、家族関係、段差高さ、反映前確認を提供する。文字は大きい状態で開く。用紙の図を押した際だけ編集コードを読み込み、中央シートを再マウントしない。

「用紙に反映」はフィールドへの記録。「保存」は既存のページ／書類保存で保存版を確定する操作。PDFは保存版だけを使う。失敗・競合時は編集内容を残し、成功表示へ進めない。

## 導入

既存様式は不変なので、新しい図枠は新しい版として登録する。通常の管理手順で実施する。

```sh
npm run forms:check
npm run forms:seed
npm run forms:rebase -- --dry-run
npm run forms:rebase
```

元PDFのハッシュは変更しない。図枠のない旧版のチャットは図の提案を受け付けない。独自様式や画像・表計算については、図種・枠を確認したアダプタが別途必要。自動検出や未知の原本への書き戻しは未実装。

## 検証

- `npm run typecheck`, `npm run forms:check`, `npm run build`
- `npm test`: ローカルでは160件成功、DBが必要な57件をスキップ。PR #127の初回CIではPostgreSQLを含む217件すべて成功（2026-11-19）。
- `test/diagram.test.ts`: 構造・版・関係・描画順・縮尺変換・回転した図形・AI反映と一括取り消し・日本語画像化・通常PDF出力。
- `test/api.test.ts`: PostgreSQLがあるCIで、他欄の保持、競合、版の不正、ページ保存、再取得、PDF出力を確認する。
- `npm run dev` → `/test/fixtures/diagram-editor.html` はメモリーだけの操作検証用。DBに保存できたと誤認させない説明を表示する。
- ブラウザで仮配置、パレットからのドラッグ（重複なし）、配置済み図形の移動と一括取り消し、反映後の再表示、人物属性、身体記号の位置待ち、反映失敗時の内容保持を確認。コンソールエラーなし。

未確認: 実タッチ端末・高齢者本人の試用・読み上げ・文字拡大時の詳細操作、本物の生成AIの出力品質。このMacでは開発用PostgreSQLがないため、DB保存・競合防止・再取得・PDF出力はCIで確認した。任意シート対応はこのPRの完成範囲に含めない。
