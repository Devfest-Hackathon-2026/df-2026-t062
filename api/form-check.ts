// 様式の下書きの試し印字と、公開前の確かめ（docs/再設計/13_DB設計.md の「様式を公開する前の確かめ」、#103）。
//   1. すべての印字欄に対応がある  2. 対応が指す key が fields.json かその版の local_fields にある
//   3. local_fields の key は local. で始まり、版の中で重ならない（1〜3 は worker/form-import/check.ts）
//   4. 架空の値で、すべての印字欄を実際に印字できる（pdfme で PDF を作る）
import { readFileSync } from 'node:fs'
import { formKeys } from '../core/binding.ts'
import type { FormVersion } from '../db/forms.ts'
import { checkDraftVersion } from '../worker/form-import/check.ts'
import type { LocalField } from '../worker/form-import/draft.ts'
import { FormUnavailable, makePdf } from './pdf.ts'
import type { Storage } from './storage.ts'

let sample: Record<string, unknown> | undefined
/** 架空の利用者（forms/samples/見本_花子.json。実在の人ではない） */
function sampleOf(): Record<string, unknown> {
  if (!sample) {
    const raw = JSON.parse(readFileSync(new URL('../forms/samples/見本_花子.json', import.meta.url), 'utf8')) as Record<string, unknown>
    delete raw._comment
    sample = raw
  }
  return sample
}

/** その様式だけの欄の架空の値（型ごと） */
function localSample(f: LocalField): unknown {
  switch (f.type) {
    case 'date': return '2026-04-01'
    case 'number': return 1
    case 'bool': return true
    case 'enum': return f.choices?.[0] ?? null
    default: return `見本（${f.label}）`
  }
}

/** 試し印字の値: 共通の欄は架空の利用者の値、その様式だけの欄は型ごとの架空の値 */
export function sampleValues(v: Pick<FormVersion, 'bindings' | 'localFields'>): Record<string, unknown> {
  const base = sampleOf()
  const out: Record<string, unknown> = {}
  for (const key of formKeys(v.bindings)) if (key in base) out[key] = base[key]
  for (const f of v.localFields as LocalField[]) {
    const value = localSample(f)
    if (value !== null) out[f.key] = value
  }
  return out
}

/** 架空の値で印字した PDF（試し印字）。元の PDF が置き場になければ FormUnavailable */
export function previewPdf(storage: Storage, v: FormVersion): Promise<Uint8Array> {
  return makePdf(storage, v, sampleValues(v))
}

/** 公開してよいか。だめな理由の一覧（空なら公開してよい） */
export async function publishProblems(storage: Storage, v: FormVersion): Promise<string[]> {
  const problems = checkDraftVersion({ schemas: v.schemas as never, bindings: v.bindings, localFields: v.localFields as LocalField[] })
  if (!v.pages.length) problems.push('ページがない')
  if (!v.schemas.flat().length) problems.push('印字欄がない')
  for (const p of v.pages) if (!v.schemas[p.pdfIndex]) problems.push(`${p.no} ページ: PDF の ${p.pdfIndex + 1} ページ目に印字欄の並びがない`)
  if (problems.length) return problems
  try {
    await previewPdf(storage, v)
  } catch (e) {
    problems.push(e instanceof FormUnavailable ? '元の PDF が置き場にない' : `架空の値で印字できない（${(e as Error)?.name ?? 'Error'}）`)
  }
  return problems
}
