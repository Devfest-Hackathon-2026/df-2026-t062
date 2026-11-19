// 様式の取り込み（#99）: 上げられた白紙の PDF から、様式の版の下書きを作る（変換の黒箱の入口）。
// 受け付け・ジョブ・保存・公開は #103。ここは「PDF → 下書きの版（schemas・bindings・pages・local_fields）と要確認の一覧」だけ。
//
//   importPdf(pdf, { ask }) →
//     matched   … 登録済みの全体の様式と同じ PDF（中身のハッシュが同じ）。変換しない
//     succeeded … 下書きの版と要確認の一覧（form_imports.review）
//     failed    … 失敗の種類（form_imports.error_kind）。AI のエラーの文面などは返さない（中身が入りうるため）
//
// 受けるのは文字の入った PDF（Word・Excel などから出したもの）。スキャンした紙（文字のない PDF）は受けない（#110 で決めた）。
// 記入済みの用紙かどうかは見分けない（上げる画面で白紙を上げるよう伝える。13_DB設計.md の form_imports）。
import { createHash } from 'node:crypto'
import { BY_KEY } from '../../core/fields.ts'
import { checkBindings, type Bindings } from '../../core/binding.ts'
import type { Ask } from '../vertex/gemini.ts'
import { convertPage, type PageDraft } from './convert.ts'
import { openPdf } from './pdf.ts'
import { catalog as defaultCatalog } from './prompt.ts'
import { buildVersion, type DraftVersion } from './version.ts'

export type ImportErrorKind =
  | 'invalid_pdf' // PDF として開けない
  | 'encrypted' // パスワードで守られている
  | 'unsafe_pdf' // 添付ファイルかスクリプトが入っている
  | 'too_large' // 大きすぎる
  | 'too_many_pages' // ページが多すぎる
  | 'no_text' // 文字がない（スキャンした紙）
  | 'timeout' // 時間切れ
  | 'ai_failed' // AI の呼び出しが失敗した

export type ImportResult =
  | { status: 'matched', basePdfSha256: string }
  | { status: 'succeeded', basePdfSha256: string, draft: DraftVersion, stats: { page: number, rounds: number, outside: number, cells: number, boxes: number }[] }
  | { status: 'failed', basePdfSha256: string, errorKind: ImportErrorKind }

export interface ImportLimits {
  /** 既定 20MB */
  maxBytes?: number
  /** 既定 30 ページ */
  maxPages?: number
  /** 変換の全体の時間の上限（ミリ秒）。既定 15 分 */
  deadlineMs?: number
}

export interface ImportDeps {
  ask: Ask
  /** key の一覧（既定は core/fields.json から作る） */
  catalog?: string[]
  /** 登録済みの全体の様式の元の PDF のハッシュ。同じなら変換しない */
  knownSha256?: Set<string>
  limits?: ImportLimits
}

const DEFAULT_LIMITS = { maxBytes: 20 * 1024 * 1024, maxPages: 30, deadlineMs: 15 * 60 * 1000 }

class Timeout extends Error {}

/** PDF を開いたときのエラー → 失敗の種類 */
export function errorKindOfOpen(e: unknown): ImportErrorKind {
  return (e as { name?: string })?.name === 'PasswordException' ? 'encrypted' : 'invalid_pdf'
}

export async function importPdf(data: Uint8Array, deps: ImportDeps): Promise<ImportResult> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits }
  const basePdfSha256 = createHash('sha256').update(data).digest('hex')
  const fail = (errorKind: ImportErrorKind): ImportResult => ({ status: 'failed', basePdfSha256, errorKind })
  if (data.byteLength > limits.maxBytes) return fail('too_large')
  if (deps.knownSha256?.has(basePdfSha256)) return { status: 'matched', basePdfSha256 }

  let pdf
  try {
    pdf = await openPdf(data)
  } catch (e) {
    return fail(errorKindOfOpen(e))
  }
  try {
    if (await pdf.risky()) return fail('unsafe_pdf')
    if (pdf.numPages > limits.maxPages) return fail('too_many_pages')
    const textPages: number[] = []
    for (let n = 1; n <= pdf.numPages; n++) if ((await pdf.layout(n)).chars.length) textPages.push(n)
    if (!textPages.length) return fail('no_text')

    const catalog = deps.catalog ?? defaultCatalog()
    const deadline = Date.now() + limits.deadlineMs
    const drafts: PageDraft[] = []
    for (let n = 1; n <= pdf.numPages; n++) {
      if (!textPages.includes(n)) {
        // 文字のないページ（画像だけ）は変換しない。ページとしては残し、要確認に書く
        const p = await pdf.layout(n)
        drafts.push({ page: n, width: p.width, height: p.height, slots: [], localFields: [], problems: ['文字がないので変換しなかった（画像だけのページ）'], cells: [], boxes: [], rounds: [], outside: 0 })
        continue
      }
      const left = deadline - Date.now()
      if (left <= 0) return fail('timeout')
      let timer: NodeJS.Timeout | undefined
      try {
        drafts.push(await Promise.race([
          convertPage(pdf, n, { ask: deps.ask, catalog }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout()), left) }),
        ]))
      } catch (e) {
        return fail(e instanceof Timeout ? 'timeout' : 'ai_failed')
      } finally {
        clearTimeout(timer)
      }
    }
    const draft = buildVersion(drafts)
    // 出口の確かめで見つかったことは要確認に足す（公開前の確かめは #103 でも必ず行う）
    for (const e of checkDraftVersion(draft)) draft.review.push({ slot: e.split(':')[0], reason: e.slice(e.indexOf(':') + 1).trim() })
    return {
      status: 'succeeded', basePdfSha256, draft,
      stats: drafts.map((d) => ({ page: d.page, rounds: d.rounds.length, outside: d.outside, cells: d.cells.length, boxes: d.boxes.length })),
    }
  } finally {
    await pdf.close()
  }
}

/**
 * 版の出口の確かめ（13_DB設計.md の「様式を公開する前の確かめ」と同じ 3 つ）:
 *   1. すべての印字欄に対応がある（対応だけあって印字欄がないものもない）
 *   2. 対応が指す key が、fields.json か、その版の local_fields にある
 *   3. local_fields の key は local. で始まり、版の中で重ならない
 */
export function checkDraftVersion(v: Pick<DraftVersion, 'schemas' | 'bindings' | 'localFields'>): string[] {
  const errors: string[] = []
  const names = new Set(v.schemas.flat().map((s) => s.name))
  for (const n of names) if (!v.bindings[n]) errors.push(`${n}: 印字欄に対応がない`)
  for (const n of Object.keys(v.bindings)) if (!names.has(n)) errors.push(`${n}: 対応があるのに印字欄がない`)
  const localKeys = new Set(v.localFields.map((f) => f.key))
  const shared: Bindings = {}
  for (const [n, b] of Object.entries(v.bindings)) {
    if (b.ref.key.startsWith('local.')) {
      if (!localKeys.has(b.ref.key)) errors.push(`${n}: fields.json にも local_fields にもない key ${b.ref.key}`)
    } else if (BY_KEY.has(b.ref.key)) {
      shared[n] = b
    } else {
      errors.push(`${n}: fields.json にも local_fields にもない key ${b.ref.key}`)
    }
  }
  errors.push(...checkBindings(shared))
  const seen = new Set<string>()
  for (const f of v.localFields) {
    if (seen.has(f.key)) errors.push(`local_fields: ${f.key} が重なっている`)
    seen.add(f.key)
    if (!f.key.startsWith('local.')) errors.push(`local_fields: ${f.key} が local. で始まらない`)
  }
  return errors
}
