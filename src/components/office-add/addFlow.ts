// 事業所の書類を足す流れ（#153）の、手順の決まり。#111 で採用した試作（prototypes/111-admin-adopted の「11・12. 事業所の書類を足す」）の手順。
import type { KindFormState } from '../../lib/api.ts'

// 録音から書く項目は、使い始めるときに AI が書式の欄から決める（#209。前の手順 4「聞き取ること」はなくした）。見直しは AI 特訓部屋（#154）でする
export const ADD_STEPS = ['書類について', '書式を上げる', '確かめる', '使い始める'] as const

/** 足している途中の書類（事業所で足した種類で、まだ書式を使い始めていない） */
export const adding = (k: KindFormState) => k.own && !k.current

/** 足している途中の書類の「続ける」の行き先。書式を上げる前なら手順 2、上げたあとは書類の画面（読み取り中・確かめるを出す） */
export function resumePath(k: KindFormState): string {
  const base = `/office/forms/${encodeURIComponent(k.key)}`
  return k.import || k.draft ? base : `${base}/upload`
}

/** 確かめる画面の「まだ」に並べる欄。AI は 1 つの欄に理由をいくつも付けることがあるので、欄ごとに 1 回だけにする（同じ欄が並ぶと、確かめたあとも行が残る） */
export const reviewSlotNames = (review: readonly { slot: string }[]): string[] => [...new Set(review.map((r) => r.slot))]
