/** 記録済みの実応答を使う故障注入。Geminiを呼び出さない。 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createPool } from '../../db/pool.ts'
import { migrate } from '../../db/migrate.ts'
import { seedForms } from '../../forms/admin/seed.ts'
import { createClient, staffByAuth } from '../../db/repo.ts'
import { createApp } from '../../api/app.ts'
import { DevVerifier } from '../../api/auth.ts'
import { LocalStorage } from '../../api/storage.ts'
const out = resolve(process.argv[2] ?? '.data/care-plan-real-gemini-20261122')
const source = JSON.parse(await readFile(join(out, 'A1.json'), 'utf8')).generated.draft.proposal
const connection = process.env.EVAL_DATABASE_URL
if (!connection || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection).hostname)) throw new Error('ローカルDBが必要です')
const schema = `eval_cp_fault_${randomUUID().replaceAll('-', '')}`
const admin = await createPool({ DATABASE_URL: connection }); await admin.query(`CREATE SCHEMA ${schema}`)
const db = await createPool({ DATABASE_URL: connection, DB_SCHEMA: schema })
const root = await mkdtemp(join(tmpdir(), 'cp-fault-'))
const results: unknown[] = []
try {
  await migrate(db); await seedForms(db)
  const office = (await db.query("INSERT INTO offices(name) VALUES ('架空の故障注入事業所') RETURNING id")).rows[0]
  const email = 'cp-fault@example.com'
  await db.query("INSERT INTO staff(office_id,auth_uid,name,email) VALUES ($1,$2,'架空担当',$3)", [office.id, `dev:${email}`, email])
  const staff = (await staffByAuth(db, `dev:${email}`))!
  let injected: unknown = source
  let failure: string | undefined
  const app = createApp({ db: async () => db, verifier: () => new DevVerifier(), storage: () => new LocalStorage(root), queue: () => ({ async enqueue() {}, async enqueueFormImport() {}, async enqueueInspection() {} }),
    carePlanAi: async () => async () => { if (failure === 'invalid_json') throw new SyntaxError('Synthetic invalid JSON'); if (failure === 'api_error') throw new Error('Synthetic API failure'); return injected }, devAuth: true })
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const r = await app.request(path, { method, headers: { Authorization: `Bearer dev:${email}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, data: await r.json() }
  }
  for (const kind of ['invalid_json', 'api_error', 'bad_time', 'bad_ref', 'duplicate_slot', 'invalid_nested_services']) {
    failure = kind
    injected = structuredClone(source)
    const p = injected as typeof source
    if (kind === 'bad_time') p.slots[0].start = '25:70'
    if (kind === 'bad_ref') p.slots[0].serviceRef.need = 999
    if (kind === 'duplicate_slot') p.slots.push(structuredClone(p.slots[0]))
    if (kind === 'invalid_nested_services') { p.needs[0].shortGoals[0].services[0].insured = '不正な型'; }
    const client = await createClient(db, staff, { name: `架空故障${kind}`, sex: '女' })
    await call(`/api/documents/${client.documentId}/save`, 'POST', { scope: 'document' })
    const rev = (await db.query('SELECT id FROM revisions WHERE document_id=$1 ORDER BY rev DESC LIMIT 1', [client.documentId])).rows[0].id
    const plan = (await call(`/api/clients/${client.id}/care-plans`, 'POST', { effectiveFrom: '2026-11-01', effectiveTo: '2027-10-31' })).data.plan
    const made = await call(`/api/care-plans/${plan.id}/ai-drafts`, 'POST', { sourceDocumentId: client.documentId, sourceRevisionId: Number(rev) })
    const applied = await call(`/api/care-plans/${plan.id}/ai-drafts/${made.data.draft.id}/apply`, 'POST', { baseVersion: plan.lockVersion })
    const after = (await call(`/api/care-plans/${plan.id}`)).data.plan
    const doc = after.documents.find((d: { formNo: number }) => d.formNo === 1).documentId
    const edit = await call(`/api/documents/${doc}/fields`, 'PATCH', { changes: [{ key: 'plan.overallPolicy', value: '障害後も手入力できます（架空）', base: after.plan1['plan.overallPolicy'] ?? null }] })
    const saved = await call(`/api/care-plans/${plan.id}/save`, 'POST', { baseVersion: after.lockVersion })
    results.push({ kind, source: 'recorded A1 + fault injection; no model call', generationStatus: made.status, draftStatus: made.data.draft.status, errorKind: made.data.draft.errorKind, applyStatus: applied.status, applied: applied.data.applied,
      persistedSlots: after.slots, persistedServices: after.needs.flatMap((n: any) => n.shortGoals.flatMap((g: any) => g.services)), manualEditStatus: edit.status, manualSaveStatus: saved.status, stillDraft: after.status === 'draft' })
  }
  await mkdir(out, { recursive: true }); await writeFile(join(out, 'boundaries.json'), JSON.stringify({ synthetic: true, realModelCalls: 0, results }, null, 2))
  console.log(JSON.stringify(results, null, 2))
} finally { await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); await rm(root, { recursive: true, force: true }) }
