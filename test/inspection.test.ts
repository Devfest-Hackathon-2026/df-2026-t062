// AI 点検（#113）: API → 裏の仕事（worker）→ 結果とこれまでの点検。AI は偽物。
// docs/再設計/16_書類と点検の基盤.md の「AI 点検」、13_DB設計.md の「点検」。
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Db } from '../db/pool.ts'
import type { WorkerDeps } from '../worker/jobs.ts'
import type { Llm } from '../worker/vertex/gemini.ts'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_inspect_${process.pid}`

type Answer = { level: string, missing?: string | null, met?: Record<string, boolean> }
/** 偽の AI の答え（項目の番号 → 段階）。書いていない項目は 2 */
let answers: Record<string, Answer> = {}
/** 偽の AI が受け取った指示文と、聞かれた項目 */
let asked: { prompt: string, ids: string[] }[] = []
let failAi = false

const fakeLlm = (): Llm => {
  let calls = 0
  return {
    ask: async (prompt, schema) => {
      if (failAi) throw Object.assign(new Error('boom'), { status: 500 })
      calls++
      const ids = Object.keys((schema as any).properties.results.properties)
      asked.push({ prompt: String(prompt), ids })
      return { results: Object.fromEntries(ids.map((id) => [id, { met: {}, missing: null, ...(answers[id] ?? { level: '2' }) }])) }
    },
    usage: () => ({ calls, promptTokens: 1000 * calls, cachedTokens: 0, outputTokens: 100 * calls, thinkingTokens: 0, yen: 0.5 * calls }),
  }
}

let db: Db
let workerDeps: WorkerDeps
let origin = ''
let close = async () => {}
const ids = { officeA: '', officeB: '', kai: '', kaiDoc: '', otherClient: '' }
const A = 'Bearer dev:kato@example.com'
const B = 'Bearer dev:other@example.com'

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
  const a = await seed(db)
  const b = await seed(db, { email: 'other@example.com', officeName: 'ほかの事業所' })
  ids.officeA = a.officeId
  ids.officeB = b.officeId
  ids.kai = a.clients.kai
  ids.otherClient = b.clients.kai
  ids.kaiDoc = (await db.query("SELECT id FROM documents WHERE client_id = $1 AND kind = 'assessment'", [ids.kai])).rows[0].id

  const { LocalStorage } = await import('../api/storage.ts')
  const storage = new LocalStorage(await mkdtemp(join(tmpdir(), 'careman-inspect-')))
  const f = await import('../worker/fake.ts')
  workerDeps = { db: async () => db, storage: () => storage, providers: async () => ({ stt: new f.FakeStt(), speakers: new f.FakeSpeakers(), writer: new f.FakeWriter(), formImport: f.fakeFormImport, inspect: fakeLlm }) }
  const { LocalQueue } = await import('../api/queue.ts')
  const { runInspection } = await import('../worker/inspect/job.ts')
  const queue = new LocalQueue(async () => {}, async () => {}, (id) => runInspection(workerDeps, id))
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

beforeEach(() => {
  answers = { 10: { level: '1', missing: '量（mL など）が書かれていない' }, 18: { level: '他' }, 20: { level: '3', missing: '（段階が 2 以上なので出さない）' } }
  asked = []
  failAi = false
})

/** 点検を始めて、終わるまで待つ */
async function inspect(clientId = ids.kai, token = A) {
  const started = await call(`/api/clients/${clientId}/inspections`, token, { method: 'POST', body: '{}' })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  const id = started.body.inspectionId as string
  for (let i = 0; i < 200; i++) {
    const r = await call(`/api/inspections/${id}`, token)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    if (!['queued', 'processing'].includes(r.body.inspection.status)) return r.body.inspection
    await new Promise((res) => setTimeout(res, 30))
  }
  throw new Error('点検が終わらない')
}

const values = async (documentId: string) =>
  (await db.query('SELECT key, value, by, ai_value, batch_id, updated_at FROM field_values WHERE document_id = $1 ORDER BY key', [documentId])).rows

test('点検: 32 項目すべての段階。段階 1 には足りない情報、2 以上には理由を返さない。書類の判定と分類ごとの数', { skip }, async () => {
  const before = await values(ids.kaiDoc)
  const r = await inspect()
  assert.equal(r.status, 'succeeded')
  assert.equal(r.checkSet, 'mhlw-careplan@2026-03')
  assert.deepEqual(r.items.map((i: any) => i.id), Array.from({ length: 32 }, (_, n) => String(n + 1)), '第1〜5表の 30 項目は一覧に入れない')
  const item = (id: string) => r.items.find((i: any) => i.id === id)

  // 13 BMI はプログラムで判定（演習シナリオの 1 回目に BMI は書いていない）。用紙に BMI の欄はない
  assert.deepEqual(item('13'), { id: '13', name: 'BMI', category: '疾病・心身状態の把握', level: '1', missing: 'BMI の数字が書かれていない', fieldKey: null, documentId: null })
  // 10 水分量は AI。用紙に欄なし
  assert.deepEqual(item('10'), { id: '10', name: '一日に摂取すべき水分量', category: '生活の全体像の把握', level: '1', missing: '量（mL など）が書かれていない', fieldKey: null, documentId: null })
  assert.equal(item('20').level, '3')
  assert.equal(item('20').missing, null, '段階 2 以上は理由を返さない')
  assert.equal(item('18').level, '他')
  // 欄がある項目は、押したときに移る欄（版にある最初の欄）と書類
  assert.equal(item('2').fieldKey, 'health.visits')
  assert.equal(item('2').documentId, ids.kaiDoc)

  // 31 家族構成図もプログラムで判定（演習シナリオの 1 回目に図はない）。今の版は図を印字欄に結んでいないので、用紙に欄なし
  assert.deepEqual(item('31'), { id: '31', name: '家族関係や周辺の社会資源との状況', category: '生活の全体像の把握', level: '1', missing: '家族構成図がない', fieldKey: null, documentId: null })

  assert.equal(r.verdict, '要確認')
  assert.equal(r.missingCount, 3)
  assert.equal(r.total, 32)
  assert.deepEqual(r.categories, [
    { category: '生活の全体像の把握', satisfied: 11, total: 13 },
    { category: '疾病・心身状態の把握', satisfied: 9, total: 10 },
    { category: '主訴・意思の把握・尊重', satisfied: 3, total: 3 },
    { category: '課題の分析', satisfied: 4, total: 4 },
    { category: '家族の状況の把握と支援', satisfied: 2, total: 2 },
  ], '「他」は満たしている側')
  assert.equal(r.createdBy, '加藤')
  assert.equal(r.latest, true)
  assert.equal(r.changed, false)

  // AI には、プログラムで決めた 13・31 を聞かない。指示文の先頭は書類（どの呼び出しも同じ）
  const all = asked.flatMap((a) => a.ids)
  assert.ok(!all.includes('13') && !all.includes('31'))
  assert.equal(all.length, 30)
  assert.ok(asked.length >= 2, '項目は分けて聞く')
  const head = asked[0].prompt.slice(0, asked[0].prompt.indexOf('## 点検する項目'))
  assert.ok(head.length > 200)
  for (const a of asked) assert.ok(a.prompt.startsWith(head), '先頭をそろえてキャッシュに当てる')
  assert.match(head, /氏名: /)

  // 点検は値を変えない
  assert.deepEqual(await values(ids.kaiDoc), before)
  // 段ごとの使った量を残す（中身は残さない）
  const row = (await db.query('SELECT steps, inputs, inputs_sha, check_set_sha FROM inspections WHERE id = $1', [r.id])).rows[0]
  assert.equal(row.steps.ai.calls, asked.length)
  assert.equal(row.steps.rule.items, 2)
  assert.match(row.inputs_sha, /^[0-9a-f]{64}$/)
  assert.match(row.check_set_sha, /^[0-9a-f]{16}$/)
  assert.deepEqual(row.inputs.map((d: any) => [d.documentId, d.kind]), [[ids.kaiDoc, 'assessment']])
  assert.ok(!JSON.stringify(row.steps).includes('甲斐'))
})

test('AI の答えの段階が、その項目の基準にないとき: その項目は判定できなかったとして段階を空にし、点検は「一部」', { skip }, async () => {
  answers['22'] = { level: '3' } // 22 は 1・2・他 だけ
  const r = await inspect()
  assert.equal(r.status, 'partial')
  const i22 = r.items.find((i: any) => i.id === '22')
  assert.equal(i22.level, null)
  assert.equal(r.total, 31, '判定できなかった項目は数えない')
})

test('これまでの点検: 新しい順。前の回の結果を開ける。いちばん新しい点検では、そのあとに書類の値が変わったかを返す', { skip }, async () => {
  const first = await inspect()
  answers['10'] = { level: '2' }
  const second = await inspect()
  const list = await call(`/api/clients/${ids.kai}/inspections`, A)
  assert.equal(list.status, 200)
  const mine = list.body.inspections.filter((x: any) => [first.id, second.id].includes(x.id))
  assert.deepEqual(mine.map((x: any) => x.id), [second.id, first.id])
  assert.deepEqual(Object.keys(mine[0]).sort(), ['createdAt', 'createdBy', 'id', 'missingCount', 'status', 'total', 'verdict'])
  assert.equal(mine[0].missingCount, 2)
  assert.equal(mine[1].missingCount, 3)

  // 前の回: latest ではない。変わったかは出さない
  const old = await call(`/api/inspections/${first.id}`, A)
  assert.equal(old.body.inspection.latest, false)
  assert.equal(old.body.inspection.changed, null)

  // 値を直すと、いちばん新しい点検に「変わった」が付く
  const doc = (await call(`/api/documents/${ids.kaiDoc}`, A)).body.document
  const base = doc.fields['health.notes']?.value ?? null
  const patched = await call(`/api/documents/${ids.kaiDoc}/fields`, A, { method: 'PATCH', body: JSON.stringify({ changes: [{ key: 'health.notes', value: `${base ?? ''} BMI 20.1`, base }] }) })
  assert.equal(patched.status, 200, JSON.stringify(patched.body))
  const now = await call(`/api/inspections/${second.id}`, A)
  assert.equal(now.body.inspection.changed, true)

  // もう一度点検すると、BMI はプログラムで 2 になる（残りは家族構成図だけ）
  answers['10'] = { level: '2' }
  const third = await inspect()
  assert.equal(third.items.find((i: any) => i.id === '13').level, '2')
  assert.equal(third.verdict, '要確認')
  assert.equal(third.missingCount, 1)
  assert.equal(third.changed, false)
})

test('点検中にもう一度始めても、同じ点検を返す（2 つ走らない）', { skip }, async () => {
  const { runInspection } = await import('../worker/inspect/job.ts')
  const created = (await db.query(
    "INSERT INTO inspections (office_id, client_id, check_set, check_set_sha, inputs, inputs_sha) VALUES ($1, $2, 'mhlw-careplan@2026-03', 'x', '[]', '') RETURNING id",
    [ids.officeA, ids.kai],
  )).rows[0].id
  const again = await call(`/api/clients/${ids.kai}/inspections`, A, { method: 'POST', body: '{}' })
  assert.equal(again.status, 202)
  assert.equal(again.body.inspectionId, created)
  await runInspection(workerDeps, created)
  assert.equal((await db.query('SELECT status FROM inspections WHERE id = $1', [created])).rows[0].status, 'succeeded')
})

test('AI が失敗したら、やり直せる状態に戻す。回数を使い切ったら failed', { skip }, async () => {
  const { runInspection } = await import('../worker/inspect/job.ts')
  failAi = true
  const id = (await call(`/api/clients/${ids.kai}/inspections`, A, { method: 'POST', body: '{}' })).body.inspectionId
  await new Promise((res) => setTimeout(res, 100))
  let row = (await db.query('SELECT status, attempts, error_kind FROM inspections WHERE id = $1', [id])).rows[0]
  assert.equal(row.status, 'queued')
  assert.equal(row.attempts, 1)
  await runInspection(workerDeps, id).catch(() => {})
  await runInspection(workerDeps, id).catch(() => {})
  row = (await db.query('SELECT status, attempts, error_kind FROM inspections WHERE id = $1', [id])).rows[0]
  assert.equal(row.status, 'failed')
  assert.equal(row.error_kind, 'Error')
  const r = await call(`/api/inspections/${id}`, A)
  assert.equal(r.body.inspection.status, 'failed')
  assert.deepEqual(r.body.inspection.items, [])
})

test('見回り: 積み損ねた点検・止まった点検を積み直す', { skip }, async () => {
  const { reconcileInspections } = await import('../worker/inspect/job.ts')
  const id = (await db.query(
    "INSERT INTO inspections (office_id, client_id, check_set, check_set_sha, inputs, inputs_sha, updated_at) VALUES ($1, $2, 'mhlw-careplan@2026-03', 'x', '[]', '', now() - interval '10 minutes') RETURNING id",
    [ids.officeA, ids.kai],
  )).rows[0].id
  const got: string[] = []
  await reconcileInspections(workerDeps, async (x) => { got.push(x) })
  assert.ok(got.includes(id))
  await db.query("UPDATE inspections SET status = 'failed' WHERE id = $1", [id])
})

test('権限: ほかの事業所の利用者・点検は 404。ログインしていなければ 401。物差しの名前が違えば 400', { skip }, async () => {
  const r = await inspect()
  assert.equal((await call(`/api/inspections/${r.id}`, B)).status, 404)
  assert.equal((await call(`/api/clients/${ids.kai}/inspections`, B)).status, 404)
  assert.equal((await call(`/api/clients/${ids.kai}/inspections`, B, { method: 'POST', body: '{}' })).status, 404)
  assert.equal((await fetch(`${origin}/api/inspections/${r.id}`)).status, 401)
  assert.equal((await call(`/api/clients/${ids.kai}/inspections`, A, { method: 'POST', body: JSON.stringify({ checkSet: 'mhlw-careplan@1999-01' }) })).status, 400)
  assert.equal((await call('/api/inspections/not-a-uuid', A)).status, 404)
})
