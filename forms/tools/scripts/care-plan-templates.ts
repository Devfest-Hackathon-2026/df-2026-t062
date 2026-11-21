// 厚労省 令和6年7月4日 老認発0704第1号 p.17〜19 の実寸座標（mm）。
// JSON の再生成: node forms/tools/scripts/care-plan-templates.ts
// 元PDF・ページ画像・利用者の値は生成物に入れない。
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Binding, Bindings, Ref } from '../../../core/binding.ts'
import type { FormPage, TemplateSlot } from '../../../core/form.ts'

const hashes = [
  'f0cc91d794c717e9fe7816d48bf41304b0cdec1a34bf006d9dda36bf55bb9aba',
  'd8be84d34e0bc64f0f7a884475bf8d72312f23e7d1c5addd720593162ec36837',
  '11bc66ef9c39e6d412f0ee5ae0f35b26659a86817c7e7bc908d59195e1cb8940',
]

for (const no of [1, 2, 3]) {
  const kind = `care_plan_${no}`
  const schemas: TemplateSlot[] = []
  const bindings: Bindings = {}
  const add = (name: string, x: number, y: number, width: number, height: number, binding: Binding, fontSize = 8) => {
    schemas.push({
      name, type: binding.ui === 'circle' ? 'circleMark' : 'text', position: { x, y }, width, height,
      fontSize, lineHeight: 1.15, alignment: 'left', verticalAlignment: 'top',
      fontName: 'BIZUDPGothic',
      ...(binding.ui === 'circle' ? { color: '#1a3fa0', borderWidth: 0.3 } : {}),
      ...(binding.ui === 'circle' ? {} : { dynamicFontSize: { min: 6, max: fontSize, fit: 'both' } }),
    })
    bindings[name] = binding
  }
  const text = (name: string, key: string, x: number, y: number, w: number, h: number, path?: Ref['path']) =>
    add(name, x, y, w, h, { op: 'text@1', ui: h > 8 ? 'area' : 'text', ref: { key, ...(path ? { path } : {}) } })
  const date = (name: string, key: string, y: number, xs: number[], widths: number[] = [13, 9, 9]) => {
    for (const [i, part] of (['y', 'm', 'd'] as const).entries()) {
      add(`${name}_${part}`, xs[i], y, widths[i], 4.5, { op: 'date@1', ui: 'text', ref: { key }, part, year: 'short' })
    }
  }
  const circle = (name: string, key: string, value: string | string[], x: number, y: number, w: number) =>
    add(name, x, y, w, 5, {
      op: 'option@1', ui: 'circle', ref: { key }, is: Array.isArray(value) ? { in: value } : { eq: value },
      ...(Array.isArray(value) ? { edit: { on: { set: [{ value: value[0] }] }, off: { set: [{ value: null }] } } } : {}),
    })
  let print: FormPage['print']
  if (no === 1) {
    print = { type: 'text' }
    text('利用者名', 'person.name', 21, 37.7, 42, 5)
    text('住所', 'person.address', 151, 37.7, 97, 5)
    text('作成者', 'office.careManagerName', 55, 44, 67, 5)
    text('事業所名', 'office.name', 77, 50.4, 79, 5)
    text('事業所所在地', 'office.address', 158, 50.4, 90, 5)
    date('作成年月日', 'plan.createdDate', 15.7, [221, 241, 257])
    date('生年月日', 'person.birthDate', 37.7, [101, 113, 124], [8, 6, 6])
    date('変更日', 'plan.changedDate', 56.8, [83, 102, 113])
    date('初回作成日', 'plan.firstCreatedDate', 56.8, [195, 217, 228])
    date('認定日', 'cert.certifiedDate', 63.1, [23, 43, 54])
    date('有効期間開始', 'cert.validFrom', 63.1, [101, 113, 124], [8, 6, 6])
    date('有効期間終了', 'cert.validTo', 63.1, [142, 154, 165], [8, 6, 6])
    for (const [i, value] of ['初回', '紹介', '継続'].entries()) circle(`種別_${value}`, 'plan.kind', value, 194.5 + 15.3 * i, 24.1, 9)
    circle('認定済', 'cert.status', '認定済', 250, 24.1, 12)
    circle('申請中', 'cert.status', ['新規申請中', '区分変更申請中', '更新申請中'], 269, 24.1, 13)
    for (let i = 1; i <= 5; i++) circle(`要介護${i}`, 'cert.careLevel', `要介護${i}`, 50.8 + (i - 1) * 27.2, 71.8, 17)
    // 意向と分析を独立した欄で出し、同じ値の別書類への自動同期はしない。
    text('本人意向', 'intention.person', 44, 83, 241, 6)
    text('家族意向', 'intention.family', 44, 90, 241, 6)
    text('意向を踏まえた課題分析', 'plan.intentionAnalysis', 44, 97, 241, 12)
    text('審査会意見', 'cert.reviewBoardOpinion', 44, 115, 241, 22)
    text('総合的援助方針', 'plan.overallPolicy', 44, 145, 241, 35)
    for (const [name, value, x, width] of [
      ['一人暮らし', '一人暮らし', 51, 27], ['家族障害疾病', '家族等が障害、疾病等', 84, 46], ['その他', 'その他', 136, 23],
    ] as const) {
      add(`生活援助_${name}`, x, 192, width, 5, {
        op: 'option@1', ui: 'circle', ref: { key: 'plan.livingAssistanceReason', path: ['reason'] }, is: { eq: value },
      })
    }
    text('生活援助_その他理由', 'plan.livingAssistanceReason', 159, 192, 83, 6, ['other'])
  } else if (no === 2) {
    text('利用者名', 'person.name', 29, 30.8, 40, 5)
    date('作成年月日', 'plan.createdDate', 23.3, [231, 247, 262], [10, 8, 8])
    const rowSlots: string[] = []
    const col = (name: string, path: Ref['path'], x: number, w: number) => {
      rowSlots.push(name)
      text(name, 'plan.needs', x, 54, w, 24, path)
    }
    col('ニーズ', [0, 'need'], 20.5, 26)
    col('長期目標', [0, 'longGoal'], 48.5, 24)
    col('長期期間', [0, 'longGoalPeriod'], 76, 12.5)
    col('短期目標', [0, 'shortGoals', 0, 'goal'], 92, 24)
    col('短期期間', [0, 'shortGoals', 0, 'period'], 119, 13)
    col('サービス内容', [0, 'shortGoals', 0, 'services', 0, 'content'], 133.5, 41)
    rowSlots.push('保険給付')
    add('保険給付', 177, 54, 5, 24, {
      op: 'symbol@1', ui: 'text', ref: { key: 'plan.needs', path: [0, 'shortGoals', 0, 'services', 0, 'insured'] },
      options: [{ value: true, text: '○' }, { value: false, text: '' }],
    })
    col('サービス種別', [0, 'shortGoals', 0, 'services', 0, 'kind'], 186, 32)
    col('提供事業所', [0, 'shortGoals', 0, 'services', 0, 'provider'], 222, 16)
    col('頻度', [0, 'shortGoals', 0, 'services', 0, 'frequency'], 242, 16)
    col('サービス期間', [0, 'shortGoals', 0, 'services', 0, 'period'], 262, 15)
    print = { type: 'table', key: 'plan.needs', nested: ['shortGoals', 'services'], slots: rowSlots, rowsPerPage: 5, rowHeight: 25.4 }
  } else {
    text('利用者名', 'person.name', 29, 25.4, 29, 5)
    date('作成年月日', 'plan.createdDate', 15.2, [234, 250, 265], [10, 8, 8])
    text('週間枠', 'plan.weekly', 47.2, 39.5, 184.9, 114.6)
    add('日常生活活動', 234, 40, 45, 112, {
      op: 'join@1', ui: 'area', ref: { key: 'dailySchedule' }, where: { rhythm: { nonEmpty: true } },
      show: 'rhythm', label: { of: 'time', map: Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), `${h}:00`])) }, sep: '\n',
    })
    text('週単位以外', 'plan.nonWeeklyServices', 49, 165, 229, 11)
    print = {
      type: 'timeline', key: 'plan.weekly', slot: '週間枠', days: ['月', '火', '水', '木', '金', '土', '日'],
      dayField: 'day', startField: 'start', endField: 'end', labelField: 'service',
      activity: { key: 'dailySchedule', slot: '日常生活活動', timeField: 'time', labelField: 'rhythm' },
    }
  }
  const name = no === 3 ? '週間サービス計画表' : `居宅サービス計画書（${no}）`
  const dir = new URL(`../../seed/${kind}/`, import.meta.url)
  mkdirSync(dir, { recursive: true })
  const json = (file: string, data: unknown) => writeFileSync(new URL(file, dir), `${JSON.stringify(data, null, 2)}\n`)
  json('form.json', {
    kind, name, title: `${name}（厚生労働省 令和6年7月4日）`, publisher: '厚生労働省',
    sourceUrl: 'https://www.mhlw.go.jp/content/001271371.pdf',
    sourcePdfSha256: 'b525d876cc7b4c7252d243b6e3bfaf32c1508cb2dc8f7763686841967af4e5c9',
    sourcePages: [16 + no], basePdfSha256: hashes[no - 1],
    pages: [{ no: 1, pdfIndex: 0, title: name, width: 297, height: 210, ...(print ? { print } : {}) }],
  })
  json('template.json', { basePdf: 'base.pdf', schemas: [schemas] })
  json('bindings.json', bindings)
}
