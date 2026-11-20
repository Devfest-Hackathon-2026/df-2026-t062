import { useEffect, useId, useRef } from 'react'
import type { DocumentMime } from '../../core/document-input.ts'

export function OriginalPreview({ url, mime, fileName, page, onClose }: {
  url: string, mime: DocumentMime, fileName: string, page: number, onClose: () => void,
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal()
  }, [])
  const source = mime === 'application/pdf' ? `${url}#page=${page}` : url
  return <dialog ref={dialog} className="document-original" aria-labelledby={title} onClose={onClose}>
    <header>
      <div><strong id={title}>原本 p.{page}</strong><small>{fileName}</small></div>
      <button type="button" onClick={() => dialog.current?.close()}>閉じる</button>
    </header>
    <div className="document-original-content">
      {mime === 'application/pdf' ? <iframe title={`${fileName}の原本 p.${page}`} src={source} />
        : <img src={source} alt={`${fileName}の原本`} />}
    </div>
    <footer><a href={source} target="_blank" rel="noopener noreferrer">別のタブで原本を開く</a></footer>
  </dialog>
}
