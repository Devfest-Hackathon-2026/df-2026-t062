// 様式の版（DB の form_template_versions の 1 行）。画面・api・worker で共通に使う。
// 様式はコードではなくデータ: 欄の位置（pdfme の schemas）・対応（bindings）・ページ。版は書き換えない。
import { formKeys, type Bindings } from './binding.ts'

/**
 * 書類の種類の key（form_kinds.key）。種類は DB の行で、コードは種類の名前を知らない（docs/再設計/16 の「書類の種類ごとの動き」）。
 * 書類はどれか 1 つの種類の、ある版を指す
 */
export type FormKind = string

export interface TemplateSlot {
  name: string
  type: 'text' | 'circleMark'
  position: { x: number, y: number }
  width: number
  height: number
  fontSize?: number
  fontName?: string
  color?: string
  borderWidth?: number
  lineHeight?: number
  alignment?: 'left' | 'center' | 'right'
  verticalAlignment?: 'top' | 'middle' | 'bottom'
  dynamicFontSize?: { min: number, max: number, fit: string }
}

export interface FormPage {
  /** 用紙に印刷されたページ番号（1 から） */
  no: number
  /** schemas（と元の PDF）の何番目のページか */
  pdfIndex: number
  title: string
  /** mm */
  width: number
  height: number
  /** 保存値から印字時だけ展開する。様式の種類ではなく、この宣言で改ページを決める。 */
  print?: { type: 'text' } | {
    type: 'table'
    key: string
    nested: string[]
    slots: string[]
    rowsPerPage: number
    rowHeight: number
  } | {
    type: 'timeline'
    key: string
    slot: string
    days: string[]
    dayField: string
    startField: string
    endField: string
    labelField: string
    activity?: { key: string, slot: string, timeField: string, labelField: string }
  }
}

/** api が画面に渡す様式の版（中身は変わらないので、ブラウザが覚えておける。置き場の場所は渡さない） */
export interface FormVersionView {
  id: string
  kind: FormKind
  name: string
  version: number
  schemas: TemplateSlot[][]
  bindings: Bindings
  pages: FormPage[]
  contentSha: string
}

/** ページの画像の期限つきの URL（画像がまだ置き場になければ null）と、元の PDF が置き場にあるか */
export interface FormAssetsView {
  pages: { no: number, url: string | null }[]
  hasPdf: boolean
  expiresAt: string
}

/** 共通の仕組みで使う形（読む key を足したもの） */
export interface FormDef extends FormVersionView {
  keys: string[]
}

export function toFormDef(v: FormVersionView): FormDef {
  return { ...v, keys: formKeys(v.bindings) }
}

/** 印字欄の名前 → ページ（用紙のページ番号） */
export function slotPages(form: Pick<FormDef, 'pages' | 'schemas'>): Map<string, number> {
  const out = new Map<string, number>()
  for (const p of form.pages) for (const s of form.schemas[p.pdfIndex] ?? []) out.set(s.name, p.no)
  return out
}

/**
 * 版の中身の指紋（同じ中身なら同じ版。登録のとき、変わったかどうかを見る）。
 * その様式だけの欄の定義（local_fields）は、あるときだけ入れる（定義のない今の版の指紋を変えないため）
 */
export function contentOf(input: { kind: string, schemas: TemplateSlot[][], bindings: Bindings, pages: FormPage[], localFields?: unknown[] }): string {
  const { kind, schemas, bindings, pages, localFields } = input
  return JSON.stringify(sortKeys({ kind, schemas, bindings, pages, ...(localFields?.length ? { localFields } : {}) }))
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
  return v
}

/**
 * 置き場（非公開の forms の置き場）の中の場所は、元の PDF のハッシュで決める（docs/再設計/13_DB設計.md の「PDF の置き場」）。
 * 全体の様式は pdf/<sha256>/、事業所の様式は offices/<office_id>/pdf/<sha256>/（同じ PDF でも事業所をまたいで共有しない）。
 * 同じ様式の版どうしは同じファイル（対応だけを直した新しい版は、入れ直さなくてよい）。場所が中身で決まるので上書きは起きない。
 */
const assetDir = (sha256: string, officeId: string | null) => `${officeId ? `offices/${officeId}/` : ''}pdf/${sha256}`
export const basePdfAssetPath = (sha256: string, officeId: string | null = null) => `${assetDir(sha256, officeId)}/base.pdf`
/** ページの画像。PDF の何ページ目か（1 から。様式のページの pdfIndex + 1） */
export const pageImageAssetPath = (sha256: string, pdfPage: number, officeId: string | null = null) => `${assetDir(sha256, officeId)}/pages/p${pdfPage}.png`
/** 上げたままの PDF（変換の前）。全体の様式は imports/<id>.pdf、事業所の様式は offices/<office_id>/imports/<id>.pdf */
export const importPdfPath = (importId: string, officeId: string | null) => `${officeId ? `offices/${officeId}/` : ''}imports/${importId}.pdf`
