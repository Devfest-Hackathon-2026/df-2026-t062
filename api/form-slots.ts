// 責任者の画面（#102）: 下書きの印字欄を、言葉で直す・使っていないことにする。
// 言葉は当てはめ（AI）で fields.json か、その版だけの欄に当てる。どれにも当たらなければ、その様式だけの欄（local.*）を作る。
import type { Bindings } from '../core/binding.ts'
import type { LocalField } from '../core/dictionary.ts'
import type { TemplateSlot } from '../core/form.ts'
import { bindingFromMatch, fieldCandidates, isMarkSlot, localFieldFor, type FieldMatcher, type SlotShape } from '../core/slot-meaning.ts'
import * as forms from '../db/forms.ts'
import type { Db } from '../db/pool.ts'
import * as repo from '../db/repo.ts'

export type SlotEdit = { base: string, text: string } | { base: string, unused: true }

/** どの対応からも読まれなくなった、その様式だけの欄を落とす */
function prune(localFields: readonly LocalField[], bindings: Bindings): LocalField[] {
  const used = new Set(Object.values(bindings).map((b) => b.ref.key))
  return localFields.filter((f) => used.has(f.key))
}

/**
 * 印字欄を直して、直した下書きを返す。matched: field（fields.json かその版の欄に当たった）・local（その様式だけの欄を作った）・unused（消した）。
 * 当てはめ（AI）を呼ぶ前に、直してよい下書きか・指紋が今と同じかを確かめる（費用をかけてから断らない）
 */
export async function editSlot(db: Db, scope: forms.ManagerScope, id: string, slotName: string, edit: SlotEdit, matcher: () => Promise<FieldMatcher>): Promise<{ version: forms.FormVersion, matched: 'field' | 'local' | 'unused' }> {
  const v = await forms.versionForManager(db, scope, id)
  if (v.officeId !== scope.officeId) throw new repo.Forbidden('全体の様式は変えられません')
  if (v.status !== 'draft') throw new forms.NotDraft(id)
  if (v.contentSha !== edit.base) throw new repo.Conflict('form_version')
  const slot = v.schemas.flat().find((s) => s.name === slotName) as (TemplateSlot & { type: string, height: number }) | undefined
  if (!slot) throw new repo.NotFound(slotName)

  const rest: Bindings = { ...v.bindings }
  const prev = rest[slotName]
  delete rest[slotName]

  if ('unused' in edit) {
    const schemas = v.schemas.map((page) => page.filter((s) => s.name !== slotName))
    const version = await forms.updateDraft(db, scope, id, edit.base, { schemas, bindings: rest, localFields: prune(v.localFields, rest) })
    return { version, matched: 'unused' }
  }

  const text = edit.text.trim()
  const shape: SlotShape = { mark: isMarkSlot(slot, prev), height: Number(slot.height) || 0, prev, circle: slot.type === 'circleMark' }
  const kept = prune(v.localFields, rest)
  const hit = await (await matcher())({ text, mark: shape.mark, candidates: fieldCandidates(shape.mark, kept) })
  const fromField = hit ? bindingFromMatch(hit, shape, kept) : null
  if (fromField) {
    const version = await forms.updateDraft(db, scope, id, edit.base, { bindings: { ...rest, [slotName]: fromField }, localFields: kept })
    return { version, matched: 'field' }
  }
  const local = localFieldFor(text, shape, kept)
  const binding = shape.mark
    ? { op: 'option@1' as const, ui: (prev?.ui === 'circle' || shape.circle ? 'circle' : 'check') as 'circle' | 'check', ref: { key: local.key }, is: { eq: true } }
    : { op: 'text@1' as const, ui: (prev && prev.op === 'text@1' ? prev.ui : local.type === 'longtext' ? 'area' : 'text') as 'text' | 'area', ref: { key: local.key } }
  const version = await forms.updateDraft(db, scope, id, edit.base, { bindings: { ...rest, [slotName]: binding }, localFields: [...kept, local] })
  return { version, matched: 'local' }
}
