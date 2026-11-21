// 様式の版を出す前の確かめ（forms/seed/ のファイル）。全部の様式を調べる。
//   npm run forms:check
// 1. 欄の位置（template.json）の印字欄と、対応（bindings.json）が 1 対 1。対応の key・項目が fields.json にあり、丸・✓ の直しが決まっている
// 2. 対応が読む key と、fields.json で「この様式に入る」と書いた欄（forms）が一致する（図は人が描くので除く）。
//    fields.json の forms は全体の 2 様式（アセスメント・入院時情報提供書）の確かめと人が読む説明にだけ使うので、forms に書いていない種類は比べない
//    （AI が書く欄と用紙での場所は、様式の版から決める。docs/再設計/16 の「欄の辞書（版ごと）」）
// 3. 見本データで、全部の印字欄が文字になる。見本データの key が fields.json にある
import { readFileSync } from 'node:fs'
import { formKeys, renderAll } from '../../core/binding.ts'
import { FIELD_LIST } from '../../core/fields.ts'
import { checkVersion } from '../../db/forms.ts'
import { readSeed, seedKinds } from './files.ts'

const FIELDS_FORM: Record<string, string> = { assessment: 'assess', admission: 'adm', care_plan_1: 'cp1', care_plan_2: 'cp2', care_plan_3: 'cp3' }
const defined = new Map(FIELD_LIST.map((f) => [f.key, f]))
const sample = JSON.parse(readFileSync(new URL('../samples/見本_花子.json', import.meta.url), 'utf8')) as Record<string, unknown>
let failed = false

for (const kind of seedKinds()) {
  const v = readSeed(kind)
  const problems = checkVersion(v)
  const keys = formKeys(v.bindings)
  const fk = FIELDS_FORM[kind]
  if (fk) {
    const listed = new Set(FIELD_LIST.filter((f) => f.forms?.[fk] && f.type !== 'image').map((f) => f.key))
    for (const k of keys) if (!listed.has(k)) problems.push(`対応が読むのに、fields.json の forms.${fk} にない: ${k}`)
    for (const k of listed) if (!keys.includes(k)) problems.push(`fields.json の forms.${fk} にあるのに、対応が読まない: ${k}（${defined.get(k)?.label}）`)
  }
  for (const [k, out] of Object.entries(renderAll(v.bindings, sample))) if (typeof out !== 'string') problems.push(`欄 ${k} の値が文字列でない: ${JSON.stringify(out)}`)
  console.log(`[${kind}] ${v.name}: 印字欄 ${v.schemas.flat().length} 個、読む key ${keys.length} 個、ページ ${v.pages.length}`)
  for (const p of problems) console.log(`  問題: ${p}`)
  if (problems.length) failed = true
}

for (const k of Object.keys(sample)) if (!k.startsWith('_') && !defined.has(k)) {
  console.log(`  問題: 見本データの key が fields.json にない: ${k}`)
  failed = true
}

if (failed) process.exit(1)
console.log('OK: 食い違いはありません')
