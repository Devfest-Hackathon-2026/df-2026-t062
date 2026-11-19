# API 設計

本体は [`api/app.ts`](../api/app.ts)（Hono）。worker の道（`/tasks/*`）は api には置かない（[`worker/app.ts`](../worker/app.ts)）。

## 入口の確かめ方（権限）

役割と権限表は [再設計/14_認可.md](再設計/14_認可.md)。権限表はコードの [`api/permissions.ts`](../api/permissions.ts) にだけ置く。入口はそれぞれ「操作」を 1 つ宣言する（下の表の「操作」の列）。宣言のない入口は `test/authz.test.ts` で落ちる。

| 入口 | 宣言 | 確かめること |
|---|---|---|
| 職員の入口（`/api/...`。責任者の入口は `/api/office/...`） | `care.work`・`staff.manage`・`form.manage` | 1. `Authorization: Bearer <Identity Platform の ID トークン>` の uid が `staff` にいて、止めていない（だめなら 401）。2. 読み書きする行の `office_id` が職員の事業所と同じ（ほかの事業所は 404。リクエストの値は使わない）。3. 職員の役割が、宣言した操作を許す（403） |
| サイト管理者の入口（`/api/admin/...`） | `site.manage` | トークンがなければ 401。uid が `site_admins` になければ 403。利用者の情報を持つ表は読まない |
| ログインなしの入口 | `public` | `/api/health.json` と、ローカルの置き場だけの開発用の 2 つ（期限つきの署名で確かめる。本番の置き場では 404） |

- 役割と止めたかどうかは、リクエストのたびに DB の `staff` から読む（止めたり役割を変えたりしたら、次のリクエストから効く）。
- 3 の操作の確かめは、行を読む前に入口で行う。役割が許さない操作は、行がどの事業所のものでも 403 になる（ほかの事業所の行があるかどうかは分からない）。

## 道の一覧

### 職員の入口（操作は `care.work`）

| メソッドとパス | すること | 主な応答 |
|---|---|---|
| `GET /api/health.json` | 動いているか（DB も Firebase も使わない）。`public` | `{status:"ok", source:"api"}` |
| `GET /api/me` | ログインしている職員と事業所、役割でできる操作 | `{staff:{id, officeId, name, email, role, officeName, operations}}` |
| `GET /api/clients?q=&sort=updated\|name` | 利用者の一覧（氏名・性別・状況・要介護度・必須の入力数・次の訪問・新規か） | `{clients}` |
| `POST /api/clients` | 利用者を追加（`{name, sex?, status?}`）。空のアセスメントも作る | `201 {id, assessmentId}` |
| `GET /api/clients/:id` | 利用者・書類・処理中のジョブ | `{client, jobs}` |
| `POST /api/clients/:id/documents` | 入院時情報提供書を作る（`{form:"admission"}`）。アセスメントから写す。あれば今のものを返す | `201/200 {id}` |
| `GET /api/form-versions/:id` | 様式の版（欄の位置・対応・ページ）。その事業所が見てよい版だけ（ほかの事業所の版と、下書きの版は 404。下書きは責任者の入口で読む）。中身は変わらないので `ETag`・`Cache-Control: private, immutable`（`If-None-Match` で 304） | `{formVersion}` |
| `GET /api/form-versions/:id/assets` | ページの画像の期限つきの URL（UTC の 0 時から 48 時間。同じ日は同じ URL）と、元の PDF が置き場にあるか。画像がまだなければ `url: null` | `{pages:[{no, url}], hasPdf, expiresAt}` |
| `GET /api/documents/:id` | 欄の今の値・保存した値・版の番号・最近の書き込み・使う様式の版 | `{document}`（`kind`、`formVersionId`） |
| `POST /api/documents/:id/edits` | 用紙の印字欄の直し（`{formVersionId, edits:[{slot, text}]}`）。書類の行を止め、その時点の値に、様式の版の対応で 1 つずつ当てる。当てられない直しは理由を返す（ほかは当てる）。画面の様式の版が書類の版と違えば 409 | `{results:[{slot, reason?}], document}` |
| `PATCH /api/documents/:id/fields` | 欄の値をそのまま変える直し（差分の欄の文章。`{changes:[{key, value, base, mode?}]}`）。`base` は画面が元にした値で、今の値と違えば 409（AI が書いたばかりの値を上書きしない）。`mode:"revert"` は「前の文に戻す」 | `{document}`（直した書類の値だけが変わる。ほかの書類には入らない） |
| `POST /api/documents/:id/chat` | 書き方の相談（`{messages:[{role:"user"\|"pet", text}]}`。やり取りは画面が持っていて毎回全部を送る。最大 40 件・1 件 4000 字、最後は `user`）。AI（Gemini の関数呼び出し。`AI_PROVIDER=fake` なら台本の答え）が道具（用紙を読む・足りない欄・録音を探す・書き換えの案）を使って答える。用紙は同じ利用者のほかの書類も読める（同じ事業所のものだけ。案は開いている書類の欄だけ）。書き換えの案は、この書類の様式の欄（図の欄を除く。まとまりの欄は値の全体）。**用紙は変えない**（画面が `PATCH /fields` で入れる） | 1 行 1 つの JSON（`application/x-ndjson`）。道具を使うたびに `{type:"step", text}`、最後に `{type:"done", reply, steps, proposals:[{key, label, before, after}]}`。途中で失敗したら `{type:"error"}`（状態はもう 200）。入力の誤り・ほかの事業所の書類は、流す前に 400／404 |
| `POST /api/documents/:id/save` | 保存（`{scope:"document"}`／`{scope:"page", page}`／`{scope:"hunk", key, hunkIndex}`） | `{rev, document}` |
| `GET /api/documents/:id/pdf` | 最新の版から、その版の様式の元の PDF で PDF を作る。出力の置き場にも残す。元の PDF が置き場になければ 503 | `application/pdf` |
| `POST /api/clients/:id/recordings` | 録音を始める（`{mime}`）。Cloud Storage の再開できる送信の URL を返す | `201 {recordingId, uploadUrl}` |
| `POST /api/recordings/:id/complete` | 送り終わり（`{durationMs}`）。置き場にあるのを確かめてジョブを積む | `202 {jobId, status}` |
| `GET /api/clients/:id/jobs` | 処理中・終わって15分以内・最後のジョブ。AI が処理できなかった欄と形式不一致で反映できなかった欄を `incompleteFields` の key 配列で返す。PDF プレビューは該当欄を赤枠にする | `{jobs:[{status, step, etaSeconds, batch:{changes, kept}, incompleteFields, errorKind}]}` |

### 責任者の入口（操作は `staff.manage`）

| メソッドとパス | すること | 主な応答 |
|---|---|---|
| `GET /api/office/staff` | 自分の事業所の職員（止めた人も含む） | `{staff:[{id, name, email, role, disabled, createdAt}]}` |
| `POST /api/office/staff` | 職員を登録する（`{name, email, role: "caremanager"\|"admin"}`。メールは小文字にそろえる）。Identity Platform のアカウントがなければ作る（`accountCreated: true`）。パスワードはここでは決めない: 画面が本人に、パスワードを決めるメール（Firebase の `sendPasswordResetEmail`）を送る。そのアカウントが、もうどこかの職員かサイト管理者なら 409（`already_registered`）。`audit_events` に `staff.create` を残す | `201 {staff, accountCreated}` |
| `PATCH /api/office/staff/:id` | 職員を止める・戻す・役割を変える（`{role?: "caremanager"\|"admin", disabled?: boolean}`。どちらか 1 つは要る）。ほかの事業所の職員は 404。自分を止める・自分の役割を変えるのは 403。`audit_events` に `staff.update` を残す | `{staff}` |

### 様式の取り込み（責任者は `/api/office/...` で操作は `form.manage`、サイト管理者は `/api/admin/...` で `site.manage`）

責任者は自分の事業所の様式、サイト管理者は全体の様式を取り込む。2 つの入口は同じ処理で、どこの様式か（`form_imports.office_id`）だけが違う。ほかの事業所の取り込み（サイト管理者からは事業所の取り込み、責任者からは全体の取り込み）は 404。

| メソッドとパス | すること | 主な応答 |
|---|---|---|
| `POST {prefix}/form-imports` | 取り込みを作る（`{kind}`。`form_kinds` にない種類は 400）。PDF をブラウザから直接送る URL（Cloud Storage の再開できる送信）を返す。置き場は `imports/<id>.pdf`（事業所は `offices/<office_id>/imports/<id>.pdf`） | `201 {import, uploadUrl}` |
| `POST {prefix}/form-imports/:id/complete` | 送り終わり。置き場に届いたのを確かめて、変換のジョブを積む（何度呼んでもよい）。届いていなければ 409。20MB を超えていれば変換に回さず `failed`（`too_large`） | `202 {import}` |
| `GET {prefix}/form-imports` | 取り込みの一覧（新しい順に 50 件） | `{imports}` |
| `GET {prefix}/form-imports/:id` | 変換の途中と結果 | `{import:{id, kind, status, uploaded, errorKind, versionId, review, createdAt, updatedAt}}` |

- `status` は `queued` → `processing` → `succeeded`（`versionId` が下書きの版）／`failed`（`errorKind`）／`matched`（登録済みの全体の様式と同じ PDF。`versionId` はその全体の様式の版で、下書きは作らない）。
- `review` は、変換が自信のない欄（印字欄の名前と理由）。責任者が確かめる画面で使う。

### 様式の版の下書きを確かめる・直す・捨てる・試し印字・公開する（責任者は `/api/office/...` で `form.manage`、サイト管理者は `/api/admin/...` で `site.manage`）

責任者は自分の事業所の様式を直せる。全体の様式は、下書きでない版を読むだけ（変えようとすると 403。全体の様式の下書きは見えない）。サイト管理者は全体の様式。ほかの事業所の様式は 404。公開した版・退いた版は直せない・捨てられない（409 `not_draft`）。下書きは直すたびに中身が変わるので、ブラウザに覚えさせない（`Cache-Control: no-store`）。

| メソッドとパス | すること | 主な応答 |
|---|---|---|
| `GET {prefix}/form-versions/:id` | 版の中身（状態・全体の様式か・その様式だけの欄の定義を含む）と、印字しないで分かる公開前の確かめ（下の 1〜3） | `{formVersion:{id, kind, name, version, status, global, schemas, bindings, pages, localFields, contentSha}, problems}` |
| `GET {prefix}/form-versions/:id/assets` | ページの画像の期限つきの URL と、元の PDF があるか（ケアマネの入口と同じ形） | `{pages, hasPdf, expiresAt}` |
| `PATCH {prefix}/form-versions/:id` | 下書きを直す（`{base, schemas?, bindings?, pages?, localFields?}`。送った部分だけを替える）。`base` は画面が元にした `contentSha` で、今と違えば 409（ほかの人が先に直した） | `{formVersion, problems}` |
| `DELETE {prefix}/form-versions/:id` | 下書きを捨てる（取り込みの `versionId` は空になる） | `204` |
| `POST {prefix}/form-versions/:id/preview` | 試し印字。架空の値（`forms/samples` の架空の利用者と、その様式だけの欄の型ごとの値）で印字した PDF。元の PDF が置き場になければ 503 | `application/pdf` |
| `POST {prefix}/form-versions/:id/publish` | 公開（`{base}`）。公開前の確かめ（[13_DB設計.md](再設計/13_DB設計.md)）: 1. すべての印字欄に対応がある 2. 対応の key が fields.json か `local_fields` にある 3. `local_fields` の key は `local.` で始まり重ならない 4. 架空の値で実際に印字できる。通らなければ 422 と理由。通れば公開し、その様式の今の版は退く。その事業所の新しい書類から使う（今の書類は作ったときの版のまま） | `{formVersion, problems}`／`422 {error:"not_publishable", problems}` |

### サイト管理者の入口（操作は `site.manage`）

| メソッドとパス | すること | 主な応答 |
|---|---|---|
| `GET /api/admin/me` | ログインしているサイト管理者 | `{siteAdmin:{name, email}}` |
| `GET /api/admin/offices` | 事業所の一覧（名前だけ） | `{offices:[{id, name, createdAt}]}` |
| `POST /api/admin/offices` | 事業所と、その最初の責任者を登録する（`{name, phone?, fax?, admin:{name, email}}`）。責任者のアカウントの作り方と 409 は `POST /api/office/staff` と同じ。409 のときは事業所も作らない。`audit_events` に `office.create` を残す | `201 {office, admin, accountCreated}` |

### ログインなしの入口（`public`）

| メソッドとパス | すること | 主な応答 |
|---|---|---|
| `PUT /api/dev-upload/:token` | ローカルの置き場だけ（本番の置き場では 404）。置き場が出した送信の token で確かめる。Cloud Storage と同じ約束（Content-Range、途中は 308） | — |
| `GET /api/dev-files/forms/*?from=&until=&sig=` | ローカルの置き場だけ（本番の置き場では 404）。期限つきの URL（署名つき URL と同じ約束。署名が違う・期限の外なら 403） | 画像・PDF |

## 入力の確かめ

- 体の形は zod で確かめる（`api/app.ts`）。
- 欄の値は、fields.json から作った型（`core/schema.ts`）で確かめる。選択肢にない値は 400。
- その書類の様式の版にない key・印字欄は 400（`db/repo.ts` の `allowedKeys`）。

## 誤りの返し方

| 状態 | いつ |
|---|---|
| 401 | トークンがない・正しくない。職員の入口で、`staff` にいない・止めた（サイト管理者も、職員の入口では 401） |
| 403 | 役割が、入口の宣言した操作を許さない。責任者が自分を止める・自分の役割を変える。サイト管理者の入口で、`site_admins` にいない |
| 404 | ない、ほかの事業所のもの、ID の形でない |
| 400 | 入力の形・値が違う |
| 409 | 登録しようとしたアカウントが、もう職員かサイト管理者（`already_registered`）。録音・様式の PDF がまだ置き場に届いていない。直しの元にした値（`base`）や様式の版が、サーバーで変わっていた（画面は読み直す）。公開した様式の版を直そうとした（`not_draft`） |
| 422 | 様式の下書きが、公開前の確かめを通らない（`not_publishable` と理由の一覧） |
| 503 | 様式の元の PDF が置き場にない（`npm run forms:assets`） |
| 500 | それ以外。ログには道と誤りの種類だけを出す（中身は出さない） |

## worker の道（非公開）

| メソッドとパス | 呼ぶもの | すること |
|---|---|---|
| `POST /tasks/jobs/:id/run` | Cloud Tasks（OIDC） | 録音 1 本の処理。応答の前に終える。失敗は 500（Cloud Tasks が間をあけてやり直す） |
| `POST /tasks/form-imports/:id/run` | Cloud Tasks（OIDC） | 上げた PDF から様式の下書きの版を作る（`worker/form-import/job.ts`）。期限つきの印で 1 回だけ動く。済んだら上げたままの PDF を消す。置き場か DB の誤りは 500（3 回で `failed`・`internal`）。変換の失敗（PDF でない など）は 200 で `failed` |
| `POST /tasks/reconcile` | Cloud Scheduler（5 分ごと） | 積み損ね・止まった処理を積み直す（録音と様式の取り込み）。失敗して 7 日たった・送り終わらなかった上げたままの PDF を消す |
| `GET /health` | — | worker が動いているか |

### 認定調査票の先行取り込み

`POST /api/documents/:id/survey-import` は、原本の対象者を確認した後、PC版のアセスメント用紙で選んだ候補を反映する。本文は `{fileName, sha256, recordedOn, changes: [{key, choice, base}]}`。調査日が不明なら `recordedOn: null` を送る。書類と事業所を照合し、選択肢番号はサーバー側で値に変換する。値が確認時から変わっていた場合は409を返し、選択分はすべて保留する。反映した値にはファイル名、SHA-256、原本ページ、選択肢番号、調査日を保存する。用紙の保存は既存の保存操作で行う。

「書類を取り込む」で認定調査票を読み取ると、該当する空欄に黄色の仮入力が出る。この時点の候補・原文・出典は画面のメモリにあり、右パネル内を移動しても保持する。候補を採用するときは、取り込み画面のファイル名から対象者と原本の印を確認し、用紙上で黄色の選択肢を押して保存する。既存の値と異なる候補や判読できない印は「確認する」に表示し、用紙上では担当者が修正する。現在の読み取りは、広島市版テキスト付き PDF の 2-2・2-4・2-5 が対象。

先行版は、広島市版のテキスト付きPDFの2-2・2-4・2-5のみ。PDFはブラウザ内で処理する。読み取れない印は候補にせず、特記事項は原文を画面に表示する。原本PDFの保存、写真・スキャンへの対応、録音との自動照合は後続の作業とする。
