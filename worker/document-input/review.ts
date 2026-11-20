import { writableFields } from '../../core/dictionary.ts'
import type { FormDef } from '../../core/form.ts'
import type { DocumentReadResult } from '../../core/document-input.ts'
import { norm } from '../vertex/common.ts'

/** 不確かな行と同じ見出しの欄は、別の記載から補完して候補にしない。値の割当は行わない。 */
export function unresolvedFieldKeys(form: FormDef, reading: DocumentReadResult): Set<string> {
  // 自由文の警告には「X以外は未記入」「Xは正常」等も含まれる。
  // 明示された確認対象と不確実な原文だけで保留し、自由文から対象を推測しない。
  const unclear = [...reading.issues.flatMap((issue) => issue.labels ?? []).map(norm), ...reading.evidence.filter((entry) => entry.uncertain).map((entry) => norm(entry.text))]
  return new Set(writableFields(form).filter((field) => {
    const label = field.label.normalize('NFKC').replace(/^[\d\s.・\-‐–—()（）]+/u, '')
    const name = norm(label)
    return name.length >= 2 && unclear.some((text) => text.includes(name))
  }).map((field) => field.key))
}
