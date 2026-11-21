// 様式の版の出口の確かめ（#99）。api の公開前の確かめ（#103）も使うので、PDF を読むモジュール（pdfjs）を読み込まない。
import { BY_KEY } from '../../core/fields.ts'
import { checkBindings, type Bindings } from '../../core/binding.ts'
import type { DraftVersion } from './version.ts'

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
  for (const slot of v.schemas.flat()) if (v.bindings[slot.name]?.op === 'diagram@1' && slot.type !== 'image') errors.push(`${slot.name}: 図の印字欄はimage型が必要です`)
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
