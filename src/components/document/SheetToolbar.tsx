import type { ReactNode } from 'react'

/** アセスメントとケアプランの用紙ヘッダー。配置・色・保存操作の外観を共通に保つ。 */
export function SheetToolbar({ title, page, zoom, onZoom, hasUpdates = false, aiLabel = '今回の録音から', status, saved, saveHint, disabled, onSave, actions }: {
  title: string, page: string, zoom: number, onZoom: (zoom: number) => void,
  hasUpdates?: boolean, aiLabel?: string, status?: ReactNode, saved?: boolean, saveHint?: string,
  disabled?: boolean, onSave: () => void, actions?: ReactNode,
}) {
  return <div className="sheet-toolbar">
    <h2>{title} <span>{page}</span></h2>
    <div className="sheet-legends">
      <span className="lg"><span aria-hidden="true" className="sheet-key sheet-blue" />入力できる欄</span>
      <span className="lg"><span aria-hidden="true" className="sheet-key sheet-orange" />{aiLabel}</span>
      {hasUpdates
        ? <span className="lg"><span aria-hidden="true" className="sheet-key sheet-diff" />変わったところ（押すと前の文）</span>
        : <span className="lg"><span aria-hidden="true" className="sheet-key sheet-yellow" />直したところ</span>}
    </div>
    <div className="sheet-actions">
      <div role="group" aria-label="拡大" className="sheet-zoom">
        <button className="btn btn-i" type="button" aria-label="小さくする" onClick={() => onZoom(Math.max(80, zoom - 20))}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg></button>
        <span>{zoom}%</span>
        <button className="btn btn-i" type="button" aria-label="大きくする" onClick={() => onZoom(Math.min(160, zoom + 20))}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg></button>
      </div>
      <span className="sheet-status">{status}</span>
      {saved && <span role="status" className="sheet-saved">保存しました</span>}
      {saveHint && <span className="sheet-status">{saveHint}</span>}
      <div className="sheet-save-actions" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      <button type="button" className="savebtn pc-work-save" aria-label="書類を保存" disabled={disabled} onClick={onSave}>保存</button>
      {actions}
      </div>
    </div>
  </div>
}
