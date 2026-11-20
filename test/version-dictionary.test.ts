// 版ごとの欄の辞書（#108 の 2 本目。docs/再設計/16_書類と点検の基盤.md の「欄の辞書（版ごと）」「録音から AI が書く欄」「書き方の相談（チャット）」）。
// fields.json と、その版の local_fields（事業所の様式だけの欄）を合わせて「版の欄の辞書」にし、
// 値の型の確かめ・印字欄の直し・録音から AI が書いてよい欄・チャットの道具が、どれもこの辞書を使う。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import { planBatch } from '../core/apply-batch.ts'
import type { Bindings } from '../core/binding.ts'
import { fieldDict, writableFields, type LocalField } from '../core/dictionary.ts'
import { FIELD_LIST, choicesOf, subFieldsOf } from '../core/fields.ts'
import { toFormDef, type FormDef, type TemplateSlot } from '../core/form.ts'
import { validValue } from '../core/schema.ts'
import { editSlot } from '../core/slots.ts'
import { seedFormDef } from '../forms/admin/files.ts'
import { candidateFields } from '../worker/vertex/common.ts'
import { runChat, type ChatDocument, type ChatModel, type Content, type Part } from '../api/chat.ts'
import type { Db } from '../db/pool.ts'

/** 事業所の様式だけの欄。note のない欄（訪問の回数）は、AI は書かない */
const LOCAL: LocalField[] = [
  { key: 'local.meetingPlace', label: '面談の場所', type: 'text', note: '面談をした場所（自宅・病院など）' },
  { key: 'local.visitCount', label: '訪問の回数', type: 'number' },
  { key: 'local.hasPet', label: 'ペットを飼っている', type: 'bool', note: '家で動物を飼っているか' },
  { key: 'local.mood', label: 'きょうの様子', type: 'enum', choices: ['良い', '普通', '悪い'], note: '面談のときの本人の様子' },
  { key: 'local.nextVisit', label: '次の訪問日', type: 'date', note: '次に訪ねる日' },
]

const text = (name: string, y: number): TemplateSlot => ({ name, type: 'text', position: { x: 20, y }, width: 60, height: 8 })
const circle = (name: string, y: number): TemplateSlot => ({ name, type: 'circleMark', position: { x: 20, y }, width: 6, height: 6 })

/** 事業所の様式（1 ページ）。fields.json の欄（氏名・住所・事業所名・家族）と、その様式だけの欄を読む。主介護者の印は「◎」（全体のアセスメントは「※」） */
const SCHEMAS: TemplateSlot[][] = [[
  text('氏名', 20), text('住所', 30), text('事業所', 40), text('家族1', 50),
  text('場所', 60), text('回数', 70), circle('ペット', 80), text('様子', 90), text('次回', 100),
]]
const BINDINGS: Bindings = {
  氏名: { op: 'text@1', ui: 'text', ref: { key: 'person.name' } },
  住所: { op: 'text@1', ui: 'text', ref: { key: 'person.address' } },
  事業所: { op: 'text@1', ui: 'text', ref: { key: 'office.name' } },
  家族1: { op: 'text@1', ui: 'text', ref: { key: 'family.members', path: [0, 'name'] }, prefix: { text: '◎', flag: 'isMainCaregiver' } },
  場所: { op: 'text@1', ui: 'text', ref: { key: 'local.meetingPlace' } },
  回数: { op: 'text@1', ui: 'text', ref: { key: 'local.visitCount' } },
  ペット: { op: 'option@1', ui: 'circle', ref: { key: 'local.hasPet' }, is: { eq: true } },
  様子: { op: 'text@1', ui: 'text', ref: { key: 'local.mood' } },
  次回: { op: 'text@1', ui: 'text', ref: { key: 'local.nextVisit' } },
} as Bindings
const PAGES = [{ no: 1, pdfIndex: 0, title: '面談票', width: 210, height: 297 }]

const OFFICE_FORM: FormDef = toFormDef({
  id: 'office-v1', kind: 'kinddict', name: '事業所の面談票', version: 1, contentSha: 'x',
  schemas: SCHEMAS, bindings: BINDINGS, pages: PAGES, localFields: LOCAL,
})

// ---------- 辞書と値の型 ----------

test('辞書: fields.json の欄と、その版の local_fields を合わせる。local_fields のない版は fields.json だけ', () => {
  const d = fieldDict(LOCAL)
  assert.equal(d.get('local.mood')?.label, 'きょうの様子')
  assert.deepEqual(choicesOf(d.get('local.mood')!), ['良い', '普通', '悪い'])
  assert.equal(d.get('person.name')?.label, FIELD_LIST.find((f) => f.key === 'person.name')!.label)
  assert.equal(fieldDict([]).get('local.mood'), undefined)
  assert.equal(fieldDict(undefined).get('person.name')?.label, d.get('person.name')?.label)
})

test('値の型の確かめ: その様式だけの欄も、版の辞書の型で確かめる（fields.json だけでは通らない）', () => {
  const d = fieldDict(LOCAL)
  const ok: [string, unknown][] = [['local.meetingPlace', '自宅'], ['local.visitCount', 3], ['local.hasPet', true], ['local.mood', '普通'], ['local.nextVisit', '2026-12-01']]
  for (const [k, v] of ok) {
    assert.ok(validValue(k, v, {}, d), `${k} = ${JSON.stringify(v)} は通る`)
    assert.equal(validValue(k, v), false, `${k} は fields.json にはない`)
  }
  const ng: [string, unknown][] = [['local.meetingPlace', 3], ['local.visitCount', '3回'], ['local.hasPet', 'はい'], ['local.mood', 'とても良い'], ['local.nextVisit', '2026-02-30'], ['local.unknown', 'x']]
  for (const [k, v] of ng) assert.equal(validValue(k, v, {}, d), false, `${k} = ${JSON.stringify(v)} は通らない`)
  // fields.json の欄は今までどおり
  assert.ok(validValue('intake.method', '訪問', {}, d))
  assert.equal(validValue('intake.method', '手紙', {}, d), false)
})

test('用紙の直し: その様式だけの欄も、版の辞書の型で値になる（数・選ぶ・丸・日付）', () => {
  assert.deepEqual(editSlot(OFFICE_FORM, {}, '場所', '自宅'), { changes: [{ key: 'local.meetingPlace', value: '自宅' }] })
  assert.deepEqual(editSlot(OFFICE_FORM, {}, '回数', '１２'), { changes: [{ key: 'local.visitCount', value: 12 }] })
  assert.deepEqual(editSlot(OFFICE_FORM, {}, '様子', '良い'), { changes: [{ key: 'local.mood', value: '良い' }] })
  assert.match((editSlot(OFFICE_FORM, {}, '様子', 'とても良い') as { reason: string }).reason, /良い・普通・悪い/)
  assert.deepEqual(editSlot(OFFICE_FORM, {}, 'ペット', 'true'), { changes: [{ key: 'local.hasPet', value: true }] })
  assert.deepEqual(editSlot(OFFICE_FORM, {}, '次回', '2026-12-01'), { changes: [{ key: 'local.nextVisit', value: '2026-12-01' }] })
  assert.ok('reason' in editSlot(OFFICE_FORM, {}, '次回', '来週'), '日付にならない文字は断る')
})

// ---------- 録音から AI が書いてよい欄 ----------

test('録音から AI が書いてよい欄: 版が読む欄のうち、出どころに会話・書類・案がある欄。その様式だけの欄は説明書き（note）があるものだけ', () => {
  const globals = FIELD_LIST.map((f) => f.key).filter((k) => ['person.name', 'person.address', 'family.members'].includes(k))
  assert.deepEqual(writableFields(OFFICE_FORM).map((f) => f.key), [...globals, 'local.meetingPlace', 'local.hasPet', 'local.mood', 'local.nextVisit'],
    '事業所の設定（office.name）と、note のない欄（local.visitCount）は入らない。fields.json の順、その様式だけの欄は local_fields の順')
})

test('全体のアセスメントの様式では、録音から書く欄（2 層改の欄の候補）は今と同じ。指示文の「用紙の場所」も変わらない（今の動きの固定）', () => {
  // 今まで: fields.json で「アセスメント用紙にある」とした欄のうち、出どころに会話・書類・案がある欄（図は除く）
  const legacy = FIELD_LIST.filter((f) => f.forms && 'assess' in f.forms && f.type !== 'image' && (f.source ?? []).some((s) => ['talk', 'doc', 'draft'].includes(s.split(':')[0])))
  const sub = (s: (typeof FIELD_LIST)[number]) => ({ key: s.key, label: s.label ?? s.key, type: s.type, choices: s.choices ? choicesOf(s) : null })
  const expected = legacy.map((f) => ({
    key: f.key, label: f.label, type: f.type, item23: f.item23 ?? null,
    choices: f.choices ? choicesOf(f) : null,
    subs: f.type === 'object' || f.type === 'list' ? subFieldsOf(f).map(sub) : null,
    note: f.note ?? null, where: f.forms!.assess, source: f.source ?? [],
  }))
  assert.ok(expected.length > 200)
  assert.deepEqual(candidateFields(seedFormDef('assessment')), expected)
})

test('2 層改の欄の候補: 事業所の様式では、その様式だけの欄（note あり）も入る。用紙の場所は版のページから', () => {
  const specs = candidateFields(OFFICE_FORM)
  const mood = specs.find((s) => s.key === 'local.mood')!
  assert.deepEqual([mood.label, mood.type, mood.choices, mood.note, mood.item23, mood.source], ['きょうの様子', 'enum', ['良い', '普通', '悪い'], '面談のときの本人の様子', null, []])
  assert.match(mood.where, /p\.1 面談票/)
  assert.equal(specs.some((s) => s.key === 'local.visitCount'), false)
  assert.equal(specs.some((s) => s.key === 'intake.method'), false, '版が読まない欄は入らない')
})

test('AI の書き込みの計画: その様式だけの欄は、説明書き（note）のあるものだけ書く', () => {
  const plan = planBatch({}, { 'local.mood': { value: '良い' }, 'local.visitCount': { value: 3 }, 'office.name': { value: '別の事業所' } }, new Set(), fieldDict(LOCAL))
  assert.deepEqual(plan.changes.map((c) => c.key), ['local.mood'])
  assert.deepEqual(plan.skipped, [{ key: 'local.visitCount', reason: 'not-ai-field' }, { key: 'office.name', reason: 'not-ai-field' }])
})

// ---------- チャット ----------

const call = (name: string, args: Record<string, unknown> = {}): Part => ({ functionCall: { name, args }, thoughtSignature: `sig-${name}` })
function scripted(turns: Part[][]) {
  const seen: { system: string, contents: Content[] }[] = []
  const model: ChatModel = async ({ system, contents }) => {
    seen.push({ system, contents: structuredClone(contents) })
    return turns[seen.length - 1] ?? [{ text: '（台本の終わり）' }]
  }
  return { model, seen }
}
const responsesOf = (seen: { contents: Content[] }[], n: number, name: string) =>
  seen[n].contents.at(-1)!.parts.filter((p) => p.functionResponse?.name === name).map((p) => p.functionResponse!.response as Record<string, any>)

test('チャット: 開いている書類の版から、欄の辞書・印字するときだけ付く印・種類の名前を読む（事業所の様式でも）', async () => {
  const doc: ChatDocument = {
    kind: 'kinddict', name: '事業所の面談票', form: OFFICE_FORM,
    fields: { 'local.mood': { value: '良い', by: 'ai' }, 'family.members': { value: [{ name: '春子', isMainCaregiver: true }], by: 'ai' } },
  }
  const { model, seen } = scripted([
    [call('read_form', {})],
    [call('propose_edit', { key: 'local.meetingPlace', value: '自宅' }), call('propose_edit', { key: 'intake.method', value: '訪問' }), call('propose_edit', { key: 'local.visitCount', value: '3' })],
    [{ text: '案を出しました' }],
  ])
  const r = await runChat({ model, document: doc, recordings: [], messages: [{ role: 'user', text: '場所を書いて' }] })
  assert.match(seen[0].system, /事業所の面談票/)
  const read = responsesOf(seen, 1, 'read_form')[0]
  assert.equal(read.document, '事業所の面談票')
  assert.deepEqual(read.filled.find((f: any) => f.key === 'local.mood'), { key: 'local.mood', label: 'きょうの様子', type: 'enum', value: '良い' })
  assert.match(read.filled.find((f: any) => f.key === 'family.members').printed, /◎/, '印の説明は、この版の対応から（全体のアセスメントの「※」ではない）')
  assert.deepEqual(read.emptyText.find((f: any) => f.key === 'local.meetingPlace'), { key: 'local.meetingPlace', label: '面談の場所', note: '面談をした場所（自宅・病院など）' })
  assert.equal([...read.filled, ...read.emptyText, ...(read.empty ?? [])].some((f: any) => f.key === 'intake.method'), false, '版が読まない欄は出さない')
  const [place, method, count] = responsesOf(seen, 2, 'propose_edit')
  assert.equal(place.ok, true)
  assert.match(method.reason, /この書類にない欄です/)
  assert.equal(count.ok, true, 'その様式だけの数の欄も、辞書の型で受ける')
  assert.deepEqual(r.proposals.map((p) => [p.key, p.label, p.after]), [['local.meetingPlace', '面談の場所', '自宅'], ['local.visitCount', '訪問の回数', 3]])
})

// ---------- API と worker（DB） ----------

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_dict_${process.pid}`
let db: Db
let origin = ''
let close = async () => {}
const ids = { clientA: '', staffA: null as unknown }
const CARE = 'Bearer dev:kato@example.com'

const call2 = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${origin}${path}`, { ...init, headers: { Authorization: CARE, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, body: (type.includes('json') ? await res.json() : null) as any }
}

before(async () => {
  if (!url) return
  const { createPool } = await import('../db/pool.ts')
  const root = await createPool({ DATABASE_URL: url })
  await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
  await root.end()
  db = await createPool({ DATABASE_URL: url, DB_SCHEMA: schema })
  await (await import('../db/migrate.ts')).migrate(db)
  const a = await (await import('../db/seed.ts')).seed(db)
  Object.assign(ids, { clientA: a.clients.sato, staffA: a.staff })
  await db.query("INSERT INTO form_kinds (key, name, per_client) VALUES ('kinddict', '事業所の面談票', 'many')")
  const { registerVersion } = await import('../db/forms.ts')
  await registerVersion(db, {
    kind: 'kinddict', name: '事業所の面談票', title: '面談票', officeId: null, basePdfSha256: 'b'.repeat(64),
    schemas: SCHEMAS, bindings: BINDINGS, pages: PAGES, localFields: LOCAL,
  }, { publish: true })

  const { createApiServer } = await import('../api/server.ts')
  const { DevVerifier, DevAccounts } = await import('../api/auth.ts')
  const { LocalStorage } = await import('../api/storage.ts')
  const storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'careman-dict-')))
  const server = createApiServer({ db: async () => db, verifier: () => new DevVerifier(), storage: () => storage, queue: () => ({ async enqueue() {}, async enqueueFormImport() {}, async enqueueInspection() {} }), devAuth: true, accounts: () => new DevAccounts() })
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

async function newDocument() {
  const r = await call2(`/api/clients/${ids.clientA}/documents`, { method: 'POST', body: JSON.stringify({ kind: 'kinddict' }) })
  assert.equal(r.status, 201)
  return (await call2(`/api/documents/${r.body.id}`)).body.document
}

test('API: 様式の版はその様式だけの欄の定義を渡し、直し（PATCH）と用紙の直しは、版の辞書で確かめる', { skip }, async () => {
  const doc = await newDocument()
  const v = await call2(`/api/form-versions/${doc.formVersionId}`)
  assert.deepEqual(v.body.formVersion.localFields, LOCAL, '画面も同じ辞書で直しを確かめる')

  const patch = (changes: object[]) => call2(`/api/documents/${doc.id}/fields`, { method: 'PATCH', body: JSON.stringify({ changes }) })
  const ok = await patch([{ key: 'local.visitCount', value: 3, base: null }])
  assert.equal(ok.status, 200)
  assert.deepEqual([ok.body.document.fields['local.visitCount'].value, ok.body.document.fields['local.visitCount'].by], [3, 'cm'])
  assert.equal((await patch([{ key: 'local.mood', value: 'とても良い', base: null }])).status, 400, '選択肢にない')
  assert.equal((await patch([{ key: 'local.visitCount', value: '3回', base: 3 }])).status, 400, '数でない')
  assert.equal((await patch([{ key: 'intake.method', value: '訪問', base: null }])).status, 400, 'この版が読まない欄')

  const edits = await call2(`/api/documents/${doc.id}/edits`, { method: 'POST', body: JSON.stringify({ formVersionId: doc.formVersionId, edits: [{ slot: '様子', text: '普通' }, { slot: 'ペット', text: 'true' }, { slot: '回数', text: '多い' }] }) })
  assert.equal(edits.status, 200)
  assert.deepEqual(edits.body.results.map((x: any) => [x.slot, !!x.reason]), [['様子', false], ['ペット', false], ['回数', true]])
  const after = (await call2(`/api/documents/${doc.id}`)).body.document
  assert.deepEqual([after.fields['local.mood'].value, after.fields['local.hasPet'].value, after.fields['local.visitCount'].value], ['普通', true, 3])
})

test('worker: 録音から書く欄は、録音がつながった書類の版から決まる。版が読まない欄と、note のない欄は書かない', { skip }, async () => {
  const doc = await newDocument()
  const { tx } = await import('../db/pool.ts')
  const repo = await import('../db/repo.ts')
  const { runJob } = await import('../worker/jobs.ts')
  const { FakeSpeakers, FakeStt, fakeFormImport } = await import('../worker/fake.ts')
  const { ZERO_USAGE } = await import('../worker/types.ts')
  const { LocalStorage } = await import('../api/storage.ts')
  const storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'careman-dict-worker-')))
  const staff = ids.staffA as Parameters<typeof repo.createRecording>[1]
  const rec = await tx(db, (c) => repo.createRecording(c, staff, ids.clientA, 'audio/webm', randomUUID(), doc.id))
  const bytes = Buffer.alloc(4096)
  await storage.write('source', rec.objectPath, bytes)
  const jobId = await repo.completeRecording(db, staff, rec.id, 60_000, bytes.byteLength, (p) => storage.size('source', p))
  assert.ok(jobId)

  let seenForm: FormDef | undefined
  const write = async (input: { form: FormDef }) => {
    seenForm = input.form
    const v = (value: unknown) => ({ value, cite: [] as string[] })
    return {
      values: { 'local.mood': v('良い'), 'local.visitCount': v(5), 'intake.method': v('訪問'), 'person.address': v('見本市 2-2'), 'local.nextVisit': v('2026-13-01') },
      usage: ZERO_USAGE, failed: [] as string[], incompleteFields: [] as string[],
    }
  }
  const providers = { stt: new FakeStt(), speakers: new FakeSpeakers(), writer: { write }, formImport: fakeFormImport }
  await runJob({ db: async () => db, storage: () => storage, providers: async () => providers as never }, jobId!)

  assert.equal(seenForm?.id, doc.formVersionId, '書き手には、録音がつながった書類の版を渡す')
  assert.deepEqual(seenForm?.localFields, LOCAL)
  const rows = (await db.query('SELECT key, value, by FROM field_values WHERE document_id = $1 ORDER BY key', [doc.id])).rows
  const written = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  assert.equal(written['local.mood'], '良い')
  assert.equal(written['person.address'], '見本市 2-2')
  assert.equal(written['local.visitCount'], undefined, 'note のない、その様式だけの欄は書かない')
  assert.equal(written['intake.method'], undefined, '版が読まない欄は書かない')
  assert.equal(written['local.nextVisit'], undefined, '型の合わない値は落とす')
  const job = (await db.query('SELECT steps FROM jobs WHERE id = $1', [jobId])).rows[0]
  assert.deepEqual(job.steps.write.droppedFields, ['local.nextVisit'])
})
