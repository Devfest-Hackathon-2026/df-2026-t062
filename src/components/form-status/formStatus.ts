// 責任者の画面で使う、書類ごとの書式の様子（読み取り中・読めなかった・確かめ待ちなど）。
import { useCallback, useEffect, useState } from 'react'
import { api, type KindFormState } from '../../lib/api.ts'

/** 書類ごとの書式の様子を読み、読み取り中は数秒おきに読み直す */
export function useOfficeForms() {
  const [kinds, setKinds] = useState<KindFormState[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      setKinds((await api.officeForms()).kinds)
      setError('')
    } catch (e) { setError(String((e as Error).message)) }
  }, [])
  useEffect(() => { void load() }, [load])
  const reading = (kinds ?? []).some((k) => readingOf(k))
  useEffect(() => {
    if (!reading) return
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [reading, load])
  return { kinds, error, reload: load, setKinds }
}

const readingOf = (k: KindFormState) => !!k.import && k.import.uploaded && (k.import.status === 'queued' || k.import.status === 'processing')

/** 書類の画面の上に出す様子。取り込みが下書きより新しいときだけ、取り込みの様子を出す */
type Phase = 'reading' | 'failed' | 'same' | 'review' | 'empty' | 'fixing' | null
export function phaseOf(k: KindFormState): Phase {
  const imp = k.import && k.import.uploaded ? k.import : null
  if (imp && readingOf(k)) return 'reading'
  const draftAt = k.draft ? Date.parse(k.draft.createdAt) : 0
  if (imp && imp.status === 'failed' && Date.parse(imp.updatedAt) >= draftAt) return 'failed'
  if (imp && imp.status === 'matched' && Date.parse(imp.updatedAt) >= draftAt && !dismissed(imp.id)) return 'same'
  if (k.draft) return k.draft.fromImport ? (k.draft.empty ? 'empty' : 'review') : 'fixing'
  return null
}

const DISMISS_KEY = 'careman.office.dismissed'
function dismissed(importId: string): boolean {
  try { return (JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]') as string[]).includes(importId) } catch { return false }
}
export function dismiss(importId: string) {
  try {
    const list = (JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]') as string[]).filter((x) => x !== importId)
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...list.slice(-50), importId]))
  } catch { /* 覚えられなくても、閉じるだけ */ }
}

/** 読めなかった理由（責任者の言葉で） */
export function failText(kind: string | null): { title: string, text: string } {
  switch (kind) {
    case 'no_text': return { title: '読み取れませんでした', text: '紙を写真やスキャンにした PDF のようです。Word や Excel から PDF に書き出して、上げ直してください。' }
    case 'encrypted': return { title: '読み取れませんでした', text: 'パスワードのかかった PDF は読めません。パスワードを外してから上げ直してください。' }
    case 'too_large': return { title: 'PDF が大きすぎます', text: '20MB までの PDF を上げてください。' }
    case 'too_many_pages': return { title: 'ページが多すぎます', text: 'ページの少ない PDF に分けられないか確かめてください。' }
    case 'invalid_pdf': case 'unsafe_pdf': return { title: '読み取れませんでした', text: 'PDF として開けませんでした。Word や Excel から PDF に書き出して、上げ直してください。' }
    default: return { title: '読み取れませんでした', text: 'うまく読み取れませんでした。少し待ってから、もう一度上げてください。' }
  }
}

export const day = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}
