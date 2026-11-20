import { writableFields } from '../../core/dictionary.ts'
import type { FormDef } from '../../core/form.ts'
import type { DocumentReadResult } from '../../core/document-input.ts'
import { norm } from '../vertex/common.ts'

/** 不確かな行と同じ見出しの欄は、別の記載から補完して候補にしない。値の割当は行わない。 */
export function unresolvedFieldKeys(form: FormDef, reading: DocumentReadResult): Set<string> {
  const unclear = [...reading.issues.map((issue) => norm(issue.text)), ...reading.evidence.filter((entry) => entry.uncertain).map((entry) => norm(entry.text))]
  return new Set(writableFields(form).filter((field) => {
    const label = field.label.normalize('NFKC').replace(/^[\d\s.・\-‐–—()（）]+/u, '')
    const name = norm(label)
    return name.length >= 2 && unclear.some((text) => text.includes(name))
  }).map((field) => field.key))
}
