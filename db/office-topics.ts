// 事業所が直せる項目（#115。office_topics）。全体の一覧（form_kinds.topics）との差分だけを持つ。行がなければ全体の一覧をそのまま使う。
// docs/再設計/17_録音からの書き込み.md の「事業所が直せる項目」。直せるのは責任者だけ（api の form.manage）。直したことは audit_events に残す。
import { editOfficeTopics, trainingItems, type OfficeTopicsEdit, type OfficeTopicsRow, type Topic, type TrainingItem } from '../core/topics.ts'
import { writeBusinessAudit, type AuditContext } from './audit.ts'
import { visibleKind } from './kinds.ts'
import { tx, type Db, type Tx } from './pool.ts'
import { BadRequest, NotFound } from './repo.ts'

type Q = Db | Tx

export interface TrainingView {
  kind: { key: string, name: string, own: boolean }
  items: TrainingItem[]
}

async function kindTopics(db: Q, officeId: string, key: string) {
  const k = await visibleKind(db, officeId, key)
  if (!k) throw new NotFound(key)
  const topics = (await db.query('SELECT topics FROM form_kinds WHERE key = $1', [key])).rows[0].topics as Topic[]
  return { kind: k, topics }
}

async function officeRow(db: Q, officeId: string, key: string, lock = false): Promise<OfficeTopicsRow | null> {
  const r = (await db.query(`SELECT added, notes, passed FROM office_topics WHERE office_id = $1 AND kind = $2${lock ? ' FOR UPDATE' : ''}`, [officeId, key])).rows[0]
  return r ? { added: r.added, notes: r.notes, passed: r.passed } : null
}

/** AI 特訓部屋に出す項目（その事業所から見える種類だけ。ほかの事業所の種類は 404） */
export async function training(db: Q, officeId: string, key: string): Promise<TrainingView> {
  const { kind, topics } = await kindTopics(db, officeId, key)
  const own = kind.officeId !== null
  return { kind: { key: kind.key, name: kind.name, own }, items: trainingItems(topics, await officeRow(db, officeId, key), { ownKind: own }) }
}

/** 事業所の直しを置き換える（足した項目・書き足し・合格の印）。直せないものは 400 */
export async function putOfficeTopics(db: Db, staff: { id: string, officeId: string }, key: string, edit: OfficeTopicsEdit, context?: AuditContext): Promise<TrainingView> {
  return tx(db, async (c) => {
    const { topics } = await kindTopics(c, staff.officeId, key)
    const r = editOfficeTopics(topics, edit)
    if (!r.value) throw new BadRequest(r.error)
    const v = r.value
    await officeRow(c, staff.officeId, key, true)
    await c.query(
      `INSERT INTO office_topics (office_id, kind, added, notes, passed, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (office_id, kind) DO UPDATE SET added = EXCLUDED.added, notes = EXCLUDED.notes, passed = EXCLUDED.passed, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [staff.officeId, key, JSON.stringify(v.added), JSON.stringify(v.notes), JSON.stringify(v.passed), staff.id],
    )
    // 中身（責任者の文）は残さない。数だけ
    await writeBusinessAudit(c, {
      officeId: staff.officeId, actorStaffId: staff.id, action: 'office_topics.update',
      detail: { kind: key, added: v.added.length, noteLines: Object.values(v.notes).reduce((n, s) => n + s.split('\n').length, 0), passed: v.passed.length },
      context,
    })
    return training(c, staff.officeId, key)
  })
}

/**
 * 面談のヒント: 足していく種類で、事業所が足した項目のうち、この書類の要約がまだ 1 つもない項目（id と名前だけ。要約の中身は出さない）。
 * 単体の種類（録音ごとに書く）と、事業所が何も足していない種類は空
 */
export async function unheardTopics(db: Q, officeId: string, documentId: string): Promise<{ id: string, name: string }[]> {
  const r = (await db.query(
    `SELECT k.summary_mode, k.topics, o.added FROM documents d JOIN form_kinds k ON k.key = d.kind
     LEFT JOIN office_topics o ON o.office_id = d.office_id AND o.kind = d.kind
     WHERE d.id = $1 AND d.office_id = $2`,
    [documentId, officeId],
  )).rows[0]
  if (!r || r.summary_mode !== 'append' || !r.added?.length) return []
  const baseIds = new Set((r.topics as Topic[]).map((t) => t.id))
  const added = (r.added as OfficeTopicsRow['added']).filter((a) => !baseIds.has(a.id))
  if (!added.length) return []
  const heard = new Set((await db.query(
    'SELECT DISTINCT topic FROM recording_summaries WHERE document_id = $1 AND topic = ANY($2)', [documentId, added.map((a) => a.id)],
  )).rows.map((x) => x.topic as string))
  return added.filter((a) => !heard.has(a.id)).map((a) => ({ id: a.id, name: a.name }))
}
