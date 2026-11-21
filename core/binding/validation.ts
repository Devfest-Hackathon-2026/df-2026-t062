import { diagramKinds } from '../diagram/fields.ts'
import { GLOBAL_DICT, type FieldDict } from '../dictionary.ts'
import type { Cond, Ref, Binding, Bindings } from './types.ts'
import { specsAlong } from './conditions.ts'
import { canToggle } from './edit.ts'

// ---------- 読む key ----------

function condKeys(c: Cond | undefined, own: Ref, out: Set<string>) {
  if (!c) return
  if ('all' in c) c.all.forEach((x) => condKeys(x, own, out))
  else if ('any' in c) c.any.forEach((x) => condKeys(x, own, out))
  else out.add((c.ref ?? own).key)
}

/** その印字欄の表示が読む key（前提の欄も含む） */
export function keysOf(b: Binding): string[] {
  const out = new Set<string>([b.ref.key])
  if ('when' in b) condKeys(b.when, b.ref, out)
  if (b.op === 'option@1') {
    condKeys(b.if, b.ref, out)
    for (const a of [b.edit?.on, b.edit?.off]) if (a && 'set' in a) for (const s of a.set) out.add((s.ref ?? b.ref).key)
  }
  if (b.op === 'text@1') for (const alt of b.or ?? []) for (const r of 'concat' in alt ? alt.concat : [alt]) out.add(r.key)
  if (b.op === 'date@1') for (const r of b.yearFrom ?? []) out.add(r.key)
  if (b.op === 'ageAt@1') { out.add(b.birth.key); b.at.forEach((r) => out.add(r.key)) }
  // 前提（requires）は fields.json の欄だけが持つ（その様式だけの欄は持たない）
  for (const k of Object.keys(GLOBAL_DICT.get(b.ref.key)?.requires ?? {})) out.add(k)
  return [...out]
}

/** 様式が読む key の全部 */
export function formKeys(bindings: Bindings): string[] {
  const out = new Set<string>()
  for (const b of Object.values(bindings)) for (const k of keysOf(b)) out.add(k)
  return [...out].sort()
}

/** 対応の確かめ（読み込むときと CI）。key・項目が fields.json にあるか、丸・✓ の直しが決まっているか */
export function checkBindings(bindings: Bindings, dict: FieldDict = GLOBAL_DICT): string[] {
  const errors: string[] = []
  const refOk = (slot: string, r: Ref) => {
    if (!dict.get(r.key)) errors.push(`${slot}: ${dict === GLOBAL_DICT ? 'fields.json にない' : 'fields.json にも local_fields にもない'} key ${r.key}`)
    else {
      const names = (r.path ?? []).filter((s): s is string => typeof s === 'string')
      if (specsAlong(r, dict).length !== names.length + 1) errors.push(`${slot}: ${r.key} に項目 ${names.join('.')} がない`)
    }
  }
  for (const [slot, b] of Object.entries(bindings)) {
    refOk(slot, b.ref)
    if (b.op === 'diagram@1' && (!diagramKinds[b.ref.key] || b.ref.path?.length || b.ui !== 'diagram')) errors.push(`${slot}: 図の欄または参照が正しくありません`)
    if (b.op === 'option@1' && !b.edit && !canToggle(b.is)) errors.push(`${slot}: 丸・✓ を付け外ししたときの動き（edit）が決まっていない`)
    if (b.op === 'option@1' && !b.is && !b.if) errors.push(`${slot}: 丸・✓ を付ける条件がない`)
    if (b.op === 'text@1') for (const alt of b.or ?? []) for (const r of 'concat' in alt ? alt.concat : [alt]) refOk(slot, r)
    if (b.op === 'ageAt@1') { refOk(slot, b.birth); b.at.forEach((r) => refOk(slot, r)) }
  }
  return errors
}
