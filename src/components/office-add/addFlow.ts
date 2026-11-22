// 事業所の書類を足す流れ（#153）の、手順の決まり。#111 で採用した試作（prototypes/111-admin-adopted の「11・12. 事業所の書類を足す」）の手順。
import type { KindFormState } from '../../lib/api.ts'

export const ADD_STEPS = ['書類について', '書式を上げる', '確かめる', '聞き取ること', '使い始める'] as const

/** 足している途中の書類（事業所で足した種類で、まだ書式を使い始めていない） */
export const adding = (k: KindFormState) => k.own && !k.current

/** 足している途中の書類の「続ける」の行き先。書式を上げる前なら手順 2、上げたあとは書類の画面（読み取り中・確かめる・聞き取ることを出す） */
export function resumePath(k: KindFormState): string {
  const base = `/office/forms/${encodeURIComponent(k.key)}`
  return k.import || k.draft ? base : `${base}/upload`
}
