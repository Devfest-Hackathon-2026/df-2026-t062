// 書類の種類（GET /api/form-kinds）。作業画面のタブと「＋ 書類を作る」が使う。種類は開いている間に変わらないので、1 回だけ読む。
import { useEffect, useState } from 'react'
import { api, type FormKindView } from '../lib/api.ts'

let cached: Promise<FormKindView[]> | undefined

export function useFormKinds(): FormKindView[] | null {
  const [kinds, setKinds] = useState<FormKindView[] | null>(null)
  useEffect(() => {
    let alive = true
    cached ??= api.formKinds().then((r) => r.kinds)
    cached.then((k) => { if (alive) setKinds(k) }, () => { cached = undefined })
    return () => { alive = false }
  }, [])
  return kinds
}

/** 開いている種類と、その書類。tab が空なら主な書類。何通もある種類は一番新しい書類 */
export function pickDocument(kinds: FormKindView[] | null, documents: { id: string, kind: string }[] | undefined, tab: string) {
  const key = tab || kinds?.find((k) => k.isPrimary)?.key || documents?.[0]?.kind || ''
  const kind = kinds?.find((k) => k.key === key)
  return {
    key,
    kind,
    /** 主な書類か（まだ種類を読んでいないときも、主な書類として扱う） */
    isPrimary: kind ? kind.isPrimary : !tab,
    docId: documents?.filter((d) => d.kind === key).at(-1)?.id,
    /** 写した元の種類の名前（写す種類だけ） */
    fromName: kind?.createFrom ? kinds?.find((k) => k.key === kind.createFrom)?.name ?? null : null,
  }
}
