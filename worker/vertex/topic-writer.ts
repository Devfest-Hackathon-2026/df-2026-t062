// 録音からの書き込み（作り替え）の 4〜7。docs/再設計/17_録音からの書き込み.md の「書く欄を選ぶ」「書く・全体のまとめ」「最後のチェック」。
//   4. 欄を選ぶ: 様式のページごとに、AI が要約を見て、書く欄と、その欄を書くときに読む項目（1 つ以上）を選ぶ。候補のないページは呼ばない
//   5. 書く: 項目ごとに 1 回。選んだ欄は、最初に挙げた項目のところで書く。挙げた項目の要約は全部渡す
//   6. 全体のまとめ: 最後に書く項目の欄を、全部の要約と 5 で書いた値から書く
//   7. 最後のチェック: 項目ごとに 1 回。書いた値を文・選択肢の単位に分け、不要な部分と要約に根拠のない部分を切る。項目の説明は渡さない
// 値の根拠は、もとにした要約の行（recording_summaries.id）。1 つの呼び出しが失敗しても全体は止めず、failed に入れる。ログに中身は出さない。
import { slotPages, type FormDef } from '../../core/form.ts'
import { summaryTopics, type Topic } from '../../core/topics.ts'
import type { ProposedValue, SummaryLine, TopicWriter, WriterResult } from '../types.ts'
import {
  atoms, candidateFields, dropAtoms, fieldSchema, fmtField, fmtValue, needsDocument, settle, validateValue, warmThenMap, mapLimit, type Spec,
} from './common.ts'
import type { Llm } from './gemini.ts'
import { fmtTopics } from './summarizer.ts'
import * as P from './topic-prompts.ts'

/** 答えの形（JSON Schema）の中の項目（properties）の数の上限。Gemini は 157 を超えると 400 で断る（2026-11 に 2 層改で確かめた）。超える分は呼び出しを分ける */
const MAX_PROPS = 150

const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)

/** 要約の行の、指示文の中での id（項目の id-何本目） */
const refOf = (s: SummaryLine) => `${s.topic}-${s.seq}`

/** 要約を項目ごとに並べる。mark: 今回足した分に印を付ける（足していく種類の 2 回目から、欄を選ぶときだけ） */
export function fmtSummaries(lines: readonly SummaryLine[], topics: readonly Topic[], mark: boolean): string {
  const out: string[] = []
  for (const t of topics) {
    const ls = lines.filter((s) => s.topic === t.id).sort((a, b) => a.seq - b.seq)
    if (!ls.length) continue
    out.push(`## ${t.name}（${t.id}）`)
    for (const s of ls) out.push(`- [${refOf(s)}] ${s.seq} 回目（${s.date}${mark && s.isNew ? '・今回' : ''}）: ${s.text.replace(/\s*\n\s*/g, ' ')}`)
  }
  return out.join('\n') || '（なし）'
}

export interface Page { no: number, title: string, specs: Spec[] }

/**
 * 版のページごとの、録音から書ける欄（候補）。版が読む書いてよい欄のうち、出どころが書類だけの欄は除く（録音は会話だけ）。
 * 欄の用紙での場所は、版のページと印字欄。並びは候補の順（fields.json の順、そのあとにその様式だけの欄）
 */
export function pagesOf(form: FormDef): Page[] {
  const specs = candidateFields(form).filter((s) => !needsDocument(s))
  const known = new Set(specs.map((s) => s.key))
  const pageOfSlot = slotPages(form)
  const placed = new Map<number, Map<string, string[]>>()
  for (const [slot, b] of Object.entries(form.bindings)) {
    const key = b.ref.key
    if (!known.has(key)) continue
    const no = pageOfSlot.get(slot) ?? 0
    const m = placed.get(no) ?? new Map<string, string[]>()
    placed.set(no, m)
    m.set(key, [...(m.get(key) ?? []), slot])
  }
  const titles = new Map(form.pages.map((p) => [p.no, p.title]))
  return [...placed.keys()].sort((a, b) => (a || Infinity) - (b || Infinity)).map((no) => {
    const m = placed.get(no)!
    const title = no ? `p.${no} ${titles.get(no) ?? ''}`.trim() : 'ページのない欄'
    const pageSpecs = specs.filter((s) => m.has(s.key)).map((s) => {
      const slots = m.get(s.key)!
      return { ...s, where: `${title}（印字欄「${slots[0]}」${slots.length > 1 ? 'ほか' : ''}）` }
    })
    return { no, title, specs: pageSpecs }
  })
}

/** JSON Schema の中の項目（properties）の数（入れ子も数える） */
function countProps(x: unknown): number {
  if (Array.isArray(x)) return x.reduce((n: number, y) => n + countProps(y), 0)
  if (!isRecord(x)) return 0
  let n = 0
  for (const [k, v] of Object.entries(x)) {
    if (k === 'properties' && isRecord(v)) n += Object.keys(v).length
    n += countProps(v)
  }
  return n
}

/** 答えの形が大きくなりすぎないように、欄を分ける */
function chunks(specs: Spec[]): Spec[][] {
  const out: Spec[][] = []
  let cur: Spec[] = []
  let n = 0
  for (const s of specs) {
    const k = countProps(fieldSchema([s]))
    if (cur.length && n + k > MAX_PROPS) { out.push(cur); cur = []; n = 0 }
    cur.push(s)
    n += k
  }
  if (cur.length) out.push(cur)
  return out
}

/** 選んだ欄と、その欄を書くときに読む項目（順に。最初の項目のところで書く） */
interface Choice { spec: Spec, topics: string[] }
/** 書いた値と、もとにした要約の行の id */
interface Written { spec: Spec, value: unknown, ids: string[] }
/** 書く単位（項目 1 つ。答えの形が大きいときは分ける）。チェックは項目ごとに 1 回 */
interface Unit { topic: string, part: number, specs: Spec[], read: string[], lines: SummaryLine[] }

export interface TopicWriterOptions {
  /** Gemini を同時に呼ぶ数（既定 4。環境変数 GEMINI_CONCURRENCY） */
  concurrency?: number
}

export function topicWriter(newLlm: () => Llm, opts: TopicWriterOptions = {}): TopicWriter {
  const limit = Math.max(1, opts.concurrency ?? 4)
  return {
    async write(input): Promise<WriterResult> {
      const llm = newLlm()
      const stats: Record<string, number> = {}
      const bump = (k: string, n = 1) => { stats[k] = (stats[k] ?? 0) + n }
      const failed: string[] = []
      const incomplete = new Set<string>()
      const values: Record<string, ProposedValue> = {}

      const ai = summaryTopics(input.topics)
      const topicById = new Map(ai.map((t) => [t.id, t]))
      const order = new Map(ai.map((t, i) => [t.id, i]))
      const lines = input.summaries.filter((s) => topicById.has(s.topic))
        .sort((a, b) => order.get(a.topic)! - order.get(b.topic)! || a.seq - b.seq)
      const withSummary = new Set(lines.map((s) => s.topic))
      const lastIds = new Set(ai.filter((t) => t.last).map((t) => t.id))
      const head = (subset: SummaryLine[], mark: boolean) => P.fill(P.HEAD, { kind: input.kindName, summaries: fmtSummaries(subset, ai, mark) })

      if (lines.length) {
        // ---------- 4. 欄を選ぶ（ページごと。同じ前置きなので、最初の 1 回を済ませてから残りを並べる） ----------
        const pages = pagesOf(input.form).filter((p) => p.specs.length)
        const selectHead = head(lines, input.showNew)
        const select = (p: Page) => {
          const fields = p.specs.map((s) => (input.showNew ? `${fmtField(s)}\n- 今の値: ${fmtValue(input.current[s.key])}` : fmtField(s))).join('\n\n')
          const prompt = selectHead + P.fill(P.SELECT, { page: p.title, later: input.showNew ? P.SELECT_LATER : '', topics: fmtTopics(ai), fields })
          const schema = {
            type: 'object',
            properties: {
              fields: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { key: { type: 'string', enum: p.specs.map((s) => s.key) }, topics: { type: 'array', items: { type: 'string', enum: ai.map((t) => t.id) } } },
                  required: ['key', 'topics'],
                },
              },
            },
            required: ['fields'],
          }
          return llm.ask(prompt, schema, { step: '欄を選ぶ', group: p.no })
        }
        const selected = await warmThenMap(pages, limit, async (p) => [p, await settle(select(p))] as const)
        const chosen = new Map<string, Choice>()
        for (const [p, r] of selected) {
          if (!r.ok) { failed.push(`select:${p.no}`); for (const s of p.specs) incomplete.add(s.key); continue }
          const byKey = new Map(p.specs.map((s) => [s.key, s]))
          for (const f of isRecord(r.value) && Array.isArray(r.value.fields) ? r.value.fields : []) {
            if (!isRecord(f) || typeof f.key !== 'string') continue
            const spec = byKey.get(f.key)
            if (!spec) { bump('候補にない欄'); continue }
            // 読む項目は、要約のある項目だけ（最後に書く項目は、全部の要約を読むのでよい）
            const ts = (Array.isArray(f.topics) ? f.topics : []).filter((t): t is string => typeof t === 'string' && topicById.has(t) && (withSummary.has(t) || lastIds.has(t)))
            if (!ts.length) { bump('読む要約がない欄'); continue }
            const prev = chosen.get(spec.key)
            chosen.set(spec.key, { spec: prev?.spec ?? spec, topics: [...new Set([...(prev?.topics ?? []), ...ts])] })
          }
        }

        // ---------- 5. 項目ごとに書く（最後に書く項目の欄は 6 で） ----------
        const byTopic = new Map<string, Choice[]>()
        for (const c of chosen.values()) byTopic.set(c.topics[0], [...(byTopic.get(c.topics[0]) ?? []), c])
        const topicsInOrder = [...byTopic.keys()].sort((a, b) => order.get(a)! - order.get(b)!)
        const units: Unit[] = []
        for (const t of topicsInOrder.filter((x) => !lastIds.has(x))) {
          const cs = byTopic.get(t)!
          const read = [...new Set(cs.flatMap((c) => c.topics))].filter((x) => withSummary.has(x))
          const ls = lines.filter((s) => read.includes(s.topic))
          chunks(cs.map((c) => c.spec)).forEach((specs, part) => units.push({ topic: t, part, specs, read, lines: ls }))
        }

        /** 答えから欄の値を取り出す。根拠は、答えが挙げた要約の行（知らない行は捨てる）。挙げていなければ、読んだ項目の行 */
        const take = (u: Unit, r: unknown): Written[] => {
          const refs = new Map(u.lines.map((s) => [refOf(s), s.id]))
          const out: Written[] = []
          for (const s of u.specs) {
            const rec = isRecord(r) && isRecord(r[s.key]) ? r[s.key] as Record<string, unknown> : {}
            const [v, problems] = validateValue(s, rec.value)
            if (problems.length) { bump('値の問題'); incomplete.add(s.key) }
            if (v === null) continue
            const from = (Array.isArray(rec.from) ? rec.from : []).filter((x): x is string => typeof x === 'string').map((x) => refs.get(x.trim().replace(/^\[|\]$/g, '')))
            let ids = [...new Set(from.filter((x): x is string => !!x))]
            if (!ids.length) {
              bump('根拠のない値')
              const read = new Set(chosen.get(s.key)?.topics ?? [])
              ids = u.lines.filter((l) => read.has(l.topic)).map((l) => l.id)
            }
            out.push({ spec: s, value: v, ids })
          }
          return out
        }

        const writeUnit = (u: Unit) => {
          const names = u.read.map((id) => topicById.get(id)!.name).join('・')
          const prompt = head(u.lines, false) + P.fill(P.WRITE, { topics: names, fields: u.specs.map(fmtField).join('\n\n') })
          return llm.ask(prompt, fieldSchema(u.specs), { step: '書く', group: u.part ? `${u.topic}:${u.part + 1}` : u.topic })
        }
        const written = new Map<string, { lines: SummaryLine[], items: Written[] }>()
        const failedTopics = new Set<string>()
        for (const [u, r] of await warmThenMap(units, limit, async (u) => [u, await settle(writeUnit(u))] as const)) {
          if (!r.ok) {
            if (!failedTopics.has(u.topic)) failed.push(`write:${u.topic}`)
            failedTopics.add(u.topic)
            for (const s of u.specs) incomplete.add(s.key)
            continue
          }
          const g = written.get(u.topic) ?? { lines: u.lines, items: [] }
          g.items.push(...take(u, r.value))
          written.set(u.topic, g)
        }

        // ---------- 7. 最後のチェック（項目ごと。書いたときと同じ要約を渡す。項目の説明は渡さない） ----------
        const check = async (topic: string, g: { lines: SummaryLine[], items: Written[] }) => {
          const blocks: string[] = []
          const ids: string[] = []
          const where = new Map<string, [Written, string]>()
          for (const w of g.items) {
            const ats = atoms(w.spec, w.value)
            if (!ats.length) continue
            blocks.push(`${fmtField(w.spec)}\n- 書いた値:\n${ats.map((a) => `  - [${w.spec.key}${a.path}] ${a.label}: ${a.text}`).join('\n')}`)
            for (const a of ats) { ids.push(w.spec.key + a.path); where.set(w.spec.key + a.path, [w, a.path]) }
          }
          if (!ids.length) return
          const schema = {
            type: 'object',
            properties: {
              cuts: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { id: { type: 'string', enum: ids }, reason: { type: 'string', enum: ['no_source', 'unneeded'] }, why: { type: 'string' } },
                  required: ['id', 'reason'],
                },
              },
            },
            required: ['cuts'],
          }
          const r = await settle(llm.ask(head(g.lines, false) + P.fill(P.CHECK, { materials: blocks.join('\n\n') }), schema, { step: '最後のチェック', group: topic }))
          // チェックできなかった欄は、確かめられないので入れない
          if (!r.ok) { failed.push(`check:${topic}`); for (const w of g.items) incomplete.add(w.spec.key); return }
          const drop = new Map<Written, Set<string>>()
          for (const c of isRecord(r.value) && Array.isArray(r.value.cuts) ? r.value.cuts : []) {
            if (!isRecord(c) || typeof c.id !== 'string' || !where.has(c.id)) continue
            const [w, path] = where.get(c.id)!
            drop.set(w, (drop.get(w) ?? new Set()).add(path))
            bump(`切った:${String(c.reason)}`)
          }
          for (const w of g.items) {
            const v = dropAtoms(w.spec, w.value, drop.get(w) ?? new Set())
            // 全部切られた欄は書かない（AI は欄を空にしない。前の値は applyBatch で残る）
            if (v === null) { bump('全部切った欄'); continue }
            values[w.spec.key] = { value: v, cite: { kind: 'summary', ids: w.ids } }
          }
        }

        // ---------- 6. 全体のまとめ（5 で書いた値と、全部の要約を読む）。5 のチェックと並べて呼ぶ ----------
        const sheet = () => {
          const out = [...written.values()].flatMap((g) => g.items).map((w) => `- ${w.spec.label}（${w.spec.key}）: ${fmtValue(w.value)}`)
          return out.join('\n') || '（まだ何も書いていない）'
        }
        const finalTopics = topicsInOrder.filter((x) => lastIds.has(x))
        const finals = async () => {
          const out = new Map<string, { lines: SummaryLine[], items: Written[] }>()
          for (const t of finalTopics) {
            const specs = byTopic.get(t)!.map((c) => c.spec)
            for (const [part, cs] of chunks(specs).entries()) {
              const u: Unit = { topic: t, part, specs: cs, read: ai.map((x) => x.id), lines }
              const prompt = head(lines, false) + P.fill(P.FINAL, { topic: topicById.get(t)!.name, fields: cs.map(fmtField).join('\n\n'), sheet: sheet() })
              const r = await settle(llm.ask(prompt, fieldSchema(cs), { step: '全体のまとめ', group: part ? `${t}:${part + 1}` : t }))
              if (!r.ok) {
                if (!failed.includes(`final:${t}`)) failed.push(`final:${t}`)
                for (const s of cs) incomplete.add(s.key)
                continue
              }
              const g = out.get(t) ?? { lines, items: [] }
              g.items.push(...take(u, r.value))
              out.set(t, g)
            }
          }
          return out
        }
        const [finalWritten] = await Promise.all([finals(), mapLimit([...written], limit, ([t, g]) => check(t, g))])
        await mapLimit([...finalWritten], limit, ([t, g]) => check(t, g))
      }

      const usage = llm.usage()
      console.log(JSON.stringify({ severity: 'INFO', msg: 'topic writer done', showNew: input.showNew, summaries: lines.length, values: Object.keys(values).length, failed, stats, calls: usage.calls, promptTokens: usage.promptTokens, cachedTokens: usage.cachedTokens, thinkingTokens: usage.thinkingTokens, yen: usage.yen }))
      return { values, usage, failed, incompleteFields: [...incomplete] }
    },
  }
}
