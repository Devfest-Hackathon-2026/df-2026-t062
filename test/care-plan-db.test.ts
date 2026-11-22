// ケアプラン（#90）の DB の決まり。計画版・第1〜3表・安定 ID・AI 原案の根拠・確定スナップショット。
// PostgreSQL が要る（DATABASE_URL がなければ飛ばす）。ファイルごとに別のスキーマを使う。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import type { Db } from '../db/pool.ts'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_careplan_${process.pid}`

let db: Db
let officeId = ''
let otherOfficeId = ''
let staffId = ''
let clientId = ''
let otherClientId = ''
let assessmentVersionId = ''
const carePlanVersionIds: Record<number, string> = {}

interface PlanFixture {
  id: string
  seriesId: string
  version: number
  documents: Record<1 | 2 | 3, { id: string, seq: number }>
}

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> => {
  const r = await db.query(sql, params)
  return r.rows[0] as T
}

const all = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
  const r = await db.query(sql, params)
  return r.rows as T[]
}

/** テストごとに混ざらないよう、そのテストだけの利用者を作る */
async function newClient(name: string, office = officeId): Promise<string> {
  return (await one<{ id: string }>('INSERT INTO clients (office_id, name) VALUES ($1,$2) RETURNING id', [office, name])).id
}

async function nextSeq(client: string, kind: string): Promise<number> {
  return Number((await one<{ n: string }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM documents WHERE client_id = $1 AND kind = $2', [client, kind])).n)
}

async function createDocument(office: string, client: string, kind: string, version: string): Promise<{ id: string, seq: number }> {
  const seq = await nextSeq(client, kind)
  const r = await one<{ id: string }>(
    'INSERT INTO documents (office_id, client_id, kind, seq, template_version_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [office, client, kind, seq, version, staffId],
  )
  return { id: r.id, seq }
}

/** 計画版を1つ作る（3書類と結び付きまで）。 */
async function makePlan(opts: {
  office?: string
  client?: string
  seriesId?: string
  version?: number
  previousPlanId?: string | null
  effectiveFrom?: string
  effectiveTo?: string | null
  status?: 'draft' | 'confirmed'
} = {}): Promise<PlanFixture> {
  const office = opts.office ?? officeId
  const client = opts.client ?? clientId
  const seriesId = opts.seriesId ?? randomUUID()
  const version = opts.version ?? 1
  const status = opts.status ?? 'draft'
  // 書類は下書きの間だけ結び付けられる。確定は書類を作ったあとに行う（本番の流れと同じ）
  const plan = await one<{ id: string }>(
    `INSERT INTO care_plans (office_id, client_id, plan_series_id, version, status, effective_from, effective_to, previous_plan_id, created_by)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8) RETURNING id`,
    [office, client, seriesId, version, opts.effectiveFrom ?? '2026-04-01', opts.effectiveTo === undefined ? '2027-03-31' : opts.effectiveTo,
      opts.previousPlanId ?? null, staffId],
  )
  const docs = {} as PlanFixture['documents']
  for (const formNo of [1, 2, 3] as const) {
    const kind = `care_plan_${formNo}`
    const doc = await createDocument(office, client, kind, carePlanVersionIds[formNo])
    await db.query('INSERT INTO care_plan_documents (plan_id, form_no, document_id) VALUES ($1,$2,$3)', [plan.id, formNo, doc.id])
    docs[formNo] = doc
  }
  if (status === 'confirmed') {
    await db.query("UPDATE care_plans SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2 WHERE id = $1", [plan.id, staffId])
  }
  return { id: plan.id, seriesId, version, documents: docs }
}

/** 第2表の1ニーズ（長期目標・短期目標・サービス）と第3表の枠を1つ作る。 */
async function addNeed(planId: string, text: string, ordinal = 1): Promise<{ needId: string, goalId: string, serviceId: string, slotId: string }> {
  const need = await one<{ id: string }>(
    'INSERT INTO care_plan_needs (plan_id, ordinal, need_text) VALUES ($1,$2,$3) RETURNING id',
    [planId, ordinal, text],
  )
  const goal = await one<{ id: string }>(
    "INSERT INTO care_plan_goals (plan_id, need_id, level, ordinal, goal_text) VALUES ($1,$2,'short',1,$3) RETURNING id",
    [planId, need.id, `${text}の短期目標`],
  )
  const service = await one<{ id: string }>(
    "INSERT INTO care_plan_services (plan_id, need_id, short_goal_id, goal_level, ordinal, content) VALUES ($1,$2,$3,'short',1,$4) RETURNING id",
    [planId, need.id, goal.id, `${text}のサービス`],
  )
  const slot = await one<{ id: string }>(
    "INSERT INTO care_plan_service_slots (plan_id, service_id, schedule_type, weekday, start_time, end_time) VALUES ($1,$2,'weekly',1,'09:00','10:00') RETURNING id",
    [planId, service.id],
  )
  return { needId: need.id, goalId: goal.id, serviceId: service.id, slotId: slot.id }
}

async function addRevision(documentId: string, rev: number, values: Record<string, unknown>): Promise<{ id: string }> {
  const version = await one<{ template_version_id: string }>('SELECT template_version_id FROM documents WHERE id = $1', [documentId])
  return one<{ id: string }>(
    'INSERT INTO revisions (office_id, document_id, rev, scope, "values", template_version_id, saved_by) VALUES ($1,$2,$3,\'document\',$4,$5,$6) RETURNING id',
    [officeId, documentId, rev, JSON.stringify(values), version.template_version_id, staffId],
  )
}

before(async () => {
  if (!url) return
  const { createPool } = await import('../db/pool.ts')
  const admin = await createPool({ DATABASE_URL: url })
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
  await admin.end()
  db = await createPool({ DATABASE_URL: url, DB_SCHEMA: schema })
  const { migrate } = await import('../db/migrate.ts')
  await migrate(db)

  officeId = (await one<{ id: string }>("INSERT INTO offices (name) VALUES ('ケアプラン試験事業所') RETURNING id")).id
  otherOfficeId = (await one<{ id: string }>("INSERT INTO offices (name) VALUES ('ほかの事業所') RETURNING id")).id
  staffId = (await one<{ id: string }>(
    "INSERT INTO staff (office_id, auth_uid, name, email, role) VALUES ($1,'dev:careplan@example.com','試験 ケアマネ','careplan@example.com','caremanager') RETURNING id",
    [officeId],
  )).id
  clientId = (await one<{ id: string }>("INSERT INTO clients (office_id, name) VALUES ($1,'計画 花子') RETURNING id", [officeId])).id
  otherClientId = (await one<{ id: string }>("INSERT INTO clients (office_id, name) VALUES ($1,'ほか 太郎') RETURNING id", [otherOfficeId])).id

  // 試験用の様式。中身は入院時情報提供書のものを借り、種類だけケアプランにする（PDF の印字はこのテストでは使わない）
  const forms = await import('../db/forms.ts')
  const { readSeed } = await import('../forms/admin/files.ts')
  assessmentVersionId = (await forms.registerVersion(db, readSeed('assessment'), { publish: true })).versionId
  for (const formNo of [1, 2, 3] as const) {
    carePlanVersionIds[formNo] = (await forms.registerVersion(db, {
      ...readSeed('admission'),
      kind: `care_plan_${formNo}`,
      name: `ケアプラン第${formNo}表（試験）`,
      title: `ケアプラン第${formNo}表（試験）`,
    }, { publish: true })).versionId
  }
})

after(async () => {
  if (!db) return
  await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await db.end()
})

test('ケアプランの種類は行で登録され、第1表だけアセスメントから写す', { skip }, async () => {
  const rows = await all<{ key: string, per_client: string, is_primary: boolean, create_from: string | null, required: unknown[] }>(
    "SELECT key, per_client, is_primary, create_from, required FROM form_kinds WHERE key LIKE 'care_plan\\_%' ORDER BY key",
  )
  assert.deepEqual(rows.map((r) => r.key), ['care_plan_1', 'care_plan_2', 'care_plan_3', 'care_plan_4', 'care_plan_5', 'care_plan_6', 'care_plan_7'])
  for (const r of rows) {
    assert.equal(r.per_client, 'many')
    assert.equal(r.is_primary, false)
    assert.deepEqual(r.required, [])
  }
  assert.equal(rows[0].create_from, 'assessment')
  assert.equal(rows[1].create_from, null)
  assert.equal(rows[2].create_from, null)
  assert.equal(rows[3].create_from, 'assessment')

  // ケアプランの書類は、計画版に1つずつ結び付く
  const plan = await makePlan()
  assert.deepEqual(plan.documents[1] && [plan.documents[1].seq, plan.documents[2].seq, plan.documents[3].seq], [1, 1, 1])
  const links = await all<{ form_no: number, kind: string }>(
    'SELECT c.form_no, d.kind FROM care_plan_documents c JOIN documents d ON d.id = c.document_id WHERE c.plan_id = $1 ORDER BY c.form_no',
    [plan.id],
  )
  assert.deepEqual(links, [{ form_no: 1, kind: 'care_plan_1' }, { form_no: 2, kind: 'care_plan_2' }, { form_no: 3, kind: 'care_plan_3' }])

  // 同じ書類を2つの計画版に結び付けられない
  const other = await makePlan({ seriesId: randomUUID(), version: 1 })
  await assert.rejects(
    db.query('UPDATE care_plan_documents SET document_id = $1 WHERE plan_id = $2 AND form_no = 2', [plan.documents[1].id, other.id]),
    /duplicate|一意|unique/i,
  )
  // 種類の違う書類は結び付けられない
  const wrong = await createDocument(officeId, clientId, 'care_plan_2', carePlanVersionIds[2])
  await assert.rejects(
    db.query('INSERT INTO care_plan_documents (plan_id, form_no, document_id) VALUES ($1,1,$2)', [other.id, wrong.id]),
    /種類|kind|care_plan/i,
  )
})

test('計画版が違えば、書類・ニーズ・サービス・枠は混ざらない。安定 ID は並べ替えで変わらない', { skip }, async () => {
  const client = await newClient('版 次郎')
  const seriesId = randomUUID()
  const first = await makePlan({ client, seriesId, version: 1 })
  const second = await makePlan({ client, seriesId, version: 2, previousPlanId: first.id, effectiveFrom: '2027-04-01', effectiveTo: null })
  assert.equal(first.documents[1].seq, 1)
  assert.equal(second.documents[1].seq, 2, '計画版が違えば documents.seq は進む')

  const a = await addNeed(first.id, '甲のニーズ', 1)
  const b = await addNeed(second.id, '乙のニーズ', 1)
  const a2 = await addNeed(first.id, '甲の2つ目', 2)

  // 計画版で絞ると、別の計画版の行は見えない
  const needs = await all<{ id: string, need_text: string }>('SELECT id, need_text FROM care_plan_needs WHERE plan_id = $1 ORDER BY ordinal', [first.id])
  assert.deepEqual(needs.map((n) => n.need_text), ['甲のニーズ', '甲の2つ目'])
  const otherNeeds = await all<{ id: string }>('SELECT id FROM care_plan_needs WHERE plan_id = $1', [second.id])
  assert.deepEqual(otherNeeds.map((n) => n.id), [b.needId])

  // 並べ替えても id は変わらない（一意制約は遅延可能なので、1 トランザクションで付け直せる）
  await db.query('BEGIN')
  await db.query('UPDATE care_plan_needs SET ordinal = CASE WHEN id = $2 THEN 1 ELSE 2 END WHERE plan_id = $1', [first.id, a2.needId])
  await db.query('COMMIT')
  const reordered = await all<{ id: string }>('SELECT id FROM care_plan_needs WHERE plan_id = $1 ORDER BY ordinal', [first.id])
  assert.deepEqual(reordered.map((n) => n.id), [a2.needId, a.needId])

  // ニーズを消すと、そのニーズの目標・サービス・枠だけが消える
  await db.query('DELETE FROM care_plan_needs WHERE id = $1', [a.needId])
  for (const [table, id] of [['care_plan_goals', a.goalId], ['care_plan_services', a.serviceId], ['care_plan_service_slots', a.slotId]] as const) {
    const n = await one<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE id = $1`, [id])
    assert.equal(Number(n.n), 0, `${table} はニーズと一緒に消える`)
  }
  assert.equal(Number((await one<{ n: string }>('SELECT count(*) AS n FROM care_plan_needs WHERE id = $1', [b.needId])).n), 1, '別の計画版は残る')
  assert.equal(Number((await one<{ n: string }>('SELECT count(*) AS n FROM care_plan_services WHERE id = $1', [b.serviceId])).n), 1)
})

test('計画版の一意制約と適用期間', { skip }, async () => {
  const client = await newClient('確定 三郎')
  const seriesId = randomUUID()
  const first = await makePlan({ client, seriesId, version: 1 })
  await assert.rejects(
    db.query("INSERT INTO care_plans (office_id, client_id, plan_series_id, version, effective_from) VALUES ($1,$2,$3,1,'2026-04-01')", [officeId, client, seriesId]),
    /care_plans_series_version_key|duplicate|一意/i,
  )
  await assert.rejects(
    makePlan({ client, seriesId, version: 2, previousPlanId: first.id, effectiveFrom: '2026-04-01', effectiveTo: '2026-03-31' }),
    /care_plans_period|check/i,
  )
  // 確定は同じ利用者に1つだけ
  const confirmed = await makePlan({ client, seriesId, version: 2, previousPlanId: first.id, status: 'confirmed' })
  await assert.rejects(
    makePlan({ client, seriesId: randomUUID(), version: 1, status: 'confirmed' }),
    /care_plans_one_confirmed|duplicate|一意/i,
  )
  // 状態は draft → confirmed → superseded の順だけ
  await assert.rejects(
    db.query("UPDATE care_plans SET status = 'draft', confirmed_at = NULL, confirmed_by = NULL WHERE id = $1", [confirmed.id]),
    /状態|draft|confirmed|superseded/i,
  )
})

test('第3表の曜日・時刻・週単位以外の決まり', { skip }, async () => {
  const plan = await makePlan()
  const x = await addNeed(plan.id, '入浴のニーズ')

  const insert = (values: string, params: unknown[]) => db.query(
    `INSERT INTO care_plan_service_slots (plan_id, service_id, schedule_type, weekday, start_time, end_time, ends_next_day, note)
     VALUES ($1,$2,${values})`,
    [plan.id, x.serviceId, ...params],
  )
  // 同じサービス・曜日・時刻・翌日フラグの重複は落ちる
  await assert.rejects(insert("'weekly',1,'09:00','10:00',false,null", []), /duplicate|一意|unique/i)
  // 曜日は 1〜7
  await assert.rejects(insert("'weekly',0,'09:00','10:00',false,null", []), /check|weekday/i)
  await assert.rejects(insert("'weekly',8,'09:00','10:00',false,null", []), /check|weekday/i)
  // 同じ日は開始 < 終了
  await assert.rejects(insert("'weekly',2,'10:00','10:00',false,null", []), /check|invalid_time|時刻/i)
  await assert.rejects(insert("'weekly',2,'11:00','10:00',false,null", []), /check|invalid_time|時刻/i)
  // 翌日にまたぐときは終了 < 開始
  await assert.rejects(insert("'weekly',3,'09:00','10:00',true,null", []), /check|invalid_time|時刻/i)
  assert.ok(await insert("'weekly',3,'22:00','02:00',true,null", []))
  // 週単位以外は時刻を持たず、note が要る
  await assert.rejects(insert("'other',null,null,null,false,null", []), /check|invalid_other|note/i)
  assert.ok(await insert("'other',null,null,null,false,'月2回'", []))
  // サービスの期間は plan の期間の外でもよいが、前後が逆はだめ
  await assert.rejects(
    db.query("UPDATE care_plan_services SET period_from = '2027-04-01', period_to = '2026-04-01' WHERE id = $1", [x.serviceId]),
    /check|period/i,
  )
})

test('AI 原案は保存済みアセスメントの版を指し、あとからアセスメントが変わっても動かない', { skip }, async () => {
  const plan = await makePlan()
  const assessment = await createDocument(officeId, clientId, 'assessment', assessmentVersionId)
  const rev1 = await addRevision(assessment.id, 1, { 'plan.intentionAnalysis': '最初の意向', 'person.name': '計画 花子' })
  const draft = await one<{ id: string, source_revision_id: string, source_revision_rev: number, proposal: unknown }>(
    `INSERT INTO care_plan_ai_drafts (office_id, client_id, plan_id, source_document_id, source_revision_id, source_revision_rev, source_form_version_id, source_saved_at, proposal, created_by)
     SELECT $1,$2,$3,$4,$5,$6,r.template_version_id,r.saved_at,$7,$8 FROM revisions r WHERE r.id = $5 RETURNING id, source_revision_id, source_revision_rev, proposal`,
    [officeId, clientId, plan.id, assessment.id, rev1.id, 1, JSON.stringify({ plan1: { 'plan.intentionAnalysis': '原案' } }), staffId],
  )
  assert.equal(draft.source_revision_rev, 1)

  // アセスメントを更新しても、前の保存版と原案は変わらない
  const rev2 = await addRevision(assessment.id, 2, { 'plan.intentionAnalysis': '直した意向', 'person.name': '計画 花子' })
  assert.notEqual(rev1.id, rev2.id)
  assert.equal((await one<{ value: string }>("SELECT \"values\"->>'plan.intentionAnalysis' AS value FROM revisions WHERE id = $1", [rev1.id])).value, '最初の意向')
  const after = await one<{ source_revision_id: string, proposal: { plan1: { 'plan.intentionAnalysis': string } } }>(
    'SELECT source_revision_id, proposal FROM care_plan_ai_drafts WHERE id = $1',
    [draft.id],
  )
  assert.equal(after.source_revision_id, rev1.id)
  assert.equal(after.proposal.plan1['plan.intentionAnalysis'], '原案')

  // 版番号が保存版と違う原案は作れない
  await assert.rejects(
    db.query(
      `INSERT INTO care_plan_ai_drafts (office_id, client_id, plan_id, source_document_id, source_revision_id, source_revision_rev, source_form_version_id, source_saved_at, proposal)
       SELECT $1,$2,$3,$4,$5,99,r.template_version_id,r.saved_at,'{}' FROM revisions r WHERE r.id = $5`,
      [officeId, clientId, plan.id, assessment.id, rev1.id],
    ),
    /版番号|revision_rev|check/i,
  )
  // ほかの書類の保存版を、別の書類として指せない
  const otherDoc = await createDocument(officeId, clientId, 'admission', carePlanVersionIds[1])
  await assert.rejects(
    db.query(
      `INSERT INTO care_plan_ai_drafts (office_id, client_id, plan_id, source_document_id, source_revision_id, source_revision_rev, source_form_version_id, source_saved_at, proposal)
       SELECT $1,$2,$3,$4,$5,1,r.template_version_id,r.saved_at,'{}' FROM revisions r WHERE r.id = $5`,
      [officeId, clientId, plan.id, otherDoc.id, rev1.id],
    ),
    /書類|document|一致/i,
  )
  // 別の事業所の計画版を指せない
  const otherPlan = await makePlan({ office: otherOfficeId, client: otherClientId })
  await assert.rejects(
    db.query(
      `INSERT INTO care_plan_ai_drafts (office_id, client_id, plan_id, source_document_id, source_revision_id, source_revision_rev, source_form_version_id, source_saved_at, proposal)
       SELECT $1,$2,$3,$4,$5,1,r.template_version_id,r.saved_at,'{}' FROM revisions r WHERE r.id = $5`,
      [officeId, clientId, otherPlan.id, assessment.id, rev1.id],
    ),
    /計画版|plan|一致/i,
  )
})

test('確定スナップショットは書き換えられず、確定済みの計画版は編集できない', { skip }, async () => {
  const plan = await makePlan()
  const need = await addNeed(plan.id, '確定するニーズ')
  const revisions = {} as Record<1 | 2 | 3, { id: string }>
  for (const formNo of [1, 2, 3] as const) {
    revisions[formNo] = await addRevision(plan.documents[formNo].id, 1, { note: `第${formNo}表` })
  }
  // 確定に使う第1表の値を、下書きの間に1つ入れておく
  await db.query(
    "INSERT INTO field_values (office_id, client_id, document_id, key, value, by, updated_by) VALUES ($1,$2,$3,'plan.intentionAnalysis',$4,'cm',$5)",
    [officeId, clientId, plan.documents[1].id, JSON.stringify('確定前の意向'), staffId],
  )
  await db.query("UPDATE care_plans SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2 WHERE id = $1", [plan.id, staffId])

  const snapshot = { schemaVersion: 1, services: [{ serviceId: need.serviceId }] }
  const confirmation = await one<{ id: string }>(
    `INSERT INTO care_plan_confirmations
       (plan_id, document_1_id, document_1_revision_id, document_2_id, document_2_revision_id, document_3_id, document_3_revision_id, snapshot, snapshot_sha256, confirmed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [plan.id, plan.documents[1].id, revisions[1].id, plan.documents[2].id, revisions[2].id, plan.documents[3].id, revisions[3].id, JSON.stringify(snapshot), 'sha-test', staffId],
  )
  // 1計画版に1つだけ
  await assert.rejects(
    db.query(
      `INSERT INTO care_plan_confirmations
         (plan_id, document_1_id, document_1_revision_id, document_2_id, document_2_revision_id, document_3_id, document_3_revision_id, snapshot, snapshot_sha256, confirmed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [plan.id, plan.documents[1].id, revisions[1].id, plan.documents[2].id, revisions[2].id, plan.documents[3].id, revisions[3].id, JSON.stringify(snapshot), 'sha-test-2', staffId],
    ),
    /duplicate|一意|unique/i,
  )
  // 書き換え・削除はできない
  await assert.rejects(db.query("UPDATE care_plan_confirmations SET snapshot_sha256 = 'changed' WHERE id = $1", [confirmation.id]), /書き換え|変更|confirm/i)
  await assert.rejects(db.query('DELETE FROM care_plan_confirmations WHERE id = $1', [confirmation.id]), /削除|confirm/i)
  // 確定済みの構造は変えられない
  await assert.rejects(db.query("UPDATE care_plan_needs SET need_text = '変えた' WHERE id = $1", [need.needId]), /確定|draft|編集/i)
  await assert.rejects(db.query('DELETE FROM care_plan_needs WHERE id = $1', [need.needId]), /確定|draft|削除/i)
  // 確定済みの第1表の値も変えられない
  await assert.rejects(
    db.query("UPDATE field_values SET value = '\"変えた\"' WHERE document_id = $1 AND key = 'plan.intentionAnalysis'", [plan.documents[1].id]),
    /確定|draft|編集/i,
  )
  // 確定した計画版は削除できない
  await assert.rejects(db.query('DELETE FROM care_plans WHERE id = $1', [plan.id]), /確定|削除|履歴/i)
})

test('計画版の読み取りは事業所で絞られ、ほかの事業所は 404', { skip }, async () => {
  const mine = await makePlan()
  const { getCarePlan } = await import('../db/care-plans.ts')
  const { NotFound } = await import('../db/repo.ts')
  const view = await getCarePlan(db, officeId, mine.id)
  assert.equal(view.id, mine.id)
  assert.equal(view.clientId, clientId)
  assert.deepEqual(view.documents.map((d) => d.formNo), [1, 2, 3])
  await assert.rejects(getCarePlan(db, otherOfficeId, mine.id), (e) => e instanceof NotFound)
  await assert.rejects(getCarePlan(db, officeId, 'not-a-uuid'), (e) => e instanceof NotFound)
})
