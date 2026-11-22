// 様式の取り込み（#99）: Gemini に渡すもの（key の一覧、ページの文字と罫線、マスと □ の一覧、指示文、答えの形）。
// 指示文は、実物の様式で精度を測って決めた（#110 の決定）。言い回しを変えるときは、精度を測り直す。
import { FIELDS } from '../../core/fields.ts'
import type { Cell } from './geometry.ts'
import type { DraftSlot } from './draft.ts'
import type { LayoutPage } from './pdf.ts'

type Choices = string[] | string | undefined
interface FieldDef { key?: string, label?: string, type?: string, choices?: Choices, of?: string, fields?: FieldDef[] }
interface FieldsJson { choiceSets?: Record<string, string[]>, types?: Record<string, { label?: string, fields: FieldDef[] }>, fields: FieldDef[] }

/** AI に渡す key の一覧（key｜名前｜型｜選択肢）。型の中の欄は「key.欄」、行の欄は「key[].欄」に展開する。書く場所（forms）は答えになるので渡さない */
export function catalogLines(fj: FieldsJson): string[] {
  const choices = (c: Choices) => {
    const list = typeof c === 'string' ? fj.choiceSets?.[c] : c
    return list?.length ? `｜${list.join('/')}` : ''
  }
  const line = (key: string, label: string, f: FieldDef) => `${key}｜${label}｜${f.type}${choices(f.choices)}`
  const out: string[] = []
  for (const f of fj.fields) {
    if (!f.key) continue
    const sub = f.of ? fj.types?.[f.of]?.fields : f.fields
    if ((f.type === 'object' || f.type === 'list') && sub) {
      const base = f.type === 'list' ? `${f.key}[]` : f.key
      for (const s of sub) if (s.key) out.push(line(`${base}.${s.key}`, `${f.label} の ${s.label}`, s))
    } else {
      out.push(line(f.key, f.label ?? '', f))
    }
  }
  return out
}

/** core/fields.json の key の一覧 */
export const catalog = (): string[] => catalogLines(FIELDS as unknown as FieldsJson)

/** key の一覧の key → 型（「はい・いいえ」の印を補うときに使う） */
export const catalogTypes = (lines: string[]): Map<string, string> =>
  new Map(lines.map((l) => { const [k, , t] = l.split('｜'); return [k, t] as [string, string] }))

type Word = LayoutPage['words'][number]

const r1 = (v: number) => String(Math.round(v * 10) / 10)
const MIN_LINE = 5 // これより短い罫線は □ の辺などなので省く

/** ページの文字（行ごとの語と位置）と罫線（5mm 以上） */
export function pageText(p: Pick<LayoutPage, 'width' | 'height' | 'words' | 'hlines' | 'vlines'>): string {
  const rows: Word[][] = []
  for (const w of [...p.words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
    const row = rows.find((r) => Math.abs(r[0].y0 - w.y0) < 1)
    if (row) row.push(w)
    else rows.push([w])
  }
  const lines = (ls: [number, number, number][]) => {
    const kept: [number, number, number][] = []
    for (const [at, a, b] of [...ls].sort((m, n) => m[0] - n[0] || m[1] - n[1])) {
      if (b - a < MIN_LINE) continue
      // 0.3mm 以内に並ぶほぼ同じ長さの線は、四角の辺の二重線なので 1 本にする
      if (kept.some(([k, ka, kb]) => Math.abs(k - at) <= 0.3 && Math.abs(ka - a) <= 0.5 && Math.abs(kb - b) <= 0.5)) continue
      kept.push([at, a, b])
    }
    return kept.map(([at, a, b]) => `${r1(at)}: ${r1(a)}-${r1(b)}`)
  }
  return [
    `ページ ${r1(p.width)}×${r1(p.height)}mm`,
    '文字（行ごと。各語は 語@x0,y0-x1,y1）',
    ...rows.map((r) => r.sort((a, b) => a.x0 - b.x0).map((w) => `${w.t}@${r1(w.x0)},${r1(w.y0)}-${r1(w.x1)},${r1(w.y1)}`).join(' ')),
    '横の罫線（y: x0-x1）',
    ...lines(p.hlines),
    '縦の罫線（x: y0-y1）',
    ...lines(p.vlines),
  ].join('\n')
}

const r2 = (v: number) => Math.round(v * 100) / 100
/** マス・□ の一覧（番号: x0,y0-x1,y1） */
export const listCells = (cs: Cell[]) => cs.map((c) => `${c.id}: ${c.x},${c.y}-${r2(c.x + c.w)},${r2(c.y + c.h)}`).join('\n')

/** 時間割の書き方の指示（#147）。時刻の文字が 3 つ以上あるページにだけ入れ、ほかの様式の指示は変えない */
const TIMETABLE = `  - 時間割のように、行が時刻の範囲を表す表（点線や罫線で時刻ごとに区切った行）は、マスの行ごとに 1 欄にし、範囲を「始め〜終わり」で書く（例: 月曜の列の 9:00〜10:00 の行は plan.weekly[day=月,start=09:00〜10:00].service）。
    範囲は、表の左などに印字された時刻の文字が、どの行の高さにあるか（文字の y とマスの y）で決める。上から順に数えて決めない。
    時刻の文字がない行は、上下の時刻の文字のある行から割り振る（印字が 2 時間おきで行が 1 時間ごとなら、1 時間ずつ）。
    表の行は、いちばん下の行まで残さずすべて欄にする。始めの時刻がその範囲に入る予定が、すべてその欄に入る。
`
const timetable = (p: Pick<LayoutPage, 'words'>) => p.words.filter((w) => /^\d{1,2}:\d{2}$/.test(w.t)).length >= 3

/** 1 回目の指示文。画像（1 枚目、何も書いていない様式）と一緒に渡す */
export function firstPrompt(input: { page: Pick<LayoutPage, 'width' | 'height' | 'words' | 'hlines' | 'vlines'>, cells: Cell[], boxes: Cell[], catalog: string[] }): string {
  const { page, cells, boxes } = input
  return `あなたは介護の書類の様式を、入力できるテンプレートに変換する担当です。
渡すのは、印刷用の様式の 1 ページ（画像と、PDF から取り出した文字と罫線の座標）と、値の key の一覧です。

このページで、手で記入する場所（記入欄）をすべて探し、1 欄ずつ答えてください。
- x, y, w, h: 欄の左上と幅・高さ（mm、ページの左上が原点）。座標は下の文字と罫線の数字を使って決める（画像から目で測らない）。
  欄は、印字の文字・□・罫線・ほかの欄のどれとも重ならない、空いた範囲だけにする。
  同じ枠の中に印字（□ のついた行など）があるときは、それを避けた残りにする。上下や左右に並ぶ欄どうしも重ねない。
- ui: text（1 行の文字）、area（複数行の文章）、check（□ に ✓ を付ける）、circle（印字の選択肢を丸で囲む）
  - □ のついた選択肢は □ ごとに 1 欄（ui: check）。下の「□ の一覧」の番号を box に入れる（位置はプログラムが □ に合わせる）。一覧の □ は、ほぼすべてが記入欄。
  - □ のない選択肢（「A・B」と並んだ文字）を丸で囲むものは、選択肢ごとに 1 欄（ui: circle）。x, y, w, h は丸で囲む文字の位置。
  - 「年 月 日」の日付は、年・月・日を別の欄にし、part に y・m・d を入れる。元号の選択肢を丸で囲むものは ui: circle、part: era、mark は値がその元号。
- ref: その欄に入れる値の key（下の一覧の書き方そのまま。[] は家族などの行）。
  - 行のうち特定の 1 行（一覧の「〜[].<印の名前>」が bool の印で選べる行）の欄は、[] の中にその印の名前を書く（例: people[isLeader].name）。何行目かが決まっているときは番号（[0]）でもよい。
${timetable(page) ? TIMETABLE : ''}  - 印字の言い回しが key の名前と違っても、意味が同じならその key にする。ただし、key にするのは欄に書く中身がその key の意味と同じときだけ。話題が近くても、問いや選択肢の意味が違うなら事業所だけの欄にする。
  - 一覧のどの key も合わないときは、事業所だけの欄として local.<英字の名前>（例: local.meetingPlace）を ref にし、localFields にその定義を書く。
    同じ値を書く欄（同じ問いの選択肢の丸、年・月・日に分けた日付など）は、同じ local の key を使う。
  - □ や丸の選択肢は、その選択肢の文字（またはその書き出し）を選択肢に持つ key を探して ref にする。
  - □ の右に（　）や単位が続いて値を書く形の選択肢は、その書く値の key を ref にする。
  - 選択肢の値そのものではない □（どれでもない・はい・いいえ・空・空でない を表すもの）も、関係する key を ref にし、何を表すかを mark で答える。
  - 「その他（　）」の（　）は、その他の内容を書く key にする。
  - 似た名前の key が複数あるときは、印字の言葉にいちばん近い方にする。「詳しく」の key は、詳しく書く欄だけに使う。
- mark: check・circle のとき、その印が付くのはどんなときか。kind は次のどれか。
  - eq: 値が value のとき（value は一覧の選択肢の書き方で。選択肢の書き出しだけでもよい）
  - none: 値が選択肢のどれでもないとき
  - true・false: はい・いいえの key が、はい・いいえのとき（例: 「要」→ true、「不要」→ false）
  - empty・nonEmpty: 値が空・空でないとき（例: 「記入なし」→ empty、「記入あり」→ nonEmpty）
- cell: 下の「表のマス」のどれか 1 つ全体が欄のとき（マスの中に印字がなく、マスいっぱいに書く欄）、そのマスの番号。
  このとき x, y, w, h はそのマスの位置を写せばよい（プログラムがマスの内側に置き直す）。表のマスの一部だけが欄のとき、マスの外の欄のときは書かない。
  表のマスは、行と列の見出し（表の上の行・左の列の印字）を見て、どのマスが記入欄で何を書くかを決める。
- label: 欄のそばに印字されている文字（人がどの欄か分かるように。短く）。
- confidence: 位置と key の両方に自信があるほど 1 に近く（0〜1）。

localFields: このページで使った local の key の定義。key、label（欄の名前。問いの文なら問いそのもの）、type（text・longtext・date・number・enum・bool）、
choices（enum のときの選択肢。印字の書き方で）、note（名前だけでは意味が分からないときの短い説明。なくてよい）。
${pageText(page)}

□ の一覧（PDF から見つけた □。番号: x0,y0-x1,y1）:
${boxes.length ? listCells(boxes) : '（なし）'}

表のマス（罫線で四方を囲まれた四角。番号: x0,y0-x1,y1）:
${listCells(cells)}

値の key の一覧（key｜名前｜型｜選択肢）:
${input.catalog.join('\n')}
`
}

/** 見直しに渡す欄の一覧の 1 行（番号: label｜ui｜ref｜印が表すもの｜日付の部分） */
export const describeSlot = (x: DraftSlot, i: number) =>
  `${i + 1}: ${x.label}｜${x.ui}｜${x.ref}${x.mark ? `｜${x.mark.kind}${'value' in x.mark ? `=${x.mark.value}` : ''}` : ''}${x.part ? `｜${x.part}` : ''}`

/** 見直しの指示文。1 回目と同じ入力の後ろに、2 枚目の画像（欄を枠と番号で重ねたもの）と一緒に足す */
export function reviewPrompt(slots: DraftSlot[], unused: Cell[]): string {
  return `上の 2 枚目の画像は、ここまでの答えの欄を、同じページに赤い枠と番号で重ねたものです。番号ごとの中身（番号: label｜ui｜ref｜印が表すもの｜日付の部分）:
${slots.map(describeSlot).join('\n')}

1 枚目（何も書いていない様式）と 2 枚目を見比べて、次を答えてください。
- slots: 赤い枠がない記入欄（漏れ）。表の後半や下の方、細かいマス、□ の漏れに気をつける。
- fixes: 番号の欄のうち、位置・ui・ref・mark・part が間違っているもの。id に番号、slot に直した欄全体。
  とくに表では、その枠がある列と行の見出しの文字と、ref・label が合っているかを確かめる。
- removes: 記入欄でない場所に置いた欄の番号。
- localFields: 新しく使う local の key の定義だけ（すでにある key は書かない）。
${unused.length ? `\nプログラムが見つけた □ のうち、どの欄にも使われていないもの（番号: 位置）。記入欄なら slots に足す（box に番号）。記入欄でなければ何もしない:\n${listCells(unused)}\n` : ''}
直すところがなければ、すべて空の配列にしてください。`
}

export const FIRST_SCHEMA = {
  type: 'object',
  properties: {
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
          ui: { type: 'string', enum: ['text', 'area', 'check', 'circle'] },
          ref: { type: 'string' },
          mark: { type: 'object', properties: { kind: { type: 'string', enum: ['eq', 'none', 'true', 'false', 'empty', 'nonEmpty'] }, value: { type: 'string' } }, required: ['kind'] },
          part: { type: 'string', enum: ['y', 'm', 'd', 'era'] },
          cell: { type: 'integer' },
          box: { type: 'integer' },
          label: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['x', 'y', 'w', 'h', 'ui', 'ref', 'label', 'confidence'],
      },
    },
    localFields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' }, label: { type: 'string' },
          type: { type: 'string', enum: ['text', 'longtext', 'date', 'number', 'enum', 'bool'] },
          choices: { type: 'array', items: { type: 'string' } }, note: { type: 'string' },
        },
        required: ['key', 'label', 'type'],
      },
    },
  },
  required: ['slots', 'localFields'],
}

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    slots: FIRST_SCHEMA.properties.slots,
    fixes: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, slot: FIRST_SCHEMA.properties.slots.items }, required: ['id', 'slot'] } },
    removes: { type: 'array', items: { type: 'integer' } },
    localFields: FIRST_SCHEMA.properties.localFields,
  },
  required: ['slots', 'fixes', 'removes', 'localFields'],
}
