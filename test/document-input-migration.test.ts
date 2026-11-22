import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPool } from '../db/pool.ts'
import { migrate } from '../db/migrate.ts'
import { seed } from '../db/seed.ts'

test('書類取込の追加移行は既存原本・候補を保持し、版を推測しない。再実行も安全', {
  skip: !process.env.DATABASE_URL && 'DATABASE_URL がないため省略',
}, async () => {
  const schema = `t_document_input_migration_${process.pid}`
  const admin = await createPool()
  await admin.query(`CREATE SCHEMA ${schema}`)
  await admin.end()
  const db = await createPool({ ...process.env, DB_SCHEMA: schema })
  try {
    await migrate(db, undefined, { stopBefore: '0009_document_input_form_version.sql' })
    // 最新のseedには第5表もある。独自種類として先行登録済みの場合も追加移行が上書きしない。
    await db.query("INSERT INTO form_kinds (key,name,per_client,is_primary,create_from,required,topics,summary_mode) VALUES ('care_plan_7','サービス利用票別表 第7表','many',false,'assessment','[]','[]','single')")
    await db.query("INSERT INTO form_kinds (key,name,per_client,is_primary,create_from,required,topics,summary_mode) VALUES ('care_plan_6','サービス利用票 第6表','many',false,'assessment','[]','[]','single')")
    await db.query("INSERT INTO form_kinds (key,name,per_client,is_primary,create_from,required,topics,summary_mode) VALUES ('care_plan_4','サービス担当者会議の要点 第4表','many',false,'assessment','[]','[]','single')")
    await db.query("INSERT INTO form_kinds (key,name,per_client,is_primary,create_from,required,topics,summary_mode) VALUES ('care_plan_5','居宅介護支援経過 第5表','many',false,'assessment','[]','[]','single')")
    const { staff, clients } = await seed(db)
    const document = (await db.query('SELECT id FROM documents WHERE client_id=$1', [clients.sato])).rows[0].id
    const id = (await db.query(`INSERT INTO document_inputs
      (office_id,client_id,document_id,created_by,file_name,mime,sha256,bytes,status,result)
      VALUES ($1,$2,$3,$4,'架空.png','image/png',$5,10,'review',$6) RETURNING id`,
    [staff.officeId, clients.sato, document, staff.id, 'a'.repeat(64), JSON.stringify({ candidates: [] })])).rows[0].id
    assert.deepEqual(await migrate(db), ['0009_document_input_form_version.sql', '0010_support_progress.sql', '0011_care_record_creations.sql', '0012_care_record_drafts.sql', '0013_meeting_records.sql', '0014_care_plan_months.sql', '0015_care_fees.sql', '0016_care_fee_confirmations.sql'])
    const row = (await db.query('SELECT * FROM document_inputs WHERE id=$1', [id])).rows[0]
    assert.equal(row.template_version_id, null)
    assert.equal(row.upload_generation, 1, '既存の /original パスを維持する')
    assert.equal(row.status, 'review')
    assert.deepEqual(row.result, { candidates: [] })
    assert.deepEqual(await migrate(db), [])
  } finally {
    await db.query(`DROP SCHEMA ${schema} CASCADE`)
    await db.end()
  }
})
