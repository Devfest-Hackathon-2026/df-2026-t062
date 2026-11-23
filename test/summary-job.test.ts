// 録音からの書き込み（作り替え、#114）の worker の流れ。DB は本物、AI は偽物。
// docs/再設計/17_録音からの書き込み.md の「テスト」の、要約（足すだけ・単体・API で返さない）と書類に入れる（ケアマネの値・日付）。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { Db } from '../db/pool.ts'
import type { Topic } from '../core/topics.ts'
import type { Storage } from '../api/storage.ts'
import { ZERO_USAGE, type Summarizer, type TopicWriter, type TopicWriterInput } from '../worker/types.ts'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_sumjob_${process.pid}`
let db: Db
let storage: Storage
let origin = ''
let close = async () => {}
const ids = { staff: null as unknown }
const CARE = 'Bearer dev:kato@example.com'

const call = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${origin}${path}`, { ...init, headers: { Authorization: CARE, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const type = res.headers.get('content-type') ?? ''
  return { status: res.status, text: '', body: (type.includes('json') ? await res.json() : null) as any }
}

const slot = (name: string) => ({ name, type: 'text' as const, content: '', position: { x: 20, y: 20 }, width: 80, height: 8, fontName: 'BIZUDPGothic', fontSize: 10 })
const MEETING_TOPICS: Topic[] = [
  { id: 'talk', name: '話し合ったこと', guide: '', by: 'ai', last: false },
  { id: 'overall', name: 'まとめ', guide: '', by: 'ai', last: true },
]

before(async () => {
  if (!url) return
  const { createPool } = await import('../db/pool.ts')
  const root = await createPool({ DATABASE_URL: url })
  await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
  await root.end()
  db = await createPool({ DATABASE_URL: url, DB_SCHEMA: schema })
  await (await import('../db/migrate.ts')).migrate(db)
  const a = await (await import('../db/seed.ts')).seed(db)
  ids.staff = a.staff
  // 単体（single）の種類: 担当者会議の記録のような、録音ごとに単体で使う種類
  await db.query("INSERT INTO form_kinds (key, name, per_client, topics, summary_mode) VALUES ('meeting', '担当者会議の記録', 'many', $1, 'single')", [JSON.stringify(MEETING_TOPICS)])
  const { registerVersion } = await import('../db/forms.ts')
  await registerVersion(db, {
    kind: 'meeting', name: '担当者会議の記録', title: '会議', officeId: null, basePdfSha256: 'c'.repeat(64),
    schemas: [[slot('本人の思い'), slot('まとめ')]],
    bindings: { 本人の思い: { op: 'text@1', ui: 'text', ref: { key: 'complaint.person' } }, まとめ: { op: 'text@1', ui: 'text', ref: { key: 'summary.overall' } } },
    pages: [{ no: 1, pdfIndex: 0, title: '会議', width: 210, height: 297 }],
  }, { publish: true })

  const { createApiServer } = await import('../api/server.ts')
  const { DevVerifier, DevAccounts } = await import('../api/auth.ts')
  const { LocalStorage } = await import('../api/storage.ts')
  storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'careman-sumjob-')))
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

/** 利用者を作る（主な書類のアセスメントも一緒にできる） */
async function newClient(name: string) {
  const r = await call('/api/clients', { method: 'POST', body: JSON.stringify({ name }) })
  assert.equal(r.status, 201)
  const client = (await call(`/api/clients/${r.body.id}`)).body
  return { id: r.body.id as string, documentId: client.client.documents.find((d: any) => d.kind === 'assessment').id as string }
}

/** 録音を 1 本上げてジョブを作る。recordedAt で録音の日を決める */
async function upload(clientId: string, documentId: string, recordedAt: string) {
  const { tx } = await import('../db/pool.ts')
  const repo = await import('../db/repo.ts')
  const staff = ids.staff as Parameters<typeof repo.createRecording>[1]
  await repo.grantRecordingConsent(db, staff, clientId)
  const rec = await tx(db, (c) => repo.createRecording(c, staff, clientId, 'audio/webm', randomUUID(), documentId))
  await db.query('UPDATE recordings SET recorded_at = $2 WHERE id = $1', [rec.id, recordedAt])
  const bytes = Buffer.alloc(2048)
  await storage.write('source', rec.objectPath, bytes, 'audio/webm')
  const jobId = await repo.completeRecording(db, staff, rec.id, 60_000, bytes.byteLength, (p) => storage.size('source', p))
  assert.ok(jobId)
  return { recordingId: rec.id as string, jobId: jobId! }
}

interface Seen { summarize: { topics: string[], utterances: number }[], write: TopicWriterInput[] }

/** 偽の要約（texts を返す）と、偽の書き手（values を返す）。渡されたものを seen に残す */
function providers(seen: Seen, texts: () => Record<string, string>, values: (input: TopicWriterInput) => Record<string, unknown>, opts: { failWriteOnce?: boolean } = {}) {
  let fail = opts.failWriteOnce ?? false
  const summarizer: Summarizer = {
    async summarize(input) {
      seen.summarize.push({ topics: input.topics.map((t) => t.id), utterances: input.utterances.length })
      return { texts: texts(), usage: ZERO_USAGE }
    },
  }
  const writer: TopicWriter = {
    async write(input) {
      seen.write.push(input)
      if (fail) { fail = false; throw new Error('書き手が落ちた') }
      const v = values(input)
      const ids = input.summaries.map((s) => s.id)
      return { values: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { value: x, cite: { kind: 'summary' as const, ids } }])), usage: ZERO_USAGE, failed: [], incompleteFields: [] }
    },
  }
  return import('../worker/fake.ts').then((f) => ({ stt: new f.FakeStt(), speakers: new f.FakeSpeakers(), formImport: f.fakeFormImport, recording: { summarizer, writer } }))
}

async function run(jobId: string, p: Awaited<ReturnType<typeof providers>>) {
  const { runJob } = await import('../worker/jobs.ts')
  await runJob({ db: async () => db, storage: () => storage, providers: async () => p as never }, jobId)
}

const summariesOf = async (documentId: string) =>
  (await db.query('SELECT id, recording_id, topic, text FROM recording_summaries WHERE document_id = $1 ORDER BY created_at, topic', [documentId])).rows
const fieldsOf = async (documentId: string) =>
  Object.fromEntries((await db.query('SELECT key, value, by, cite FROM field_values WHERE document_id = $1', [documentId])).rows.map((r) => [r.key, r]))

test('足していく種類（アセスメント）: 要約は足すだけで、前の回は変わらない。話に出なかった項目は行を作らない。2 回目は印つきで全部の要約を渡す', { skip }, async () => {
  const c = await newClient('要約の見本')
  const seen: Seen = { summarize: [], write: [] }
  let round = 1
  const p = await providers(seen,
    (): Record<string, string> => (round === 1 ? { health: '1 回目: 脳梗塞で入院した。', wishes: '1 回目:「自分でやりたい」', history: '' } : { wishes: '2 回目: 娘は「夜が心配」' }),
    (input) => (round === 1
      ? { 'complaint.person': '自分でやりたい。', 'health.history': '脳梗塞。', 'office.name': '勝手に書いた事業所' }
      : { 'complaint.person': '自分でやりたい。夜が心配。', 'health.history': 'AI の書き直し' }))

  const r1 = await upload(c.id, c.documentId, '2026-11-10T01:00:00Z')
  await run(r1.jobId, p)
  const s1 = await summariesOf(c.documentId)
  assert.deepEqual(s1.map((s) => s.topic).sort(), ['health', 'wishes'], '話に出なかった項目（空の要約も）は行を作らない')
  assert.deepEqual(seen.summarize[0].topics.includes('date'), false, '機械の項目は要約しない')
  assert.equal(seen.summarize[0].topics.length, 24, '23 項目と全体のまとめ')
  assert.equal(seen.write[0].showNew, false, '1 回目は印を付けない')
  assert.equal(seen.write[0].kindName, 'アセスメント')
  assert.deepEqual(seen.write[0].summaries.map((s) => [s.topic, s.seq, s.date, s.isNew]).sort(), [['health', 1, '2026-11-10', true], ['wishes', 1, '2026-11-10', true]])
  const f1 = await fieldsOf(c.documentId)
  assert.equal(f1['complaint.person'].value, '自分でやりたい。')
  assert.deepEqual(f1['complaint.person'].cite, { kind: 'summary', ids: seen.write[0].summaries.map((s) => s.id) }, '根拠は要約の行')
  assert.notEqual(f1['office.name']?.value, '勝手に書いた事業所', '事業所の設定は AI が書かない')
  assert.equal(f1['assessment.initialDate'].value, '2026-11-10', '1 回目は実施日（初回）')
  assert.equal(f1['assessment.updateDate'], undefined)
  const job1 = (await db.query('SELECT status, steps FROM jobs WHERE id = $1', [r1.jobId])).rows[0]
  assert.equal(job1.status, 'succeeded')
  assert.match(job1.steps.summarize.topics, /^[0-9a-f]{16}$/, '使った項目の一覧の指紋')
  assert.equal(job1.steps.summarize.summaries, 2)

  // ケアマネが既往歴を直す → 2 回目の録音
  const doc = (await call(`/api/documents/${c.documentId}`)).body.document
  const patched = await call(`/api/documents/${c.documentId}/fields`, { method: 'PATCH', body: JSON.stringify({ changes: [{ key: 'health.history', value: 'ケアマネが直した既往歴', base: doc.fields['health.history'].value }] }) })
  assert.equal(patched.status, 200)
  round = 2
  const r2 = await upload(c.id, c.documentId, '2026-11-24T01:00:00Z')
  await run(r2.jobId, p)
  const s2 = await summariesOf(c.documentId)
  assert.deepEqual(s2.filter((s) => s.recording_id === r1.recordingId), s1, '前の回の要約は変わらない')
  assert.deepEqual(s2.filter((s) => s.recording_id === r2.recordingId).map((s) => s.topic), ['wishes'])
  const w2 = seen.write[1]
  assert.equal(w2.showNew, true, '足していく種類の 2 回目からは印を付ける')
  assert.deepEqual(w2.summaries.map((s) => [s.topic, s.seq, s.isNew]).sort(), [['health', 1, false], ['wishes', 1, false], ['wishes', 2, true]], '1 回目からの要約を全部')
  assert.equal(w2.current['health.history'], 'ケアマネが直した既往歴', '欄の今の値を渡す')
  const f2 = await fieldsOf(c.documentId)
  assert.equal(f2['health.history'].value, 'ケアマネが直した既往歴', 'ケアマネが書いた値は書き換えない')
  assert.equal(f2['complaint.person'].value, '自分でやりたい。夜が心配。', 'AI が書いた値は書き直す')
  assert.equal(f2['assessment.initialDate'].value, '2026-11-10')
  assert.equal(f2['assessment.updateDate'].value, '2026-11-24', '2 回目からは実施日（更新）')
  await assert.rejects(db.query('UPDATE recording_summaries SET text = $2 WHERE id = $1', [s1[0].id, '書き換え']), /書き換えられません/)

  // 要約は API で返さない
  const texts = [...s2.map((s) => s.text)]
  for (const path of [`/api/documents/${c.documentId}`, `/api/clients/${c.id}`, `/api/clients/${c.id}/jobs`, '/api/clients']) {
    const res = await fetch(`${origin}${path}`, { headers: { Authorization: CARE } })
    assert.equal(res.status, 200, path)
    const body = await res.text()
    for (const t of texts) assert.ok(!body.includes(t), `${path} は要約を返さない`)
  }
})

test('単体の種類（担当者会議の記録）: 前の回の要約を使わない', { skip }, async () => {
  const c = await newClient('会議の見本')
  const created = await call(`/api/clients/${c.id}/documents`, { method: 'POST', body: JSON.stringify({ kind: 'meeting' }) })
  assert.equal(created.status, 201)
  const docId = created.body.id as string
  const seen: Seen = { summarize: [], write: [] }
  let n = 0
  const p = await providers(seen, () => ({ talk: `${++n} 回目の会議の話` }), () => ({ 'complaint.person': `${n} 回目の思い` }))
  const r1 = await upload(c.id, docId, '2026-11-10T01:00:00Z')
  await run(r1.jobId, p)
  const r2 = await upload(c.id, docId, '2026-11-24T01:00:00Z')
  await run(r2.jobId, p)
  assert.deepEqual(seen.summarize.map((s) => s.topics), [['talk', 'overall'], ['talk', 'overall']])
  assert.deepEqual(seen.write[1].summaries.map((s) => [s.text, s.isNew]), [['2 回目の会議の話', true]], '今回の録音の要約だけ')
  assert.equal(seen.write[1].showNew, false, '単体の種類は印を付けない')
  assert.equal((await summariesOf(docId)).length, 2, '要約は録音ごとに残る')
  assert.equal((await fieldsOf(docId))['complaint.person'].value, '2 回目の思い')
})

test('4 から先で失敗してやり直しても、要約はし直さない', { skip }, async () => {
  const c = await newClient('やり直しの見本')
  const seen: Seen = { summarize: [], write: [] }
  const p = await providers(seen, () => ({ adl: '杖で歩く' }), () => ({ 'complaint.person': 'やり直しで書いた' }), { failWriteOnce: true })
  const r = await upload(c.id, c.documentId, '2026-11-10T01:00:00Z')
  await assert.rejects(run(r.jobId, p), /書き手が落ちた/)
  assert.equal((await db.query('SELECT status FROM jobs WHERE id = $1', [r.jobId])).rows[0].status, 'queued')
  await run(r.jobId, p)
  assert.equal(seen.summarize.length, 1, '要約は 1 回だけ')
  assert.equal(seen.write.length, 2)
  assert.equal((await summariesOf(c.documentId)).length, 1)
  assert.equal((await fieldsOf(c.documentId))['complaint.person'].value, 'やり直しで書いた')
})

test('事業所が直した項目: 書き足しと足した項目を合わせた一覧を使い、指紋が替わる。直す前の録音は全体の一覧のまま', { skip }, async () => {
  const c = await newClient('事業所の項目の見本')
  const office = (await db.query('SELECT office_id FROM documents WHERE id = $1', [c.documentId])).rows[0].office_id
  const seen: Seen = { summarize: [], write: [] }
  const p = await providers(seen, () => ({ pet: '犬を飼っている' }), () => ({}))
  const before = await upload(c.id, c.documentId, '2026-11-10T01:00:00Z')
  await run(before.jobId, p)
  await db.query("INSERT INTO office_topics (office_id, kind, added, notes) VALUES ($1, 'assessment', $2, $3)",
    [office, JSON.stringify([{ id: 'pet', name: 'ペット', guide: 'ペットの有無と世話をする人' }]), JSON.stringify({ health: '1 日の水分量も聞く' })])
  const later = await upload(c.id, c.documentId, '2026-11-24T01:00:00Z')
  await run(later.jobId, p)
  assert.equal(seen.summarize[0].topics.includes('pet'), false, '直す前の録音は全体の一覧')
  assert.equal(seen.summarize[1].topics.includes('pet'), true, '直したあとの録音から効く')
  const topics = seen.write[1].topics
  assert.match(topics.find((t) => t.id === 'health')!.guide, /1 日の水分量も聞く/)
  const fp = async (jobId: string) => (await db.query('SELECT steps FROM jobs WHERE id = $1', [jobId])).rows[0].steps.summarize.topics
  assert.notEqual(await fp(before.jobId), await fp(later.jobId))
  assert.deepEqual((await summariesOf(c.documentId)).map((s) => s.topic), ['pet'], '直す前の録音で、一覧にない項目の答えは残さない')
})

test('まとめる項目が空の種類は、録音から書かない', { skip }, async () => {
  await db.query("INSERT INTO form_kinds (key, name, per_client, topics, summary_mode) VALUES ('notopics', '項目なし', 'many', '[]', 'single') ON CONFLICT DO NOTHING")
  const { registerVersion } = await import('../db/forms.ts')
  await registerVersion(db, {
    kind: 'notopics', name: '項目なし', title: '項目なし', officeId: null, basePdfSha256: 'd'.repeat(64),
    schemas: [[slot('本人の思い')]], bindings: { 本人の思い: { op: 'text@1', ui: 'text', ref: { key: 'complaint.person' } } },
    pages: [{ no: 1, pdfIndex: 0, title: '項目なし', width: 210, height: 297 }],
  }, { publish: true })
  const c = await newClient('項目なしの見本')
  const created = await call(`/api/clients/${c.id}/documents`, { method: 'POST', body: JSON.stringify({ kind: 'notopics' }) })
  const docId = created.body.id as string
  const seen: Seen = { summarize: [], write: [] }
  const p = await providers(seen, () => ({ health: '話' }), () => ({ 'complaint.person': '書かない' }))
  const r = await upload(c.id, docId, '2026-11-10T01:00:00Z')
  await run(r.jobId, p)
  assert.deepEqual([seen.summarize.length, seen.write.length], [0, 0])
  assert.equal((await db.query('SELECT status FROM jobs WHERE id = $1', [r.jobId])).rows[0].status, 'succeeded')
  assert.equal((await summariesOf(docId)).length, 0)
})

// #152: どの書類からでも録音できる。入院時情報提供書の録音は、入院時情報提供書の項目で要約し、その欄に書く
test('入院時情報提供書の録音: 入院時情報提供書の項目で要約し、その書類の欄に書く。要約は録音ごとに単体（前の回を使わない）', { skip }, async () => {
  const kind = (await db.query("SELECT topics, summary_mode FROM form_kinds WHERE key = 'admission'")).rows[0]
  const topics = kind.topics as Topic[]
  assert.equal(kind.summary_mode, 'single')
  assert.deepEqual(topics.map((t) => t.id), ['basic', 'family', 'wishes', 'homeOutlook', 'conference'])
  for (const t of topics) assert.ok(t.by === 'ai' && !t.last && t.guide.length >= 20, `${t.name} の説明`)

  const c = await newClient('入院の見本')
  const created = await call(`/api/clients/${c.id}/documents`, { method: 'POST', body: JSON.stringify({ kind: 'admission' }) })
  const docId = created.body.id as string
  const seen: Seen = { summarize: [], write: [] }
  const p = await providers(seen, () => ({ wishes: '本人は家に帰りたいと話した' }), () => ({ 'intention.person': '家に帰りたい' }))
  const r1 = await upload(c.id, docId, '2026-11-10T01:00:00Z')
  await run(r1.jobId, p)
  assert.deepEqual(seen.summarize[0].topics, ['basic', 'family', 'wishes', 'homeOutlook', 'conference'])
  assert.equal((await fieldsOf(docId))['intention.person']?.value, '家に帰りたい')
  assert.equal((await fieldsOf(c.documentId))['intention.person'], undefined, 'アセスメントには書かない')
  const r2 = await upload(c.id, docId, '2026-11-11T01:00:00Z')
  await run(r2.jobId, p)
  assert.deepEqual([seen.write[0].summaries.length, seen.write[1].summaries.length], [1, 1], '2 回目は前の回の要約を使わない')
})

test('本物の段（偽の Gemini）: 要約の行が DB に残り、欄の根拠はその行の id。選んでいない欄・切った文は入らない', { skip }, async () => {
  const c = await newClient('通しの見本')
  const { summarizer } = await import('../worker/vertex/summarizer.ts')
  const { topicWriter } = await import('../worker/vertex/topic-writer.ts')
  const steps: string[] = []
  const newLlm = () => ({
    ask: async (prompt: unknown, schema: any, meta: { step: string, group?: string | number }) => {
      steps.push(meta.step)
      if (meta.step === '要約') return { summaries: { wishes: '本人は「家で暮らしたい」と話す。', health: '血圧の薬を飲んでいる。' } }
      if (meta.step === '欄を選ぶ') {
        const keys: string[] = schema.properties.fields.items.properties.key.enum
        return { fields: [
          ...(keys.includes('complaint.person') ? [{ key: 'complaint.person', topics: ['wishes'] }] : []),
          ...(keys.includes('summary.overall') ? [{ key: 'summary.overall', topics: ['overall'] }] : []),
        ] }
      }
      if (meta.step === '書く') return { 'complaint.person': { value: '家で暮らしたい。録音によると、そう話した。', from: ['wishes-1'] } }
      if (meta.step === '全体のまとめ') return { 'summary.overall': { value: '家での暮らしを続ける。', from: ['wishes-1', 'health-1'] } }
      if (meta.step === '最後のチェック') return { cuts: meta.group === 'wishes' ? [{ id: 'complaint.person#1', reason: 'unneeded' }] : [] }
      throw new Error(`想定していない呼び出し: ${meta.step}`)
    },
    usage: () => ({ ...ZERO_USAGE }),
  })
  const f = await import('../worker/fake.ts')
  const p = { stt: new f.FakeStt(), speakers: new f.FakeSpeakers(), formImport: f.fakeFormImport, recording: { summarizer: summarizer(newLlm as never), writer: topicWriter(newLlm as never) } }
  const r = await upload(c.id, c.documentId, '2026-11-10T01:00:00Z')
  await run(r.jobId, p)
  const rows = await summariesOf(c.documentId)
  const idOf = (topic: string) => rows.find((x) => x.topic === topic)!.id
  const fields = await fieldsOf(c.documentId)
  assert.equal(fields['complaint.person'].value, '家で暮らしたい。', '切った文は入らない')
  assert.deepEqual(fields['complaint.person'].cite, { kind: 'summary', ids: [idOf('wishes')] })
  assert.deepEqual(fields['summary.overall'].cite, { kind: 'summary', ids: [idOf('wishes'), idOf('health')] })
  assert.equal(fields['health.history'], undefined, '選んでいない欄は書かない')
  assert.equal(fields['assessment.initialDate'].value, '2026-11-10')
  assert.equal(steps[0], '要約')
  assert.equal(steps.filter((x) => x === '要約').length, 1)
  const job = (await db.query('SELECT status, steps FROM jobs WHERE id = $1', [r.jobId])).rows[0]
  assert.equal(job.status, 'succeeded')
  assert.equal(job.steps.write.values, 2)
})

test('アセスメントのまとめる項目: AI の項目には、何をまとめるかの説明がある（id・名前・順は最初の一覧のまま）', { skip }, async () => {
  const topics = (await db.query("SELECT topics FROM form_kinds WHERE key = 'assessment'")).rows[0].topics as Topic[]
  assert.deepEqual(topics.map((t) => t.id), ['basic', 'history', 'socialSecurity', 'support', 'independencePhysical', 'independenceDementia', 'wishes', 'certification', 'reason', 'health', 'adl', 'iadl', 'cognition', 'communication', 'rhythm', 'excretion', 'hygiene', 'oral', 'eating', 'social', 'family', 'housing', 'other', 'overall', 'date'])
  assert.equal(topics.find((t) => t.id === 'basic')!.name, '基本情報（受付、利用者等基本情報）')
  for (const t of topics.filter((x) => x.by === 'ai')) assert.ok(t.guide.length >= 20, `${t.name} の説明`)
  assert.deepEqual(topics.find((t) => t.id === 'date'), { id: 'date', name: 'その日の日付', guide: '', by: 'machine', last: false, keys: { first: 'assessment.initialDate', later: 'assessment.updateDate' } })
  assert.deepEqual(topics.filter((t) => t.last).map((t) => t.id), ['overall'])
})
