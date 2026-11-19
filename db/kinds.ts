// 書類の種類（form_kinds）。種類ごとの動きは、この表の列で持つ（コードは種類の名前を知らない）。
// docs/再設計/16_書類と点検の基盤.md の「書類の種類ごとの動き」。種類を足すのはサイト管理者（行と全体の様式を登録する）。
import type { Db, Tx } from './pool.ts'

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
}

const COLUMNS = 'key, name, per_client, is_primary, create_from, required'
const row = (r: Record<string, unknown>): FormKindRow => ({
  key: r.key as string, name: r.name as string, perClient: r.per_client as FormKindRow['perClient'],
  isPrimary: r.is_primary as boolean, createFrom: (r.create_from as string | null) ?? null, required: r.required as RequiredKeys,
})

/** すべての種類（主な書類が先、あとは key の順） */
export async function listKinds(db: Q): Promise<FormKindRow[]> {
  return (await db.query(`SELECT ${COLUMNS} FROM form_kinds ORDER BY is_primary DESC, key`)).rows.map(row)
}

export async function kindOf(db: Q, key: string): Promise<FormKindRow | null> {
  const r = (await db.query(`SELECT ${COLUMNS} FROM form_kinds WHERE key = $1`, [key])).rows[0]
  return r ? row(r) : null
}

export async function primaryKind(db: Q): Promise<FormKindRow> {
  const r = (await db.query(`SELECT ${COLUMNS} FROM form_kinds WHERE is_primary`)).rows[0]
  if (!r) throw new Error('主な書類の種類（form_kinds.is_primary）がありません')
  return row(r)
}

/** 種類と、その事業所で書類を作れるか（事業所の様式か全体の様式に、公開した版がある） */
export async function kindsForOffice(db: Q, officeId: string): Promise<(FormKindRow & { available: boolean })[]> {
  const r = await db.query(
    `SELECT ${COLUMNS.split(', ').map((c) => `k.${c}`).join(', ')},
       EXISTS (SELECT 1 FROM form_templates t JOIN form_template_versions v ON v.template_id = t.id
               WHERE t.kind = k.key AND (t.office_id = $1 OR t.office_id IS NULL) AND v.status = 'published') AS available
     FROM form_kinds k ORDER BY k.is_primary DESC, k.key`,
    [officeId],
  )
  return r.rows.map((x) => ({ ...row(x), available: x.available as boolean }))
}
