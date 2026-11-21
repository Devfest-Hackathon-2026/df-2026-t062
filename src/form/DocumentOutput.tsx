import type { ReactNode } from 'react'

/** 作業画面上部の入力・保存状況と書類出力。 */
export function DocumentOutput({ status, progress, disabled, onExport }: {
  status: ReactNode, progress?: { filled: number, total: number }, disabled: boolean, onExport: () => void,
}) {
  return <div className="document-output">
    <div className="document-output-status">
      <div>{status}</div>
      {progress && <div className="document-progress" role="progressbar" aria-label="必須欄の入力状況" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.filled}>
        <div style={{ width: `${progress.total > 0 ? progress.filled / progress.total * 100 : 0}%` }} />
      </div>}
    </div>
    <button className="btn" type="button" onClick={onExport} disabled={disabled}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M5 20h14" /></svg>書類を出力
    </button>
  </div>
}
