import { sameValue } from '../../core/apply-batch.ts'

/** 入力の自動送信と保存版の作成は別。送信キューが空でも、手入力の未保存を見失わない。 */
export function documentDirty(document: { hasLocalEdits: boolean, current: unknown, saved: unknown }): boolean {
  return document.hasLocalEdits || !sameValue(document.current, document.saved)
}

/** 第1表の送信失敗や競合を越えて「保存しました」と表示しない。確定は呼ばない。 */
export async function savePlanEdits<T>(steps: {
  flush: () => Promise<boolean>
  needs: () => Promise<number>
  schedule: (baseVersion: number) => Promise<number>
  save: (baseVersion: number) => Promise<T>
}): Promise<T> {
  if (!await steps.flush()) throw new Error('各表の入力を送信できませんでした。入力欄を確認してください。')
  const needsVersion = await steps.needs()
  const scheduleVersion = await steps.schedule(needsVersion)
  return steps.save(scheduleVersion)
}
