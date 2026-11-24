// 様式の取り込み（#103）: 上げた PDF → 変換のジョブ → 下書きの版。API・置き場・worker・DB を通しで確かめる（Gemini は偽物）。
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { generate } from '@pdfme/generator'
import { text, rectangle } from '@pdfme/schemas'
import type { Storage } from '../api/storage.ts'
import type { Db } from '../db/pool.ts'
import type { WorkerDeps } from '../worker/jobs.ts'
import type { Llm } from '../worker/vertex/gemini.ts'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_fimport_${process.pid}`

const font = { BIZUDPGothic: { data: readFileSync(new URL('../forms/fonts/BIZUDPGothic-Regular.ttf', import.meta.url)), fallback: true, subset: true } }
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** 架空の白紙の用紙（枠と「氏名」「開催場所」の文字）。label を変えると別の PDF になる */
async function formPdf(label = '氏名'): Promise<Uint8Array> {
  const t = (name: string, y: number) => ({ name, type: 'text', position: { x: 20, y }, width: 30, height: 8, fontName: 'BIZUDPGothic', fontSize: 12, alignment: 'left', verticalAlignment: 'top', lineHeight: 1, characterSpacing: 0, fontColor: '#000000', content: '' })
  const r = (name: string, y: number) => ({ name, type: 'rectangle', position: { x: 60, y }, width: 40, height: 10, borderWidth: 0.3, borderColor: '#000000', color: '', readOnly: true, content: '' })
  const pdf = await generate({
    template: { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[r('枠1', 30), t('名1', 32), r('枠2', 50), t('名2', 52)]] } as never,
    inputs: [{ 名1: label, 名2: '開催場所' }], plugins: { text, rectangle }, options: { font },
  })
  return new Uint8Array(pdf)
}

/** 1 回目は「氏名」（共通の欄）と「開催場所」（その様式だけの欄）、見直しは直すところなし、と答える偽の Gemini */
const fakeLlm = (): Llm => ({
  ask: async (_p, _s, meta) => (meta.step === '様式の欄'
    ? {
        slots: [
          { x: 61, y: 31, w: 38, h: 8, ui: 'text', ref: 'person.name', label: '氏名', confidence: 1 },
          { x: 61, y: 51, w: 38, h: 8, ui: 'text', ref: 'local.meetingPlace', label: '開催場所', confidence: 1 },
        ],
        localFields: [{ key: 'local.meetingPlace', label: '開催場所', type: 'text' }],
      }
    : { slots: [], fixes: [], removes: [], localFields: [] }),
  usage: () => ({ calls: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, thinkingTokens: 0, yen: 0 }),
})

let db: Db
let storage: Storage
let workerDeps: WorkerDeps
let origin = ''
let close = async () => {}
const ids = { officeA: '', officeB: '' }
const ADMIN_A = 'Bearer dev:admin-a@example.com'
const ADMIN_B = 'Bearer dev:admin-b@example.com'
const SITE = 'Bearer dev:site@example.com'

const call = async (path: string, token: string, init: RequestInit = {}) => {
  const res = await fetch(`${origin}${path}`, { ...init, headers: { Authorization: token, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, body: (type.includes('json') ? await res.json() : null) as Record<string, any> }
}

before(async () => {
  if (!url) return
  const { createPool } = await import('../db/pool.ts')
  const root = await createPool({ DATABASE_URL: url })
  await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
  await root.end()
  db = await createPool({ DATABASE_URL: url, DB_SCHEMA: schema })
  await (await import('../db/migrate.ts')).migrate(db)
  const { seed } = await import('../db/seed.ts')
  ids.officeA = (await seed(db)).officeId
  ids.officeB = (await seed(db, { email: 'other@example.com', officeName: 'ほかの事業所' })).officeId
  for (const [office, email] of [[ids.officeA, 'admin-a@example.com'], [ids.officeB, 'admin-b@example.com']]) {
    await db.query("INSERT INTO staff (office_id, auth_uid, name, email, role) VALUES ($1, $2, '責任者', $3, 'admin')", [office, `dev:${email}`, email])
  }
  await db.query("INSERT INTO site_admins (auth_uid, name, email) VALUES ('dev:site@example.com', 'サイト管理者', 'site@example.com')")

  process.env.PUBLIC_API_ORIGIN = ''
  const { LocalStorage } = await import('../api/storage.ts')
  storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'careman-fimport-')))
  const f = await import('../worker/fake.ts')
  workerDeps = { db: async () => db, storage: () => storage, providers: async () => ({ stt: new f.FakeStt(), speakers: new f.FakeSpeakers(), formImport: fakeLlm, recording: { summarizer: new f.FakeSummarizer(), writer: new f.FakeTopicWriter() } }) }
  const { LocalQueue } = await import('../api/queue.ts')
  const { runFormImport } = await import('../worker/form-import/job.ts')
  const queue = new LocalQueue(async () => {}, (id) => runFormImport(workerDeps, id))
  const { createApiServer } = await import('../api/server.ts')
  const { DevVerifier } = await import('../api/auth.ts')
  const server = createApiServer({ db: async () => db, verifier: () => new DevVerifier(), storage: () => storage, queue: () => queue, devAuth: true })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = async () => {
    await new Promise<void>((r) => server.close(() => r()))
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await db.end()
  }
})

after(async () => close())

/** 取り込みを作り、PDF を送り、送り終わりを伝える */
async function upload(prefix: '/api/office' | '/api/admin', token: string, pdf: Uint8Array, kind = 'assessment') {
  const created = await call(`${prefix}/form-imports`, token, { method: 'POST', body: JSON.stringify({ kind }) })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const put = await fetch(`${origin}${created.body.uploadUrl}`, { method: 'PUT', body: Buffer.from(pdf) })
  assert.equal(put.status, 200)
  const id = created.body.import.id as string
  return { id, complete: await call(`${prefix}/form-imports/${id}/complete`, token, { method: 'POST', body: '{}' }) }
}

/** 変換が終わるまで待つ（LocalQueue は同じプロセスで動く） */
async function settled(prefix: '/api/office' | '/api/admin', token: string, id: string) {
  for (let i = 0; i < 200; i++) {
    const r = await call(`${prefix}/form-imports/${id}`, token)
    if (!['queued', 'processing'].includes(r.body.import.status)) return r.body.import
    await new Promise((res) => setTimeout(res, 50))
  }
  throw new Error('変換が終わらない')
}

const row = async (id: string) => (await db.query('SELECT * FROM form_imports WHERE id = $1', [id])).rows[0]

/** 上げたままの PDF を消した印（upload_deleted_at）が付くまで待つ。消すのは status を書いたあと（worker）なので、status だけ待つと印がまだ付いていないことがある */
async function uploadRemoved(id: string) {
  for (let i = 0; i < 200; i++) {
    if ((await row(id)).upload_deleted_at) return
    await new Promise((res) => setTimeout(res, 50))
  }
  throw new Error('上げたままの PDF の印が付かない')
}

test('責任者: PDF を上げる → 送り終わり → 変換 → 自分の事業所の様式の下書きの版。元の PDF と画像は事業所の場所に置き、上げたままの PDF は消す', { skip }, async () => {
  const pdf = await formPdf()
  const { id, complete } = await upload('/api/office', ADMIN_A, pdf)
  assert.equal(complete.status, 202)
  assert.equal(complete.body.import.uploaded, true)
  const done = await settled('/api/office', ADMIN_A, id)
  assert.equal(done.status, 'succeeded', JSON.stringify(done))
  assert.deepEqual(done.review, [])
  await uploadRemoved(id)

  const v = (await db.query(
    `SELECT v.status, v.version, v.bindings, v.local_fields, v.base_pdf_sha256, v.pages, t.office_id, t.kind
     FROM form_template_versions v JOIN form_templates t ON t.id = v.template_id WHERE v.id = $1`, [done.versionId],
  )).rows[0]
  assert.equal(v.status, 'draft', '下書き（書類からは指せない）')
  assert.equal(v.office_id, ids.officeA)
  assert.equal(v.kind, 'assessment')
  assert.equal(v.base_pdf_sha256, sha(pdf))
  assert.deepEqual(Object.values(v.bindings).map((b: any) => b.ref.key).sort(), ['local.meetingPlace', 'person.name'])
  assert.deepEqual(v.local_fields, [{ key: 'local.meetingPlace', label: '開催場所', type: 'text' }])

  assert.ok(await storage.size('forms', `offices/${ids.officeA}/pdf/${sha(pdf)}/base.pdf`), '元の PDF は事業所の場所')
  assert.ok(await storage.size('forms', `offices/${ids.officeA}/pdf/${sha(pdf)}/pages/p1.png`), 'ページの画像も')
  assert.equal(await storage.size('forms', `pdf/${sha(pdf)}/base.pdf`), null, '全体の場所には置かない')
  assert.equal(await storage.size('forms', `offices/${ids.officeA}/imports/${id}.pdf`), null, '上げたままの PDF は消した')
  assert.ok((await row(id)).upload_deleted_at)

  // 同じ事業所でもう一度上げると、同じ様式の次の版（下書き）になる
  const again = await upload('/api/office', ADMIN_A, await formPdf('氏　名'))
  const second = await settled('/api/office', ADMIN_A, again.id)
  const versions = (await db.query('SELECT version FROM form_template_versions WHERE id = ANY($1::uuid[]) ORDER BY version', [[done.versionId, second.versionId]])).rows.map((r) => r.version)
  assert.deepEqual(versions, [1, 2])
})

test('送る前に送り終わりを伝えると 409。種類がなければ 400。ほかの事業所の取り込みは 404 で、一覧にも出ない', { skip }, async () => {
  const created = await call('/api/office/form-imports', ADMIN_A, { method: 'POST', body: JSON.stringify({ kind: 'assessment' }) })
  const id = created.body.import.id
  assert.equal((await call(`/api/office/form-imports/${id}/complete`, ADMIN_A, { method: 'POST', body: '{}' })).status, 409)
  assert.equal((await call(`/api/office/form-imports/${id}`, ADMIN_A)).body.import.uploaded, false)
  assert.equal((await call('/api/office/form-imports', ADMIN_A, { method: 'POST', body: JSON.stringify({ kind: 'nothing' }) })).status, 400)
  assert.equal((await call(`/api/office/form-imports/${id}`, ADMIN_B)).status, 404)
  assert.equal((await call(`/api/office/form-imports/${id}/complete`, ADMIN_B, { method: 'POST', body: '{}' })).status, 404)
  assert.equal((await call(`/api/admin/form-imports/${id}`, SITE)).status, 404, '事業所の取り込みは、全体の入口からも見えない')
  const listB = (await call('/api/office/form-imports', ADMIN_B)).body.imports as { id: string }[]
  assert.ok(!listB.some((i) => i.id === id))
  const listA = (await call('/api/office/form-imports', ADMIN_A)).body.imports as { id: string }[]
  assert.ok(listA.some((i) => i.id === id))
})

test('サイト管理者: 全体の様式の取り込み。置き場は imports/<id>.pdf、下書きは全体の様式の次の版', { skip }, async () => {
  const pdf = await formPdf('氏名（全体）')
  const created = await call('/api/admin/form-imports', SITE, { method: 'POST', body: JSON.stringify({ kind: 'admission' }) })
  const id = created.body.import.id as string
  await fetch(`${origin}${created.body.uploadUrl}`, { method: 'PUT', body: Buffer.from(pdf) })
  assert.ok(await storage.size('forms', `imports/${id}.pdf`))
  assert.equal((await call(`/api/admin/form-imports/${id}/complete`, SITE, { method: 'POST', body: '{}' })).status, 202)
  const done = await settled('/api/admin', SITE, id)
  assert.equal(done.status, 'succeeded')
  const v = (await db.query('SELECT v.status, v.version, t.office_id FROM form_template_versions v JOIN form_templates t ON t.id = v.template_id WHERE v.id = $1', [done.versionId])).rows[0]
  assert.deepEqual([v.status, v.office_id, v.version > 1], ['draft', null, true], '全体の入院時情報提供書の、次の版の下書き')
  assert.ok(await storage.size('forms', `pdf/${sha(pdf)}/base.pdf`))
  assert.equal((await call(`/api/office/form-imports/${id}`, ADMIN_A)).status, 404, '全体の取り込みは、事業所の入口からは見えない')
})

test('登録済みの全体の様式と同じ PDF なら matched（変換せず、下書きも作らない）', { skip }, async () => {
  const pdf = await formPdf('全体と同じ用紙')
  // 全体の様式（試しの種類）を、この PDF で公開しておく
  await db.query("INSERT INTO form_kinds (key, name) VALUES ('matchtest', '試しの種類')")
  const { registerVersion } = await import('../db/forms.ts')
  const { readSeed } = await import('../forms/admin/files.ts')
  const seed = readSeed('admission')
  const global = await registerVersion(db, { ...seed, kind: 'matchtest' as never, name: '試し', title: '試し', basePdfSha256: sha(pdf) }, { publish: true })
  let asked = 0
  const before = workerDeps.providers
  workerDeps.providers = async () => ({ ...(await before()), formImport: () => ({ ...fakeLlm(), ask: async () => { asked++; return {} } }) })
  try {
    const { id } = await upload('/api/office', ADMIN_B, pdf, 'matchtest')
    const done = await settled('/api/office', ADMIN_B, id)
    assert.equal(done.status, 'matched')
    assert.equal(done.versionId, global.versionId)
    assert.equal(asked, 0, 'AI を呼ばない')
    assert.equal((await db.query("SELECT count(*) AS n FROM form_templates WHERE kind = 'matchtest' AND office_id = $1", [ids.officeB])).rows[0].n, '0')
    assert.equal(await storage.size('forms', `offices/${ids.officeB}/imports/${id}.pdf`), null)
  } finally {
    workerDeps.providers = before
  }
})

test('変換の失敗（PDF でない）は failed と種類。上げたままの PDF は残す（7 日たってから見回りが消す）', { skip }, async () => {
  const { id } = await upload('/api/office', ADMIN_A, new TextEncoder().encode('PDF ではない'))
  const done = await settled('/api/office', ADMIN_A, id)
  assert.deepEqual([done.status, done.errorKind, done.versionId], ['failed', 'invalid_pdf', null])
  assert.ok(await storage.size('forms', `offices/${ids.officeA}/imports/${id}.pdf`))

  const { reconcileFormImports } = await import('../worker/form-import/job.ts')
  await reconcileFormImports(workerDeps, async () => {})
  assert.ok(await storage.size('forms', `offices/${ids.officeA}/imports/${id}.pdf`), '7 日たつまでは消さない')
  await db.query("UPDATE form_imports SET updated_at = now() - interval '8 days' WHERE id = $1", [id])
  await reconcileFormImports(workerDeps, async () => {})
  assert.equal(await storage.size('forms', `offices/${ids.officeA}/imports/${id}.pdf`), null)
  assert.ok((await row(id)).upload_deleted_at)
})

test('大きすぎる PDF は、送り終わりの時点で failed（too_large）。変換に回さない', { skip }, async () => {
  const imports = await import('../db/form-imports.ts')
  const imp = await imports.createImport(db, { officeId: ids.officeA }, 'assessment', null)
  await storage.write('forms', `offices/${ids.officeA}/imports/${imp.id}.pdf`, new Uint8Array(100), 'application/pdf')
  const r = await imports.markUploaded(db, { officeId: ids.officeA }, imp.id, (p) => storage.size('forms', p), 10)
  assert.deepEqual([r?.status, r?.errorKind], ['failed', 'too_large'])
  assert.equal(await imports.claimImport(db, imp.id, randomUUID()), null, 'worker は始めない')
})

test('同じ取り込みが 2 回届いても、変換は 1 回だけ。済んだ取り込みにもう一度届いても何もしない', { skip }, async () => {
  const imports = await import('../db/form-imports.ts')
  const { runFormImport } = await import('../worker/form-import/job.ts')
  const pdf = await formPdf('二重')
  const imp = await imports.createImport(db, { officeId: ids.officeB }, 'assessment', null)
  await storage.write('forms', `offices/${ids.officeB}/imports/${imp.id}.pdf`, pdf, 'application/pdf')
  await imports.markUploaded(db, { officeId: ids.officeB }, imp.id, (p) => storage.size('forms', p), imports.MAX_IMPORT_BYTES)
  let asked = 0
  const deps: WorkerDeps = { ...workerDeps, providers: async () => ({ ...(await workerDeps.providers()), formImport: () => ({ ...fakeLlm(), ask: async (p, s, m) => { asked++; return fakeLlm().ask(p, s, m) } }) }) }
  await Promise.all([runFormImport(deps, imp.id), runFormImport(deps, imp.id)])
  const calls = asked
  await runFormImport(deps, imp.id)
  assert.equal(asked, calls, '済んだあとは AI を呼ばない')
  assert.equal((await row(imp.id)).status, 'succeeded')
  assert.equal((await row(imp.id)).attempts, 1)
  assert.equal((await db.query('SELECT count(*) AS n FROM form_template_versions WHERE base_pdf_sha256 = $1', [sha(pdf)])).rows[0].n, '1')
})

test('置き場の誤りで止まったら queued に戻して、やり直す。3 回で failed（internal）', { skip }, async () => {
  const imports = await import('../db/form-imports.ts')
  const { runFormImport } = await import('../worker/form-import/job.ts')
  const imp = await imports.createImport(db, { officeId: ids.officeA }, 'assessment', null)
  await storage.write('forms', `offices/${ids.officeA}/imports/${imp.id}.pdf`, await formPdf('止まる'), 'application/pdf')
  await imports.markUploaded(db, { officeId: ids.officeA }, imp.id, (p) => storage.size('forms', p), imports.MAX_IMPORT_BYTES)
  const broken: WorkerDeps = { ...workerDeps, storage: () => ({ ...storage, read: async () => { throw new Error('storage down') } }) }
  for (let n = 1; n <= 3; n++) {
    await assert.rejects(runFormImport(broken, imp.id))
    const r = await row(imp.id)
    assert.deepEqual([r.status, r.attempts, r.error_kind], n < 3 ? ['queued', n, null] : ['failed', 3, 'internal'])
  }
})

test('見回り: 積み損ね（送り終わって 2 分）と期限の切れた変換を積み直す。送り終わっていないものは積まない', { skip }, async () => {
  const imports = await import('../db/form-imports.ts')
  const { reconcileFormImports } = await import('../worker/form-import/job.ts')
  const mk = async () => (await imports.createImport(db, { officeId: ids.officeB }, 'assessment', null)).id
  const [waiting, stuck, notSent, fresh] = [await mk(), await mk(), await mk(), await mk()]
  await db.query("UPDATE form_imports SET uploaded_at = now(), updated_at = now() - interval '5 minutes' WHERE id = $1", [waiting])
  await db.query("UPDATE form_imports SET uploaded_at = now(), status = 'processing', attempts = 1, run_token = 'old', lease_until = now() - interval '1 minute' WHERE id = $1", [stuck])
  await db.query("UPDATE form_imports SET updated_at = now() - interval '5 minutes' WHERE id = $1", [notSent])
  await db.query('UPDATE form_imports SET uploaded_at = now() WHERE id = $1', [fresh])
  const sent: string[] = []
  await reconcileFormImports(workerDeps, async (id) => { sent.push(id) })
  assert.ok(sent.includes(waiting) && sent.includes(stuck))
  assert.ok(!sent.includes(notSent) && !sent.includes(fresh))
})

test('印の期限が切れて、ほかの実行が引き継いだら、古い実行は下書きを作らない', { skip }, async () => {
  const imports = await import('../db/form-imports.ts')
  const imp = await imports.createImport(db, { officeId: ids.officeB }, 'admission', null)
  await db.query('UPDATE form_imports SET uploaded_at = now() WHERE id = $1', [imp.id])
  const first = (await imports.claimImport(db, imp.id, 'first'))!
  await db.query("UPDATE form_imports SET lease_until = now() - interval '1 second' WHERE id = $1", [imp.id])
  assert.ok(await imports.claimImport(db, imp.id, 'second'))
  const draft = { schemas: [[]], bindings: {}, pages: [{ no: 1, pdfIndex: 0, title: '1 ページ', width: 210, height: 297 }], localFields: [], review: [] }
  assert.equal(await imports.finishWithDraft(db, first, 'first', 'a'.repeat(64), draft), null)
  assert.equal(await imports.extendImportLease(db, imp.id, 'first'), false)
  assert.equal((await row(imp.id)).version_id, null)
})
