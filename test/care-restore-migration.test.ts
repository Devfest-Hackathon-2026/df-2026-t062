import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createPool } from '../db/pool.ts'
import { migrate } from '../db/migrate.ts'

test('第4〜7表の復活は監査・録音保持の移行済みDBにも追加でき、既存データを保持する', {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const schema = `t_care_restore_${process.pid}`
  const admin = await createPool()
  await admin.query(`CREATE SCHEMA ${schema}`)
  await admin.end()
  const db = await createPool({ ...process.env, DB_SCHEMA: schema })
  try {
    await migrate(db, undefined, { stopBefore: '0010_support_progress.sql' })
    // 現在のmainと同じく0010〜17が存在せず、0018以降だけ適用された状態。
    const dir = new URL('../db/migrations/', import.meta.url)
    for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql') && n >= '0018').sort()) {
      await db.query(await readFile(new URL(name, dir), 'utf8'))
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
    }
    const office = (await db.query("INSERT INTO offices (name,phone,fax) VALUES ('架空の移行確認','','') RETURNING id")).rows[0].id
    const client = (await db.query("INSERT INTO clients (office_id,name) VALUES ($1,'架空 花子') RETURNING id", [office])).rows[0].id
    await db.query(`INSERT INTO access_audit_events (office_id,client_id,resource_type,resource_id,access_mode,action,outcome,source,route)
      VALUES ($1,$2,'client',$2,'view','client.view','success','api','/api/clients/:id')`, [office,client])
    const applied = await migrate(db)
    assert.equal(applied.length, 8)
    assert.equal(applied[0], '0010_support_progress.sql')
    assert.equal(applied.at(-1), '0017_care_record_confirmations.sql')
    assert.equal((await db.query('SELECT name FROM clients WHERE id=$1', [client])).rows[0].name, '架空 花子')
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM access_audit_events WHERE client_id=$1', [client])).rows[0].n), 1)
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM form_kinds WHERE key IN ('care_plan_4','care_plan_5','care_plan_6','care_plan_7')")).rows[0].n), 4)
    assert.deepEqual(await migrate(db), [])
  } finally {
    await db.query(`DROP SCHEMA ${schema} CASCADE`)
    await db.end()
  }
})
