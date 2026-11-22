// 再設計の DB（docs/再設計/13_DB設計.md）: 値を書類ごとに持つ移行、下書きの版、書類の種類の行。
// PostgreSQL が要る（DATABASE_URL がなければ飛ばす）。ファイルごとに別のスキーマを使う。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Db } from '../db/pool.ts'

const url = process.env.DATABASE_URL
const skip = url ? false : 'DATABASE_URL がないので飛ばします'
const schema = `t_redesign_${process.pid}`
let db: Db

before(async () => {
  if (!url) return
  const { createPool } = await import('../db/pool.ts')
  const admin = await createPool({ DATABASE_URL: url })
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
  await admin.end()
  db = await createPool({ DATABASE_URL: url, DB_SCHEMA: schema })
})

after(async () => {
  if (!db) return
  await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await db.end()
})

test('移行の前と後で、どの書類にも同じ値が見え、利用者に 1 つの行はなくなる', { skip }, async () => {
  const { migrate } = await import('../db/migrate.ts')
  await migrate(db, () => {}, { stopBefore: '0003_redesign.sql' })

  // 移行の前の形: 基本情報は document_id が空の行で、利用者に 1 つ
  const forms = await import('../db/forms.ts')
  const { readSeed } = await import('../forms/admin/files.ts')
  const assessV = (await forms.registerVersion(db, readSeed('assessment'), { publish: true })).versionId
  const admV = (await forms.registerVersion(db, readSeed('admission'), { publish: true })).versionId
  const office = (await db.query("INSERT INTO offices (name) VALUES ('移行の見本') RETURNING id")).rows[0].id as string
  const client = (await db.query("INSERT INTO clients (office_id, name) VALUES ($1, '移行 花子') RETURNING id", [office])).rows[0].id as string
  const assess = (await db.query("INSERT INTO documents (office_id, client_id, kind, template_version_id) VALUES ($1,$2,'assessment',$3) RETURNING id", [office, client, assessV])).rows[0].id as string
  const adm = (await db.query("INSERT INTO documents (office_id, client_id, kind, template_version_id) VALUES ($1,$2,'admission',$3) RETURNING id", [office, client, admV])).rows[0].id as string
  const put = (doc: string | null, key: string, value: unknown, by = 'cm') => db.query(
    'INSERT INTO field_values (office_id, client_id, document_id, key, value, ai_value, by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [office, client, doc, key, JSON.stringify(value), by === 'ai' ? JSON.stringify(value) : null, by],
  )
  await put(null, 'person.name', '移行 花子')
  await put(null, 'person.address', '見本市見本町 1-2-3', 'ai')
  await put(assess, 'person.lifeHistory', 'アセスメントだけの値')
  await put(adm, 'housing.notes', '入院時情報提供書だけの値')

  await migrate(db)

  const { getDocument } = await import('../db/repo.ts')
  const a = await getDocument(db, office, assess)
  const b = await getDocument(db, office, adm)
  for (const d of [a, b]) {
    assert.equal(d.fields['person.name']?.value, '移行 花子', `${d.kind} の氏名`)
    assert.equal(d.fields['person.address']?.value, '見本市見本町 1-2-3', `${d.kind} の住所`)
    assert.equal(d.fields['person.address']?.by, 'ai', '誰が書いたかもそのまま')
    assert.equal(d.fields['person.address']?.aiValue, '見本市見本町 1-2-3', '最後に AI が書いた値もそのまま')
  }
  assert.equal(a.fields['person.lifeHistory']?.value, 'アセスメントだけの値')
  assert.equal(b.fields['person.lifeHistory'], undefined)
  assert.equal(b.fields['housing.notes']?.value, '入院時情報提供書だけの値')
  assert.equal(a.fields['housing.notes'], undefined)

  const nulls = await db.query('SELECT count(*)::int AS n FROM field_values WHERE document_id IS NULL')
  assert.equal(nulls.rows[0].n, 0)
  await assert.rejects(put(null, 'person.phone', '000'), /null value|not-null/)
})

test('書類の種類の最初の行: アセスメントが主な書類で、必須の欄は fields.json と同じ', { skip }, async () => {
  const rows = (await db.query('SELECT key, per_client, is_primary, create_from, required, topics, summary_mode FROM form_kinds ORDER BY key')).rows
  // care_plan_1〜3 は #90 で足した全体の種類（第1表だけアセスメントから写す）
  assert.deepEqual(rows.map((r) => r.key), ['admission', 'assessment', 'care_plan_1', 'care_plan_2', 'care_plan_3', 'care_plan_4', 'care_plan_5', 'care_plan_6'])
  const assess = rows.find((r) => r.key === 'assessment')!
  const adm = rows.find((r) => r.key === 'admission')!
  assert.equal(assess.is_primary, true)
  assert.equal(adm.is_primary, false)
  assert.equal(adm.create_from, 'assessment')
  assert.equal(assess.per_client, 'one')
  assert.equal(assess.summary_mode, 'append')
  const { REQUIRED_ASSESS } = await import('../core/fields.ts')
  assert.deepEqual(assess.required, REQUIRED_ASSESS)
  assert.deepEqual(adm.required, [])
  assert.deepEqual(adm.topics, [])
  const topics = assess.topics as { id: string, name: string, by: string, last: boolean, keys?: { first: string, later: string } }[]
  assert.equal(topics.filter((t) => t.by === 'ai' && !t.last).length, 23, '課題分析標準項目 23 項目')
  assert.equal(new Set(topics.map((t) => t.id)).size, topics.length, '項目の id は重ならない')
  assert.deepEqual(topics.find((t) => t.by === 'machine')?.keys, { first: 'assessment.initialDate', later: 'assessment.updateDate' })
  assert.equal(topics.filter((t) => t.last).map((t) => t.name).join(), '全体のまとめ')
  // 主な書類は 1 つだけ
  await assert.rejects(db.query("INSERT INTO form_kinds (key, name, is_primary) VALUES ('other', 'ほか', true)"), /form_kinds_one_primary/)
  // 行を足せば、その種類の様式を登録できる（決め打ちの CHECK はない）
  await db.query("INSERT INTO form_kinds (key, name, per_client) VALUES ('monitoring', 'モニタリング', 'many')")
  await assert.rejects(db.query("INSERT INTO form_templates (kind, name, title) VALUES ('unknown', 'x', 'x')"), /form_templates_kind_fkey/)
})

test('下書きの版は直せて消せる。公開した版は直せない。書類に下書きの版は付けられない', { skip }, async () => {
  const forms = await import('../db/forms.ts')
  const { readSeed } = await import('../forms/admin/files.ts')
  const office = (await db.query("INSERT INTO offices (name) VALUES ('下書きの見本') RETURNING id")).rows[0].id as string
  const input = { ...readSeed('admission'), officeId: office, name: '事業所の入院時情報提供書' }
  const draft = (await forms.registerVersion(db, input)).versionId
  assert.equal((await db.query('SELECT status FROM form_template_versions WHERE id = $1', [draft])).rows[0].status, 'draft')

  await db.query(`UPDATE form_template_versions SET bindings = '{}'::jsonb, local_fields = '[{"key":"local.pet","label":"ペット","type":"text"}]'::jsonb, content_sha = 'x' WHERE id = $1`, [draft])
  await assert.rejects(db.query("UPDATE form_template_versions SET base_pdf_sha256 = 'other' WHERE id = $1", [draft]), /元の PDF/)

  const client = (await db.query("INSERT INTO clients (office_id, name) VALUES ($1, '下書き 太郎') RETURNING id", [office])).rows[0].id as string
  await assert.rejects(
    db.query("INSERT INTO documents (office_id, client_id, kind, template_version_id) VALUES ($1,$2,'admission',$3)", [office, client, draft]),
    /下書き/,
  )
  await db.query('DELETE FROM form_template_versions WHERE id = $1', [draft])

  const published = (await forms.registerVersion(db, input, { publish: true })).versionId
  await assert.rejects(db.query("UPDATE form_template_versions SET local_fields = '[]'::jsonb || '[{\"key\":\"local.x\"}]'::jsonb WHERE id = $1", [published]), /書き換えられません/)
  await assert.rejects(db.query('DELETE FROM form_template_versions WHERE id = $1', [published]), /消せません/)
  const doc = (await db.query("INSERT INTO documents (office_id, client_id, kind, template_version_id) VALUES ($1,$2,'admission',$3) RETURNING id", [office, client, published])).rows[0].id as string

  // 版を移すときも、下書きには移せない
  const next = (await db.query(
    `INSERT INTO form_template_versions (template_id, version, schemas, bindings, pages, content_sha, base_pdf_sha256)
     SELECT template_id, version + 1, schemas, bindings, pages, 'next', base_pdf_sha256 FROM form_template_versions WHERE id = $1 RETURNING id`,
    [published],
  )).rows[0].id as string
  await assert.rejects(db.query('UPDATE documents SET template_version_id = $1 WHERE id = $2', [next, doc]), /下書き/)
})

test('同じ利用者・同じ種類の書類は seq で分けて何通も持てる', { skip }, async () => {
  const forms = await import('../db/forms.ts')
  const office = (await db.query("INSERT INTO offices (name) VALUES ('何通もの見本') RETURNING id")).rows[0].id as string
  const client = (await db.query("INSERT INTO clients (office_id, name) VALUES ($1, '何通 次郎') RETURNING id", [office])).rows[0].id as string
  const v = await forms.publishedVersionId(db, office, 'admission')
  const ins = (seq: number) => db.query("INSERT INTO documents (office_id, client_id, kind, template_version_id, seq) VALUES ($1,$2,'admission',$3,$4)", [office, client, v, seq])
  await ins(1)
  await ins(2)
  await assert.rejects(ins(2), /documents_client_kind_seq/)
})
