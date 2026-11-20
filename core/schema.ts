// 版の欄の辞書（fields.json と、その版の local_fields）から作る値の型の確かめ（zod）。AI が書いた値と、画面からの直しの両方に使う。
import { z } from 'zod'
import { GLOBAL_DICT, type FieldDict } from './dictionary.ts'
import { choicesOf, subFieldsOf, type FieldSpec } from './fields.ts'

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** ケアマネの直しでは、年だけ・年月だけの日付も持てる（手帳の交付日など、用紙に年月しかない欄もある） */
const PARTIAL_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/

/** 暦にある日付か（2021-02-30 は通さない） */
function onCalendar(v: string): boolean {
  const [y, m, d] = v.split('-').map(Number)
  if (m !== undefined && (m < 1 || m > 12)) return false
  if (d !== undefined) {
    const dt = new Date(Date.UTC(y, m - 1, d))
    if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false
  }
  return true
}

export interface SchemaOptions {
  /** true なら日付は年月日そろったものだけ（AI が書く値） */
  strictDates?: boolean
}

function scalar(f: FieldSpec, o: SchemaOptions = {}): z.ZodType {
  switch (f.type) {
    case 'enum': {
      const c = choicesOf(f)
      return c.length ? z.enum(c as [string, ...string[]]) : z.string()
    }
    case 'multi': {
      const c = choicesOf(f)
      return z.array(c.length ? z.enum(c as [string, ...string[]]) : z.string())
    }
    case 'bool': return z.boolean()
    case 'number': return z.number()
    case 'date': return z.string().regex(o.strictDates ? DATE : PARTIAL_DATE).refine(onCalendar, '暦にない日付です')
    case 'text': case 'longtext': return z.string()
    case 'object': return z.object(Object.fromEntries(subFieldsOf(f).map((s) => [s.key, scalar(s, o).nullish()]))).strict()
    case 'list': return z.array(z.object(Object.fromEntries(subFieldsOf(f).map((s) => [s.key, scalar(s, o).nullish()]))).strict())
    default: return z.never()
  }
}

/** 欄の定義ごとに覚える（fields.json の欄はいつも同じもの、その様式だけの欄は版の辞書ごとのもの） */
const cache = new WeakMap<FieldSpec, { S?: z.ZodType, L?: z.ZodType }>()

/** key の値の型。辞書（既定は fields.json だけ）にない key は undefined */
export function valueSchema(key: string, o: SchemaOptions = {}, dict: FieldDict = GLOBAL_DICT): z.ZodType | undefined {
  const f = dict.get(key)
  if (!f) return undefined
  const c = cache.get(f) ?? {}
  const mode = o.strictDates ? 'S' : 'L'
  if (!c[mode]) { c[mode] = scalar(f, o); cache.set(f, c) }
  return c[mode]
}

/** 値が型どおりか。null は「消す」なので通す。AI が書いた値は strictDates で確かめる。その様式だけの欄は、版の辞書を渡す */
export function validValue(key: string, value: unknown, o: SchemaOptions = {}, dict: FieldDict = GLOBAL_DICT): boolean {
  if (value === null) return true
  const s = valueSchema(key, o, dict)
  return !!s && s.safeParse(value).success
}
