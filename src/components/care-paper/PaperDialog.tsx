import { useEffect, useRef, type ReactNode } from 'react'

/** 用紙の並びを動かさず、必要な操作だけを開く。 */
export function PaperDialog({ title, onClose, children }: { title: string, onClose: () => void, children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return <dialog ref={ref} className="care-paper-dialog" aria-label={title} onCancel={onClose}>
    <header><strong>{title}</strong><button type="button" className="btn" onClick={onClose}>閉じる</button></header>
    {children}
  </dialog>
}
