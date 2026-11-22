// 書類の種類（form_kinds）。種類ごとの動きは、この表の列で持つ（コードは種類の名前を知らない）。
// docs/再設計/16_書類と点検の基盤.md の「書類の種類ごとの動き」。全体の種類はサイト管理者が足す（行と全体の様式を登録する）。
// 事業所の責任者も、自分の事業所だけの種類を足せる（#153。office_id が入った行）。ほかの事業所の種類は「無い」ことにする。
import { randomBytes } from 'node:crypto'
import { Forbidden, NotFound } from './repo.ts' // 関数の中だけで使う（repo.ts もこのファイルを読むので、読み込みの時点では使わない）
import type { Db, Tx } from './pool.ts'
import { OFFICE_OVERALL, officeTopics, type Topic } from '../core/topics.ts'

type Q = Db | Tx

/** 必須の欄の key。要素が配列なら「どれか 1 つに値があればよい」組 */
export type RequiredKeys = (string | string[])[]

export interface FormKindRow {
  key: string
  name: string
  /** 1 人に何通作るか（one: 1 通だけ、many: 何通でも） */
  perClient: 'one' | 'many'
  /** 主な書類。利用者を作るときに一緒に作り、一覧の要介護度・入力の進み具合はこの書類から出す */
  isPrimary: boolean
  /** 作るときに同じ key の値を写す元の種類 */
  createFrom: string | null
  required: RequiredKeys
  /** その事業所だけの種類なら事業所の id。全体の種類は null */
  officeId: string | null
  /** やめた種類（新しくは作れない。今ある書類は開ける） */
  retired: boolean
}

const COLUMNS = 'key, name, per_client, is_primary, create_from, required, office_id, retired_at'
const row = (r: Record<string, unknown>): FormKindRow => ({
  key: r.key as string, name: r.name as string, perClient: r.per_client as FormKindRow['perClient'],
  isPrimary: r.is_primary as boolean, createFrom: (r.create_from as string | null) ?? null, required: r.required as RequiredKeys,
  officeId: (r.office_id as string | null) ?? null, retired: r.retired_at !== null && r.retired_at !== undefined,
})

/** すべての種類（主な書類が先、あとは key の順）。事業所の種類も含む */
export async function listKinds(db: Q): Promise<FormKindRow[]> {
  return (await db.query(`SELECT ${COLUMNS} FROM form_kinds ORDER BY is_primary DESC, key`)).rows.map(row)
}

/** 種類を key で引く（事業所を問わない。worker など、書類から種類を引くとき） */
export async function kindOf(db: Q, key: string): Promise<FormKindRow | null> {
  const r = (await db.query(`SELECT ${COLUMNS} FROM form_kinds WHERE key = $1`, [key])).rows[0]
  return r ? row(r) : null
}

/** その事業所から見える種類（全体の種類か、その事業所の種類）。ほかの事業所の種類は null */
export async function visibleKind(db: Q, officeId: string | null, key: string): Promise<FormKindRow | null> {
  const k = await kindOf(db, key)
  if (!k) return null
  return k.officeId === null || k.officeId === officeId ? k : null
}

export async function primaryKind(db: Q): Promise<FormKindRow> {
  const r = (await db.query(`SELECT ${COLUMNS} FROM form_kinds WHERE is_primary`)).rows[0]
  if (!r) throw new Error('主な書類の種類（form_kinds.is_primary）がありません')
  return row(r)
}

/**
 * その事業所の種類の一覧と、書類を作れるか（事業所の様式か全体の様式に、公開した版があり、やめていない）。
 * やめた種類も、今ある書類のタブのために返す（available は false）
 */
export async function kindsForOffice(db: Q, officeId: string): Promise<(FormKindRow & { available: boolean })[]> {
  const r = await db.query(
    `SELECT ${COLUMNS.split(', ').map((c) => `k.${c}`).join(', ')},
       k.retired_at IS NULL AND EXISTS (SELECT 1 FROM form_templates t JOIN form_template_versions v ON v.template_id = t.id
               WHERE t.kind = k.key AND (t.office_id = $1 OR t.office_id IS NULL) AND v.status = 'published') AS available
     FROM form_kinds k WHERE k.office_id IS NULL OR k.office_id = $1 ORDER BY k.is_primary DESC, k.office_id NULLS FIRST, k.key`,
    [officeId],
  )
  return r.rows.map((x) => ({ ...row(x), available: x.available as boolean }))
}

// ---------- 事業所の責任者が足す種類（#153） ----------

export interface NewOfficeKind {
  name: string
  perClient: 'one' | 'many'
  /** 作るときに主な書類（アセスメント）の同じ欄を写すか */
  copyFromPrimary: boolean
  /** 録音から AI に書かせるか（書かせないなら拾う内容は空） */
  records: boolean
  /** 2 回目からの録音で、前の録音の内容も使うか（要約を足していく） */
  append: boolean
}

/** 事業所の種類を足す。key は事業所の種類だと分かる形（o_ ＋ 乱数）。主な書類にはせず、必須の欄も持たない */
export async function createOfficeKind(db: Q, officeId: string, input: NewOfficeKind): Promise<FormKindRow> {
  const key = `o_${randomBytes(6).toString('hex')}`
  const from = input.copyFromPrimary ? (await primaryKind(db)).key : null
  const topics: Topic[] = input.records ? [{ ...OFFICE_OVERALL }] : []
  const r = await db.query(
    `INSERT INTO form_kinds (key, name, per_client, is_primary, create_from, required, topics, summary_mode, office_id)
     VALUES ($1, $2, $3, false, $4, '[]'::jsonb, $5, $6, $7) RETURNING ${COLUMNS}`,
    [key, input.name.trim(), input.perClient, from, JSON.stringify(topics), input.append ? 'append' : 'single', officeId],
  )
  return row(r.rows[0])
}

/** 責任者が直せる種類（自分の事業所の種類）。全体の種類は 403、ほかの事業所の種類・ない種類は 404 */
export async function ownKind(db: Q, officeId: string, key: string): Promise<FormKindRow> {
  const k = await visibleKind(db, officeId, key)
  if (!k) throw new NotFound(key)
  if (k.officeId === null) throw new Forbidden('全体の書類は変えられません')
  return k
}

/** 事業所の種類の拾う内容を置き換える。最後に書く項目（全体のまとめ）は最後に残す */
export async function setOfficeTopics(db: Q, officeId: string, key: string, items: readonly { id?: string, name: string, guide: string }[]): Promise<Topic[]> {
  await ownKind(db, officeId, key)
  const topics = officeTopics(items)
  await db.query('UPDATE form_kinds SET topics = $2 WHERE key = $1', [key, JSON.stringify(topics)])
  return topics
}

/** 事業所の種類をやめる（行は消さない。今ある書類は残る） */
export async function retireOfficeKind(db: Q, officeId: string, key: string): Promise<void> {
  await ownKind(db, officeId, key)
  await db.query('UPDATE form_kinds SET retired_at = coalesce(retired_at, now()) WHERE key = $1', [key])
}
