import type { DocumentInputView } from '../../../core/document-input.ts'
import type { JobView } from '../../lib/api.ts'
import type { InspectionSummary } from '../inspection/petInspection.ts'

export interface Guidance {
  text: string
  action?: 'review' | 'documents' | 'inspect' | 'interview' | 'save' | 'page-save'
  kind?: 'return' | 'break'
}

export function workGuidance({
  conflict, saveFailure, pageSaved, unsaved, returned, pending, reviewChange, reviewComplete,
  inputs, job, jobFinished, inspection, inspectionFinished, breakLevel, interview,
}: {
  conflict: boolean
  saveFailure?: 'page' | 'document'
  pageSaved: boolean
  unsaved: boolean
  returned: boolean
  pending: number
  reviewChange: number
  reviewComplete: boolean
  inputs?: DocumentInputView[]
  job?: JobView
  jobFinished: boolean
  inspection?: InspectionSummary
  inspectionFinished: boolean
  breakLevel: number
  interview: boolean
}): Guidance {
  if (conflict) return { text: '入力が重なった項目があります。用紙の表示を見比べてください。' }
  if (saveFailure === 'page') return { text: 'このページを保存できませんでした。', action: 'page-save' }
  if (saveFailure) return { text: '用紙の変更を保存できませんでした。', action: 'save' }
  if (job?.status === 'failed') return { text: '面談の処理を完了できませんでした。録音は保存されています。用紙に表示された案内を確認してください。' }
  const latestInput = inputs?.[0]
  if (latestInput?.status === 'failed') return { text: '書類を読み取れませんでした。取り込みの詳細を確認してください。', action: 'documents' }
  if (returned && unsaved) return { text: '用紙に未保存の変更があります。続きから入力できます。', action: 'save', kind: 'return' }
  if (pageSaved && unsaved) return { text: 'このページは保存されました。別のページに未保存の変更があります。', action: 'save' }
  if (job?.status === 'partial' && jobFinished) return { text: '面談の一部を処理できませんでした。用紙に反映された内容を確認してください。', action: pending ? 'review' : undefined }
  if (pending) {
    if (returned) return { text: `確認の続きから始められます。残りは${pending}件です。`, action: 'review', kind: 'return' }
    if (reviewChange > 0) return { text: `確認が必要な項目が${reviewChange}件増えました。未確認は${pending}件です。`, action: 'review' }
    if (pending === 1 && reviewChange < 0) return { text: 'あと1件です。該当する欄を見てみましょう。', action: 'review' }
    return { text: pending === 1 ? '未確認の項目が1件あります。該当する欄を見てみましょう。' : `未確認の項目が${pending}件あります。`, action: 'review' }
  }
  const candidates = inputs?.reduce((count, input) => count + (input.status === 'review'
    ? input.result?.candidates.filter(({ key }) => !input.adopted.includes(key)).length ?? 0 : 0), 0) ?? 0
  if (candidates) return { text: `取り込んだ書類に確認できる項目が${candidates}件あります。`, action: 'documents' }
  if (reviewComplete && unsaved) return { text: 'すべての確認が終わりました。用紙の変更を保存しましょう。', action: 'save' }
  if (inspectionFinished && inspection?.status === 'failed') return { text: '点検を完了できませんでした。点検の画面から確認できます。', action: 'inspect' }
  if (inspectionFinished && inspection?.missingCount) return { text: `点検が終わりました。確認が必要な項目が${inspection.missingCount}件あります。`, action: 'inspect' }
  if (job?.status === 'queued' || job?.status === 'processing') return { text: job.status === 'queued' ? '面談の処理を待っています。' : '面談の内容を整理しています。' }
  if (inputs?.some(({ status }) => status === 'queued' || status === 'processing')) return { text: '書類を読み取っています。用紙の作業を続けられます。', action: 'documents' }
  if (inspection?.status === 'queued' || inspection?.status === 'processing') return { text: '用紙を点検しています。', action: 'inspect' }
  if (jobFinished) return { text: '面談の処理が終わりました。用紙の内容を確認できます。' }
  if (inspectionFinished) return { text: inspection?.status === 'partial' ? '一部の項目を点検できませんでした。点検結果を確認してください。'
    : '今回の点検で、確認が必要な項目はありませんでした。', action: 'inspect' }
  if (breakLevel) return { text: unsaved ? 'ここまでの変更を保存して、ひと息つけますよ。'
    : breakLevel === 2 ? '作業が長くなってきましたね。ここでひと息つきますか？'
    : '用紙は保存されています。ひと息つきますか？', action: unsaved ? 'save' : undefined, kind: 'break' }
  if (reviewComplete) return { text: 'すべての確認が終わりました。' }
  if (reviewChange < 0) return { text: '確認が必要な項目はありません。' }
  if (interview) return { text: '次の面談で確認できる話題があります。', action: 'interview' }
  return { text: '今日は何から一緒に進めましょうか？' }
}
