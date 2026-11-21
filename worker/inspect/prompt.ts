// AI 点検の指示文。先頭は書類（どの呼び出しも同じ）にして、キャッシュに当てる。
// 点検は書類の値だけを読む（録音は読まない）。足りないところを推測で埋めない。直しの案は作らない。
import type { CheckItem } from '../../core/checks/index.ts'

export interface PromptDoc { kindName: string, text: string }

/** 先頭（書類）。同じ点検の呼び出しは、ここまで同じ */
export const head = (docs: PromptDoc[]) => `あなたは、居宅介護支援のケアプラン点検をする点検者です。下の書類を読み、厚生労働省の「ケアプラン点検項目」の評価基準で、項目ごとに段階を付けます。

## 点検する書類
${docs.map((d) => `### ${d.kindName}\n${d.text || '（値のある欄がありません）'}`).join('\n\n')}
`

const fmtItem = (i: CheckItem, met: Record<string, boolean> | undefined) => {
  const levels = (['3', '2', '1', '他'] as const).filter((k) => i.levels[k]).map((k) => `  - ${k}: ${i.levels[k]}`).join('\n')
  const criteria = i.criteria.map((c) => `  - ${c.mark} ${c.text}${met && c.mark in met ? `（プログラムで確かめ済み: ${met[c.mark] ? '当たる' : '当たらない'}）` : ''}`).join('\n')
  return [
    `### ${i.id}. ${i.name}`,
    `- 段階:\n${levels}`,
    ...(criteria ? [`- 観点:\n${criteria}`] : []),
    ...(i.notes.length ? [`- 注: ${i.notes.join(' ')}`] : []),
    ...(i.guide ? [`- 読み方: ${i.guide}`] : []),
  ].join('\n')
}

/** 項目の部分（呼び出しごとに違う） */
export const body = (items: CheckItem[], met: ReadonlyMap<string, Record<string, boolean>>) => `
## 点検する項目
${items.map((i) => fmtItem(i, met.get(i.id))).join('\n\n')}

## 決まり
- 書類に書いてあることだけで判定する。書いていないことを推測で補わない。どの欄に書いてあってもよい（特記・全体のまとめの文章も読む）。
- 段階は、その項目の「段階」にあるものだけを使う。
- 観点（①②…）がある項目は、観点ごとに当たるか（met: true／false）も返す。
- 段階が 1 の項目だけ、missing に、何が足りないかをケアマネに分かる短い言葉（30 字ほど。例「量（mL など）が書かれていない」）で書く。直し方や書く案は書かない。段階が 2 以上か「他」なら missing は null。
`

/** 答えの形。項目ごとに段階・観点の当否・足りない情報 */
export function schema(items: CheckItem[]) {
  return {
    type: 'object',
    properties: {
      results: {
        type: 'object',
        properties: Object.fromEntries(items.map((i) => [i.id, {
          type: 'object',
          properties: {
            level: { type: 'string', enum: Object.keys(i.levels) },
            met: { type: 'object', properties: Object.fromEntries(i.criteria.map((c) => [c.mark, { type: 'boolean' }])) },
            missing: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
          required: ['level'],
        }])),
        required: items.map((i) => i.id),
      },
    },
    required: ['results'],
  }
}
