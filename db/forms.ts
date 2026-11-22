// 様式と様式の版の読み書き。公開した版・退いた版の中身は書き換えない（DB のトリガーでも止める）ので、読んだ版はプロセスの中で覚えておく。
// 下書きの版（draft）は責任者・サイト管理者が直せるので覚えない（読むたびに DB から読む）。
import { createHash } from 'node:crypto'
import { checkBindings, formKeys, type Bindings } from '../core/binding.ts'
import { fieldDict, type LocalField } from '../core/dictionary.ts'
import { basePdfAssetPath, contentOf, toFormDef, type FormDef, type FormKind, type FormPage, type FormVersionView, type TemplateSlot } from '../core/form.ts'
import { tx, type Db, type Tx } from './pool.ts'
import { Conflict, Forbidden } from './repo.ts'
import { writeBusinessAudit, type AuditContext } from './audit.ts'

type Q = Db | Tx

export class FormNotFound extends Error {}
/** 下書きでない版（公開した・退いた版）を直そうとした（409） */
export class NotDraft extends Error {}

export interface FormVersion {
  id: string
  templateId: string
  officeId: string | null
  kind: FormKind
  name: string
  title: string
  version: number
  status: 'draft' | 'published' | 'retired'
  schemas: TemplateSlot[][]
  bindings: Bindings
  pages: FormPage[]
  /** その様式だけの欄の定義（fields.json の欄と同じ形。key は local. で始まる） */
  localFields: LocalField[]
  contentSha: string
  basePdfSha256: string
}

const cache = new Map<string, FormVersion>()
const defs = new Map<string, FormDef>()

function rowToVersion(r: Record<string, unknown>): FormVersion {
  return {
    id: r.id as string,
    templateId: r.template_id as string,
    officeId: (r.office_id as string | null) ?? null,
    kind: r.kind as FormKind,
    name: r.name as string,
    title: r.title as string,
    version: Number(r.version),
    status: r.status as FormVersion['status'],
    schemas: r.schemas as TemplateSlot[][],
    bindings: r.bindings as Bindings,
    pages: r.pages as FormPage[],
    localFields: (r.local_fields as LocalField[] | null) ?? [],
    contentSha: r.content_sha as string,
    basePdfSha256: r.base_pdf_sha256 as string,
  }
}

const SELECT = `SELECT v.id, v.template_id, v.version, v.status, v.schemas, v.bindings, v.pages, v.local_fields, v.content_sha, v.base_pdf_sha256,
                       t.kind, t.name, t.title, t.office_id
                FROM form_template_versions v JOIN form_templates t ON t.id = v.template_id`

/**
 * 版を読む。公開した・退いた版は中身が変わらないので覚えておく（状態だけは変わりうるので、状態を使うときは readVersion で読み直す）。
 * 下書きは覚えない
 */
export async function loadVersion(db: Q, id: string): Promise<FormVersion> {
  const hit = cache.get(id)
  if (hit) return hit
  const v = await readVersion(db, id)
  if (v.status !== 'draft') cache.set(id, v)
  return v
}

/** 版を DB から読む（覚えたものを使わない） */
export async function readVersion(db: Q, id: string, opts: { forUpdate?: boolean } = {}): Promise<FormVersion> {
  const r = (await db.query(`${SELECT} WHERE v.id = $1${opts.forUpdate ? ' FOR UPDATE OF v' : ''}`, [id])).rows[0]
  if (!r) throw new FormNotFound(id)
  return rowToVersion(r)
}

/** 共通の仕組みで使う形（読む key つき） */
export async function loadFormDef(db: Q, id: string): Promise<FormDef> {
  const hit = defs.get(id)
  if (hit) return hit
  const v = await loadVersion(db, id)
  const def = toFormDef(viewOf(v))
  if (v.status !== 'draft') defs.set(id, def)
  return def
}

export function viewOf(v: FormVersion): FormVersionView {
  return { id: v.id, kind: v.kind, name: v.name, version: v.version, schemas: v.schemas, bindings: v.bindings, pages: v.pages, contentSha: v.contentSha, localFields: v.localFields }
}

/**
 * ケアマネが見てよい版か（全事業所の様式か、その事業所の様式で、下書きでない）。だめなら FormNotFound。
 * 下書きは書類から指せず、責任者が直している途中なので、ケアマネの入口からは見えない（責任者の入口は versionForManager）
 */
export async function versionForOffice(db: Q, officeId: string, id: string): Promise<FormVersion> {
  const v = await loadVersion(db, id).catch(() => null)
  if (!v || v.status === 'draft' || (v.officeId !== null && v.officeId !== officeId)) throw new FormNotFound(id)
  return v
}

// ---------- 責任者（自分の事業所の様式）とサイト管理者（全体の様式）が、下書きを直す・消す・公開する ----------

/** どこの様式を扱うか。officeId が null ならサイト管理者（全体の様式） */
export interface ManagerScope { officeId: string | null }

/**
 * 責任者・サイト管理者が読んでよい版。責任者は自分の事業所の様式と、全体の様式の下書きでない版（読むだけ）。サイト管理者は全体の様式。
 * ほかの事業所の様式は FormNotFound（404）
 */
export async function versionForManager(db: Q, scope: ManagerScope, id: string, opts: { forUpdate?: boolean } = {}): Promise<FormVersion> {
  const v = await readVersion(db, id, opts).catch((e) => { if (e instanceof FormNotFound || (e as { code?: string }).code === '22P02') return null; throw e })
  if (!v) throw new FormNotFound(id)
  const mine = v.officeId === scope.officeId
  const global = v.officeId === null
  if (!mine && !(global && scope.officeId !== null && v.status !== 'draft')) throw new FormNotFound(id)
  return v
}

/** 直してよい下書き。全体の様式を責任者が直そうとしたら Forbidden（403）、下書きでなければ NotDraft（409） */
async function draftForManager(c: Tx, scope: ManagerScope, id: string): Promise<FormVersion> {
  const v = await versionForManager(c, scope, id, { forUpdate: true })
  if (v.officeId !== scope.officeId) throw new Forbidden('全体の様式は変えられません')
  if (v.status !== 'draft') throw new NotDraft(id)
  return v
}

export interface DraftPatch {
  schemas?: TemplateSlot[][]
  bindings?: Bindings
  pages?: FormPage[]
  localFields?: LocalField[]
}

/**
 * 下書きを直す。base は画面が元にした版の中身の指紋（content_sha）。今と違えば Conflict（409。ほかの人が先に直した）。
 * 様式・版の番号・元の PDF は変えない（DB のトリガーでも止める）
 */
export async function updateDraft(db: Db, scope: ManagerScope, id: string, base: string, patch: DraftPatch): Promise<FormVersion> {
  return tx(db, async (c) => {
    const v = await draftForManager(c, scope, id)
    if (v.contentSha !== base) throw new Conflict('form_version')
    const next = { kind: v.kind, schemas: patch.schemas ?? v.schemas, bindings: patch.bindings ?? v.bindings, pages: patch.pages ?? v.pages, localFields: patch.localFields ?? v.localFields }
    const contentSha = createHash('sha256').update(contentOf(next)).digest('hex')
    await c.query(
      'UPDATE form_template_versions SET schemas = $2, bindings = $3, pages = $4, local_fields = $5, content_sha = $6 WHERE id = $1',
      [id, JSON.stringify(next.schemas), JSON.stringify(next.bindings), JSON.stringify(next.pages), JSON.stringify(next.localFields), contentSha],
    )
    return readVersion(c, id)
  })
}

/** 下書きを捨てる（取り込みの version_id は空になる） */
export async function deleteDraft(db: Db, scope: ManagerScope, id: string): Promise<void> {
  await tx(db, async (c) => {
    await draftForManager(c, scope, id)
    await c.query('DELETE FROM form_template_versions WHERE id = $1', [id])
  })
}

/**
 * 確かめた下書きを公開する。base は確かめたときの中身の指紋（確かめたあとに直されていたら Conflict）。
 * その様式の今の版は退く。事業所の新しい書類から、この版を使う（今の書類は、作ったときの版のまま）
 */
export async function publishDraft(db: Db, scope: ManagerScope, id: string, base: string): Promise<FormVersion> {
  return tx(db, async (c) => {
    const v = await draftForManager(c, scope, id)
    if (v.contentSha !== base) throw new Conflict('form_version')
    await c.query('SELECT id FROM form_templates WHERE id = $1 FOR UPDATE', [v.templateId])
    await publish(c, v.templateId, id)
    return readVersion(c, id)
  })
}

/** 新しい書類に使う版。事業所の様式があればそれ、なければ全事業所の様式の、使う版（published） */
export async function publishedVersionId(db: Q, officeId: string, kind: FormKind): Promise<string> {
  const r = (await db.query(
    `SELECT v.id FROM form_template_versions v JOIN form_templates t ON t.id = v.template_id
     WHERE t.kind = $1 AND (t.office_id = $2 OR t.office_id IS NULL) AND v.status = 'published'
     ORDER BY (t.office_id IS NULL) ASC LIMIT 1`,
    [kind, officeId],
  )).rows[0]
  if (!r) throw new FormNotFound(`${kind} の様式が登録されていません（npm run forms:seed）`)
  return r.id as string
}

/** 元の PDF の、置き場（forms）の中の場所 */
export const basePdfPath = (v: Pick<FormVersion, 'basePdfSha256' | 'officeId'>) => basePdfAssetPath(v.basePdfSha256, v.officeId)

// ---------- 登録 ----------

export interface VersionInput {
  kind: FormKind
  name: string
  title: string
  publisher?: string | null
  sourceUrl?: string | null
  /** 事業所の様式なら事業所の id。全事業所なら null */
  officeId?: string | null
  schemas: TemplateSlot[][]
  bindings: Bindings
  pages: FormPage[]
  /** その様式だけの欄の定義（なければ fields.json の欄だけを読む様式） */
  localFields?: LocalField[]
  basePdfSha256: string
}

/** 出す前の確かめ。印字欄と対応が 1 対 1、対応の中身が正しい（key は版の欄の辞書にある）、ページが schemas を指す */
export function checkVersion(input: Pick<VersionInput, 'schemas' | 'bindings' | 'pages' | 'localFields'>): string[] {
  const errors: string[] = []
  const names = input.schemas.flat().map((s) => s.name)
  const dup = names.filter((n, i) => names.indexOf(n) !== i)
  if (dup.length) errors.push(`印字欄の名前が重なっている: ${[...new Set(dup)].join(', ')}`)
  for (const n of names) if (!input.bindings[n]) errors.push(`対応のない印字欄: ${n}`)
  for (const n of Object.keys(input.bindings)) if (!names.includes(n)) errors.push(`印字欄のない対応: ${n}`)
  for (const slot of input.schemas.flat()) if (input.bindings[slot.name]?.op === 'diagram@1' && slot.type !== 'image') errors.push(`${slot.name}: 図の印字欄はimage型が必要です`)
  errors.push(...checkBindings(input.bindings, fieldDict(input.localFields)))
  for (const p of input.pages) {
    const slots = input.schemas[p.pdfIndex]
    if (!slots) {
      errors.push(`ページ ${p.no} の pdfIndex ${p.pdfIndex} に欄がない`)
      continue
    }
    const print = p.print
    if (!print) continue
    const namesOnPage = new Set(slots.map((s) => s.name))
    if (!['text', 'table', 'timeline', 'flow', 'sections'].includes(print.type)) errors.push(`ページ ${p.no} の印字展開の種類が不正`)
    if (print.type === 'sections') {
      if (!Array.isArray(print.slots) || !print.slots.length || print.slots.length > 30 || new Set(print.slots).size !== print.slots.length || print.slots.some(n => !slots.some(s => s.name === n && s.type === 'text'))) errors.push(`ページ ${p.no} の文章区分の継続設定が不正`)
      if (print.list && (!Number.isInteger(print.list.rowsPerPage) || print.list.rowsPerPage < 1 || print.list.rowsPerPage > 100 || !formKeys(input.bindings).includes(print.list.key))) errors.push(`ページ ${p.no} の継続する表が不正`)
    }
    if (print.type === 'flow') {
      if (!Array.isArray(print.slots)) { errors.push(`ページ ${p.no} の文章の継続領域が不正`); continue }
      const slots = print.slots?.map(n => input.schemas[p.pdfIndex].find(s => s.name === n)) ?? []
      if (!slots.length || slots.length > 8 || new Set(print.slots).size !== slots.length || slots.some(s => !s || s.type !== 'text')) errors.push(`ページ ${p.no} の文章の継続領域が不正`)
      const first = slots[0]
      if (first && slots.some(s => s && (s.width !== first.width || s.height !== first.height || s.fontSize !== first.fontSize || s.lineHeight !== first.lineHeight || s.dynamicFontSize?.min !== first.dynamicFontSize?.min))) errors.push(`ページ ${p.no} の文章の継続領域の寸法が不一致`)
      const refs = print.slots?.map(n => input.bindings[n]) ?? []
      if (refs.some(b => b?.op !== 'text@1' || JSON.stringify(b) !== JSON.stringify(refs[0]))) errors.push(`ページ ${p.no} の文章の継続領域の対応が不一致`)
    }
    if (print.type === 'table') {
      if (!Number.isInteger(print.rowsPerPage) || print.rowsPerPage < 1 || print.rowsPerPage > 100 ||
          !Number.isFinite(print.rowHeight) || print.rowHeight <= 0 ||
          !Array.isArray(print.nested) || print.nested.length > 3 ||
          !Array.isArray(print.slots) || !print.slots.length || print.slots.some((s) => !namesOnPage.has(s))) {
        errors.push(`ページ ${p.no} の表の印字設定が不正`)
      }
      if (!formKeys(input.bindings).includes(print.key)) errors.push(`ページ ${p.no} の表が対応のないkeyを読む`)
    }
    if (print.type === 'timeline') {
      if (!namesOnPage.has(print.slot) || !Array.isArray(print.days) || !print.days.length ||
          print.days.length > 7 || print.days.some((s) => typeof s !== 'string' || !s.length) || new Set(print.days).size !== print.days.length ||
          ![print.dayField, print.startField, print.endField, print.labelField].every((s) => typeof s === 'string' && s.length > 0) ||
          !formKeys(input.bindings).includes(print.key) ||
          (print.activity && (!namesOnPage.has(print.activity.slot) || !formKeys(input.bindings).includes(print.activity.key)))) {
        errors.push(`ページ ${p.no} の時間軸の印字設定が不正`)
      }
    }
  }

  return errors
}

export interface RegisterResult { versionId: string, version: number, created: boolean, published: boolean }

/**
 * 様式の版を登録する（管理用。npm run forms:seed）。中身が今の最新の版と同じなら何もしない。
 * 違えば新しい版を作り、publish なら今の版を retired にして、新しい版を使う版にする（書類の向き先は forms:rebase で移す）。
 */
export async function registerVersion(db: Db, input: VersionInput, opts: { publish?: boolean } = {}): Promise<RegisterResult> {
  const errors = checkVersion(input)
  if (errors.length) throw new Error(`様式の版を登録できません:\n  ${errors.join('\n  ')}`)
  const contentSha = createHash('sha256').update(contentOf(input)).digest('hex')
  return tx(db, async (c) => {
    const t = (await c.query(
      `INSERT INTO form_templates (kind, name, title, publisher, source_url, office_id) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT ON CONSTRAINT form_templates_scope DO UPDATE SET name = EXCLUDED.name, title = EXCLUDED.title, publisher = EXCLUDED.publisher, source_url = EXCLUDED.source_url
       RETURNING id`,
      [input.kind, input.name, input.title, input.publisher ?? null, input.sourceUrl ?? null, input.officeId ?? null],
    )).rows[0]
    await c.query('SELECT id FROM form_templates WHERE id = $1 FOR UPDATE', [t.id])
    const latest = (await c.query('SELECT id, version, status, content_sha, base_pdf_sha256 FROM form_template_versions WHERE template_id = $1 ORDER BY version DESC LIMIT 1', [t.id])).rows[0]
    if (latest && latest.content_sha === contentSha && latest.base_pdf_sha256 === input.basePdfSha256) {
      let published = latest.status === 'published'
      if (opts.publish && latest.status === 'draft') { await publish(c, t.id, latest.id); published = true }
      return { versionId: latest.id, version: Number(latest.version), created: false, published }
    }
    const version = (latest ? Number(latest.version) : 0) + 1
    // その様式だけの欄は、定義があるときだけ書く（ない版は列の既定値 []。local_fields の列がない移行の前の表にも登録できる）
    const local = input.localFields?.length ? input.localFields : null
    const v = (await c.query(
      `INSERT INTO form_template_versions (template_id, version, schemas, bindings, pages, ${local ? 'local_fields, ' : ''}content_sha, base_pdf_sha256)
       VALUES ($1,$2,$3,$4,$5,${local ? '$8,' : ''}$6,$7) RETURNING id`,
      [t.id, version, JSON.stringify(input.schemas), JSON.stringify(input.bindings), JSON.stringify(input.pages), contentSha, input.basePdfSha256, ...(local ? [JSON.stringify(local)] : [])],
    )).rows[0]
    if (opts.publish) await publish(c, t.id, v.id)
    return { versionId: v.id, version, created: true, published: !!opts.publish }
  })
}

async function publish(c: Tx, templateId: string, versionId: string) {
  await c.query("UPDATE form_template_versions SET status = 'retired', retired_at = now() WHERE template_id = $1 AND status = 'published'", [templateId])
  await c.query("UPDATE form_template_versions SET status = 'published', published_at = now() WHERE id = $1", [versionId])
}

// ---------- 書類の向き先を移す ----------

export interface RebaseResult { from: { id: string, version: number }[], to: { id: string, version: number }, documents: number, missingKeys: Record<string, string[]> }

/**
 * 古い版を指す書類を、その様式の使う版に移す（管理用。npm run forms:rebase）。
 * 古い版が読んでいた key を新しい版が全部読むときだけ移す（読まない key があると、その値が用紙から消えるため）。
 */
export async function rebaseDocuments(db: Db, templateId: string, opts: { dryRun?: boolean } = {}): Promise<RebaseResult> {
  return tx(db, async (c) => {
    const to = (await c.query("SELECT id FROM form_template_versions WHERE template_id = $1 AND status = 'published'", [templateId])).rows[0]
    if (!to) throw new FormNotFound(`様式 ${templateId} に使う版がありません`)
    const target = await loadVersion(c, to.id)
    const newKeys = new Set(formKeys(target.bindings))
    const olds = (await c.query(
      `SELECT DISTINCT d.template_version_id AS id FROM documents d JOIN form_template_versions v ON v.id = d.template_version_id
       WHERE v.template_id = $1 AND d.template_version_id <> $2`,
      [templateId, to.id],
    )).rows.map((r) => r.id as string)
    const from: RebaseResult['from'] = []
    const missingKeys: Record<string, string[]> = {}
    for (const id of olds) {
      const v = await loadVersion(c, id)
      from.push({ id, version: v.version })
      const missing = formKeys(v.bindings).filter((k) => !newKeys.has(k))
      if (missing.length) missingKeys[`v${v.version}`] = missing
    }
    const result = { from, to: { id: target.id, version: target.version }, documents: 0, missingKeys }
    if (Object.keys(missingKeys).length || opts.dryRun || !olds.length) {
      if (!opts.dryRun) {
        const n = (await c.query('SELECT count(*) AS n FROM documents WHERE template_version_id = ANY($1::uuid[])', [olds])).rows[0].n
        result.documents = Number(n)
      }
      return result
    }
    const moved = await c.query(
      'UPDATE documents SET template_version_id = $1, updated_at = now() WHERE template_version_id = ANY($2::uuid[]) RETURNING office_id',
      [target.id, olds],
    )
    result.documents = moved.rowCount ?? 0
    // 移行の記録（事業所ごと）。どの版のどの中身からどこへ移したか
    const offices = new Map<string, number>()
    for (const r of moved.rows) offices.set(r.office_id, (offices.get(r.office_id) ?? 0) + 1)
    for (const [officeId, n] of offices) {
      await writeBusinessAudit(c, {
        officeId,
        action: 'form.rebase',
        detail: { kind: target.kind, from: await Promise.all(olds.map(async (id) => { const v = await loadVersion(c, id); return { version: v.version, contentSha: v.contentSha } })), to: { version: target.version, contentSha: target.contentSha }, documents: n },
      })
    }
    return result
  })
}

// ---------- 責任者の画面（#102）: 書類ごとの書式の様子・直す下書き・最初の書式に戻す・前の書式に戻す ----------

export interface KindFormState {
  key: string
  name: string
  /** 新しい書類に使う書式。office: 事業所で上げた書式か（でなければ全体の書式）。since: 使い始めた日時 */
  current: { versionId: string, office: boolean, since: string | null } | null
  /** 事業所の書式を使っていないときの、前に使っていた事業所の書式（「事業所の書式に戻す」） */
  shelved: { versionId: string, since: string | null } | null
  /** 事業所の下書き（いちばん新しいもの）と、取り込みが迷った欄 */
  draft: { versionId: string, createdAt: string, fromImport: boolean, empty: boolean, review: { slot: string, reason: string }[] } | null
  /** いちばん新しい取り込み（読み取り中・読めなかった・同じ書式だった）。uploaded: PDF が届いたか（届かないまま止まった取り込みは無視する） */
  import: { id: string, status: string, uploaded: boolean, errorKind: string | null, versionId: string | null, createdAt: string, updatedAt: string } | null
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null)

/** 事業所の、書類の種類ごとの書式の様子 */
export async function officeFormStates(db: Q, officeId: string): Promise<KindFormState[]> {
  const kinds = (await db.query('SELECT key, name FROM form_kinds ORDER BY is_primary DESC, key')).rows
  const out: KindFormState[] = []
  for (const k of kinds) {
    const v = (await db.query(
      `SELECT v.id, v.status, v.created_at, v.published_at, v.retired_at, t.office_id, jsonb_path_exists(v.schemas, '$[*][*]') AS has_slots FROM form_template_versions v JOIN form_templates t ON t.id = v.template_id
       WHERE t.kind = $1 AND (t.office_id = $2 OR (t.office_id IS NULL AND v.status = 'published'))
       ORDER BY v.version DESC`,
      [k.key, officeId],
    )).rows
    const mine = v.filter((r) => r.office_id !== null)
    const officePub = mine.find((r) => r.status === 'published')
    const globalPub = v.find((r) => r.office_id === null)
    const cur = officePub ?? globalPub
    const retired = officePub ? undefined : [...mine].filter((r) => r.status === 'retired').sort((a, b) => (b.retired_at?.getTime() ?? 0) - (a.retired_at?.getTime() ?? 0))[0]
    const draft = mine.find((r) => r.status === 'draft')
    const fromImport = draft ? (await db.query('SELECT review FROM form_imports WHERE version_id = $1 ORDER BY created_at DESC LIMIT 1', [draft.id])).rows[0] : undefined
    const imp = (await db.query(
      'SELECT id, status, uploaded_at, error_kind, version_id, created_at, updated_at FROM form_imports WHERE office_id = $1 AND kind = $2 ORDER BY created_at DESC, id LIMIT 1',
      [officeId, k.key],
    )).rows[0]
    out.push({
      key: k.key, name: k.name,
      current: cur ? { versionId: cur.id, office: cur.office_id !== null, since: iso(cur.published_at) } : null,
      shelved: retired ? { versionId: retired.id, since: iso(retired.published_at) } : null,
      draft: draft ? { versionId: draft.id, createdAt: iso(draft.created_at)!, fromImport: !!fromImport, empty: !draft.has_slots, review: fromImport?.review ?? [] } : null,
      import: imp ? { id: imp.id, status: imp.status, uploaded: imp.uploaded_at !== null, errorKind: imp.error_kind ?? null, versionId: imp.version_id ?? null, createdAt: iso(imp.created_at)!, updatedAt: iso(imp.updated_at)! } : null,
    })
  }
  return out
}

/** 版を作った取り込みが迷った欄（取り込みから作った下書きだけ。直す下書きにはない） */
export async function reviewOf(db: Q, versionId: string): Promise<{ slot: string, reason: string }[]> {
  return (await db.query('SELECT review FROM form_imports WHERE version_id = $1 ORDER BY created_at DESC LIMIT 1', [versionId])).rows[0]?.review ?? []
}

/** 事業所の版で、責任者が扱えるもの（全体の書式は 403） */
async function officeVersion(c: Tx, scope: ManagerScope, id: string): Promise<FormVersion> {
  const v = await versionForManager(c, scope, id, { forUpdate: true })
  if (v.officeId !== scope.officeId) throw new Forbidden('全体の様式は変えられません')
  return v
}

async function insertCopy(c: Tx, v: FormVersion): Promise<string> {
  await c.query('SELECT id FROM form_templates WHERE id = $1 FOR UPDATE', [v.templateId])
  const version = Number((await c.query('SELECT coalesce(max(version), 0) AS v FROM form_template_versions WHERE template_id = $1', [v.templateId])).rows[0].v) + 1
  const r = (await c.query(
    `INSERT INTO form_template_versions (template_id, version, schemas, bindings, pages, local_fields, content_sha, base_pdf_sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [v.templateId, version, JSON.stringify(v.schemas), JSON.stringify(v.bindings), JSON.stringify(v.pages), JSON.stringify(v.localFields), v.contentSha, v.basePdfSha256],
  )).rows[0]
  return r.id as string
}

/**
 * 使っている（または前に使った）書式を直す下書き。中身は同じで、番号は次。直している途中の下書きがあれば、それを返す（created: false）。
 * 上げた PDF から作った下書きは返さない（別の書式なので）。
 * 全体の書式からは作れない（403）
 */
export async function draftFrom(db: Db, scope: ManagerScope, id: string): Promise<{ version: FormVersion, created: boolean }> {
  return tx(db, async (c) => {
    const v = await officeVersion(c, scope, id)
    if (v.status === 'draft') return { version: v, created: false }
    // 直している途中の下書き（取り込みから作ったものでない）があれば、それを続ける。上げた PDF の下書きは、ここでは使わない
    const existing = (await c.query(
      `SELECT v.id FROM form_template_versions v WHERE v.template_id = $1 AND v.status = 'draft'
         AND NOT EXISTS (SELECT 1 FROM form_imports i WHERE i.version_id = v.id) ORDER BY v.version DESC LIMIT 1`,
      [v.templateId],
    )).rows[0]
    if (existing) return { version: await readVersion(c, existing.id), created: false }
    return { version: await readVersion(c, await insertCopy(c, v)), created: true }
  })
}

/** 最初の書式（全体の書式）に戻す: 事業所の使う版を退かせる。もう戻っていれば何もしない。今の書類は前の版のまま */
export async function revertToGlobal(db: Db, officeId: string, staffId: string, kind: string, auditContext?: AuditContext): Promise<void> {
  await tx(db, async (c) => {
    if (!(await c.query('SELECT 1 FROM form_kinds WHERE key = $1', [kind])).rows.length) throw new FormNotFound(kind)
    const t = (await c.query('SELECT id FROM form_templates WHERE kind = $1 AND office_id = $2 FOR UPDATE', [kind, officeId])).rows[0]
    if (!t) return
    const r = await c.query(
      "UPDATE form_template_versions SET status = 'retired', retired_at = now() WHERE template_id = $1 AND status = 'published' RETURNING id, version",
      [t.id],
    )
    if (!r.rows.length) return
    await writeBusinessAudit(c, {
      officeId,
      actorStaffId: staffId,
      action: 'form.revert',
      detail: { kind, from: { version: Number(r.rows[0].version) } },
      context: auditContext,
    })
  })
}

/**
 * 前に使っていた事業所の書式に戻す。退いた版は公開し直せない（DB のトリガー）ので、同じ中身の版を作って公開する。
 * 退いた版でなければ NotDraft と同じ 409、全体の書式は 403
 */
export async function reuseVersion(db: Db, scope: ManagerScope & { officeId: string }, staffId: string, id: string, auditContext?: AuditContext): Promise<FormVersion> {
  return tx(db, async (c) => {
    const v = await officeVersion(c, scope, id)
    if (v.status !== 'retired') throw new Conflict('form_version')
    const copy = await insertCopy(c, v)
    await publish(c, v.templateId, copy)
    await writeBusinessAudit(c, {
      officeId: scope.officeId,
      actorStaffId: staffId,
      action: 'form.reuse',
      detail: { kind: v.kind, from: { version: v.version } },
      context: auditContext,
    })
    return readVersion(c, copy)
  })
}
