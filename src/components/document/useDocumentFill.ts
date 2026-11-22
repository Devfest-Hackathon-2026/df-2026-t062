// 書類を作るときに AI が書く（#195）の仕事の様子。書類を開いている間、動いている仕事を 1.5 秒ごとに読み直す。
// 終わったら onDone（書類を読み直す）。この画面で終わりを見届けた仕事だけ justDone にする（猫の「書き終わりました」）
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FillView } from '../../../db/document-fills.ts'
import { api } from '../../lib/api.ts'

const active = (f: FillView | null | undefined) => f?.status === 'queued' || f?.status === 'processing'

export function useDocumentFill(documentId: string | undefined, onDone: () => void) {
  const [fill, setFill] = useState<FillView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [justDone, setJustDone] = useState(false)
  const [error, setError] = useState('')
  const done = useRef(onDone)
  done.current = onDone
  const poll = useRef<() => void>(() => {})

  useEffect(() => {
    setFill(null); setLoaded(false); setJustDone(false); setError('')
    if (!documentId) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let wasActive = false
    const load = async () => {
      try {
        const r = await api.documentFill(documentId)
        if (stop) return
        setFill(r.fill)
        setLoaded(true)
        if (active(r.fill)) wasActive = true
        else if (wasActive) {
          wasActive = false
          if (r.fill?.status === 'failed') setError('AI が書けませんでした。少し待ってから、もう一度頼んでください。')
          else setJustDone(true)
          done.current()
        }
      } catch { if (!stop) setLoaded(true) }
      if (!stop && wasActive) timer = setTimeout(() => void load(), 1500)
    }
    void load()
    poll.current = () => { wasActive = true; clearTimeout(timer); void load() }
    return () => { stop = true; clearTimeout(timer) }
  }, [documentId])

  const start = useCallback(async () => {
    if (!documentId) return
    setError(''); setJustDone(false)
    try {
      await api.startFill(documentId)
      setFill((f) => ({ id: f?.id ?? '', sourceName: f?.sourceName ?? '', changes: 0, status: 'queued', step: 'read' }))
      poll.current()
    } catch {
      setError('AI に頼めませんでした。少し待ってから、もう一度押してください。')
    }
  }, [documentId])

  return { fill, loaded, working: active(fill), justDone, error, start }
}
