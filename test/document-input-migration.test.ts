import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPool } from '../db/pool.ts'
import { migrate } from '../db/migrate.ts'
import { seedForms } from '../forms/admin/seed.ts'

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
    await seedForms(db)
    const office = (await db.query("INSERT INTO offices (name, phone, fax) VALUES ('migration test', '', '') RETURNING id")).rows[0].id
    const staff = (await db.query("INSERT INTO staff (office_id, auth_uid, name, email) VALUES ($1, 'migration-test', 'テスト', 'migration@test.invalid') RETURNING id", [office])).rows[0].id
    const client = (await db.query("INSERT INTO clients (office_id, name, created_by) VALUES ($1, 'テスト利用者', $2) RETURNING id", [office, staff])).rows[0].id
    const version = (await db.query(
      `SELECT v.id FROM form_template_versions v
         JOIN form_templates t ON t.id = v.template_id
        WHERE t.kind = 'assessment' AND t.office_id IS NULL AND v.status = 'published'`,
    )).rows[0].id
    const document = (await db.query(
      `INSERT INTO documents (office_id, client_id, kind, template_version_id, created_by)
       VALUES ($1, $2, 'assessment', $3, $4) RETURNING id`,
      [office, client, version, staff],
    )).rows[0].id
    const id = (await db.query(`INSERT INTO document_inputs
      (office_id,client_id,document_id,created_by,file_name,mime,sha256,bytes,status,result)
      VALUES ($1,$2,$3,$4,'架空.png','image/png',$5,10,'review',$6) RETURNING id`,
    [office, client, document, staff, 'a'.repeat(64), JSON.stringify({ candidates: [] })])).rows[0].id
    assert.deepEqual(await migrate(db, undefined, { stopBefore: '0010_audit_events.sql' }), ['0009_document_input_form_version.sql'])
    const row = (await db.query('SELECT * FROM document_inputs WHERE id=$1', [id])).rows[0]
    assert.equal(row.template_version_id, null)
    assert.equal(row.upload_generation, 1, '既存の /original パスを維持する')
    assert.equal(row.status, 'review')
    assert.deepEqual(row.result, { candidates: [] })
    assert.deepEqual(await migrate(db), ['0010_audit_events.sql'])
    assert.deepEqual(await migrate(db), [])
  } finally {
    await db.query(`DROP SCHEMA ${schema} CASCADE`)
    await db.end()
  }
})
