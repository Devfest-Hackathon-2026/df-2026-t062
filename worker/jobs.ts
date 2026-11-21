// 録音 1 本の処理（決まった流れ）: 文字にする → 話した人 → 欄の値（要約から書く。docs/再設計/17_録音からの書き込み.md）→ 型の確かめ → applyBatch。
// 段ごとに結果を jobs.steps に残し、やり直しでは済んだ段を飛ばす（STT と Gemini の費用を 2 回払わない）。
// ログには中身（話・値）を出さない。出すのは、ジョブの id・段・時間・エラーの種類・使った量だけ。
import { randomUUID } from 'node:crypto'
import { fieldDict } from '../core/dictionary.ts'
import type { FormDef } from '../core/form.ts'
import { summaryTopics, topicsFingerprint, topicsFor, type OfficeTopics, type Topic } from '../core/topics.ts'
import { loadFormDef } from '../db/forms.ts'
import type { Db } from '../db/pool.ts'
import { applyBatch } from '../db/repo.ts'
import { incompleteFieldKeys, prepareWriterValues } from './job-values.ts'
import type { Storage } from '../api/storage.ts'
import type { Person, ProposedValue, Providers, SummaryLine, Usage, Utterance } from './types.ts'

export interface WorkerDeps {
  db: () => Promise<Db>
  storage: () => Storage
  providers: () => Promise<Providers>
}

const log = (rec: Record<string, unknown>) => console.log(JSON.stringify({ severity: 'INFO', ...rec }))

const MAX_ATTEMPTS = 3
class LeaseLost extends Error { constructor() { super('job lease lost') } }

async function setStep(db: Db, jobId: string, token: string, step: string, patch: Record<string, unknown> = {}) {
  const r = await db.query(
    "UPDATE jobs SET step = $3, steps = steps || $4::jsonb, updated_at = now(), lease_until = now() + interval '30 minutes' WHERE id = $1 AND run_token = $2 AND status = 'processing' AND lease_until > now() RETURNING id",
    [jobId, token, step, JSON.stringify(patch)],
  )
  if (!r.rows.length) throw new LeaseLost()
}

const md = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`
/** 日本の日付（YYYY-MM-DD） */
const ymd = (d: Date) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10)

export async function runJob(deps: WorkerDeps, jobId: string): Promise<void> {
  const db = await deps.db()
  const token = randomUUID()
  // 始める印を付ける（期限つき）。同じジョブが 2 回届いても、2 つ目は何もしない
  let job
  try {
    job = (await db.query(
      `UPDATE jobs SET status = 'processing', attempts = attempts + 1, run_token = $2,
         lease_until = now() + interval '30 minutes', updated_at = now()
       WHERE id = $1 AND attempts < $3 AND (status = 'queued' OR (status = 'processing' AND lease_until < now()))
       RETURNING id, office_id, client_id, document_id, recording_id, steps, attempts`,
      [jobId, token, MAX_ATTEMPTS],
    )).rows[0]
  } catch (e) {
    // 同じ書類で別のジョブが処理中（一意の索引）。見回りがあとで積み直す
    if ((e as { code?: string }).code === '23505') return log({ msg: 'job waits for another job', jobId })
    throw e
  }
  if (!job) return log({ msg: 'job already taken or done', jobId })
  const steps = (job.steps ?? {}) as Record<string, Record<string, unknown>>
  const t0 = Date.now()
  // 長い STT・Gemini 呼び出し中にも lease を延長する。古い実行の更新は token で拒否する。
  const heartbeat = setInterval(() => {
    void db.query("UPDATE jobs SET lease_until = now() + interval '30 minutes' WHERE id = $1 AND run_token = $2 AND status = 'processing' AND lease_until > now()", [jobId, token])
      .catch((e) => log({ msg: 'lease heartbeat failed', jobId, error: (e as Error).name }))
  }, 60_000)
  heartbeat.unref()
  try {
    const providers = await deps.providers()
    const rec = (await db.query('SELECT id, object_path, mime, recorded_at FROM recordings WHERE id = $1', [job.recording_id])).rows[0]
    const sequence = Number((await db.query(
      // 時刻は JS の Date にするとマイクロ秒が落ちるので、DB の中で比べる
      "SELECT count(*) AS n FROM recordings WHERE client_id = $1 AND status = 'uploaded' AND recorded_at <= (SELECT recorded_at FROM recordings WHERE id = $2)",
      [job.client_id, rec.id],
    )).rows[0].n) || 1

    // ① 文字にする
    let utterances: Utterance[]
    const existing = (await db.query('SELECT utterances FROM transcripts WHERE recording_id = $1', [rec.id])).rows[0]
    if (existing) utterances = existing.utterances
    else {
      await setStep(db, jobId, token, 'transcribe')
      const s0 = Date.now()
      const stt = await providers.stt.transcribe({
        uri: deps.storage().uri('source', rec.object_path), mime: rec.mime, recordingId: rec.id, sequence,
        resumeOperation: steps.transcribe?.operation as string | undefined,
        onOperation: (name) => setStep(db, jobId, token, 'transcribe', { transcribe: { operation: name } }),
      })
      utterances = stt.utterances
      await db.query(
        'INSERT INTO transcripts (recording_id, office_id, client_id, utterances, model) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (recording_id) DO NOTHING',
        [rec.id, job.office_id, job.client_id, JSON.stringify(utterances), stt.model],
      )
      await setStep(db, jobId, token, 'transcribe', { transcribe: { seconds: (Date.now() - s0) / 1000, utterances: utterances.length, audioSeconds: stt.audioSeconds ?? null, model: stt.model } })
    }

    // ② 話した人を決める
    const people: Person[] = (await db.query('SELECT label, role, relation FROM people WHERE client_id = $1', [job.client_id])).rows
    if (!steps.speakers) {
      await setStep(db, jobId, token, 'speakers')
      const r = await providers.speakers.assign({ utterances, people })
      for (const p of r.newPeople) {
        await db.query('INSERT INTO people (office_id, client_id, label, role, relation) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (client_id, label) DO NOTHING', [job.office_id, job.client_id, p.label, p.role, p.relation ?? null])
        people.push(p)
      }
      utterances = utterances.map((u) => ({ ...u, person: u.person ?? r.map[u.speaker] ?? null }))
      await db.query('UPDATE transcripts SET utterances = $2, speakers = $3 WHERE recording_id = $1', [rec.id, JSON.stringify(utterances), JSON.stringify(r.map)])
      await setStep(db, jobId, token, 'speakers', { speakers: { people: people.length, usage: r.usage } })
    }

    // 書く欄は、録音がつながった書類の様式の版から決める（その様式だけの欄の定義つき）
    const version = (await db.query('SELECT template_version_id FROM documents WHERE id = $1', [job.document_id])).rows[0].template_version_id as string
    const form = await loadFormDef(db, version)
    const curRows = (await db.query('SELECT key, value, by FROM field_values WHERE document_id = $1', [job.document_id])).rows
    const current = Object.fromEntries(curRows.map((r) => [r.key, r.value]))
    // 1 回目 = この書類に、まだ AI の書き込み（録音・見本）がない
    const first = !(await db.query("SELECT 1 FROM batches WHERE document_id = $1 AND kind IN ('recording', 'seed') AND (job_id IS NULL OR job_id <> $2) LIMIT 1", [job.document_id, jobId])).rows.length
    const recordedOn = ymd(new Date(rec.recorded_at))

    // ③ 欄の値を作る（要約から書く）
    const ctx: StepCtx = { db, jobId, token, steps, job, rec, utterances, people, form, current, first, recordedOn }
    const made = await fromSummaries(ctx, providers.recording)

    // ⑤ 用紙に反映する（書類の行を止めるのは、ここの数秒だけ）
    await setStep(db, jobId, token, 'apply')
    const n = Number((await db.query("SELECT count(*) AS n FROM batches WHERE document_id = $1 AND kind = 'recording'", [job.document_id])).rows[0].n) + 1
    const status = made.failed.length || made.incompleteFields.length ? 'partial' : 'succeeded'
    const { plan } = await applyBatch(db, {
      officeId: job.office_id, documentId: job.document_id, kind: 'recording', jobId,
      label: `AI 書き込み ${n}・${md(new Date(rec.recorded_at))} の録音`, proposed: made.proposed, system: made.system,
      completion: { token, status, steps: { totalSeconds: (Date.now() - t0) / 1000 } },
    })
    log({ msg: 'job done', jobId, status, seconds: (Date.now() - t0) / 1000, changes: plan.changes.length, kept: plan.kept.length })
  } catch (e) {
    const kind = (e as Error)?.name ?? 'Error'
    // 誤りの番号（gRPC・HTTP の状態の番号）だけを足す。文面は中身が入りうるので出さない
    const code = typeof (e as { code?: unknown })?.code === 'number' ? (e as { code: number }).code : null
    const terminal = job.attempts >= MAX_ATTEMPTS
    await db.query("UPDATE jobs SET status = $3, error_kind = $4, lease_until = NULL, run_token = NULL, updated_at = now() WHERE id = $1 AND run_token = $2", [jobId, token, terminal ? 'failed' : 'queued', code === null ? kind : `${kind}:${code}`])
    console.error(JSON.stringify({ severity: 'ERROR', msg: 'job failed', jobId, error: kind, code }))
    // 中身が入りうるので、ローカルで調べるときだけ出す
    if (process.env.DEBUG_JOBS) console.error(e)
    throw e
  } finally {
    clearInterval(heartbeat)
  }
}

interface StepCtx {
  db: Db
  jobId: string
  token: string
  steps: Record<string, Record<string, unknown>>
  job: { office_id: string, client_id: string, document_id: string }
  rec: { id: string, recorded_at: Date }
  utterances: Utterance[]
  people: Person[]
  form: FormDef
  current: Record<string, unknown>
  first: boolean
  /** 録音の日（日本の日付） */
  recordedOn: string
}

/** ③④ の結果: 書類に入れる値（型を確かめたもの）と、機械で入れる欄（日付） */
interface Made {
  proposed: Record<string, ProposedValue>
  system: Record<string, unknown>
  failed: string[]
  incompleteFields: string[]
}

/**
 * 要約から書く（docs/再設計/17_録音からの書き込み.md）。
 *   3. 要約: 新しい録音を 1 回だけ全部読み、項目ごとに recording_summaries に足す（書き換えない。話に出なかった項目は行を作らない）。
 *      要約は残るので、4 から先で失敗してやり直しても、要約はし直さない
 *   4〜7. 使う要約（足していく種類は 1 回目から全部、単体の種類は今回だけ）から、欄を選び、書き、全体のまとめを書き、最後のチェックをする
 *   8. 型を確かめる。その日の日付は、機械の項目の欄に入れる（1 回目は first の欄が空のときだけ、2 回目からは later の欄）
 * 項目の一覧は、全体の一覧に事業所の書き足しと足した項目を合わせたもの。その指紋を残す。一覧が空の種類は、録音から書かない
 */
async function fromSummaries(ctx: StepCtx, recording: Providers['recording']): Promise<Made> {
  const { db, jobId, token, steps, job, rec, form, current, first } = ctx
  const none: Made = { proposed: {}, system: {}, failed: [], incompleteFields: [] }
  const kind = (await db.query(
    'SELECT k.key, k.name, k.topics, k.summary_mode FROM documents d JOIN form_kinds k ON k.key = d.kind WHERE d.id = $1',
    [job.document_id],
  )).rows[0]
  const office = (await db.query('SELECT added, notes FROM office_topics WHERE office_id = $1 AND kind = $2', [job.office_id, kind.key])).rows[0] as OfficeTopics | undefined
  const topics = topicsFor(kind.topics as Topic[], office ?? null)
  const fingerprint = topicsFingerprint(topics)
  const ai = summaryTopics(topics)
  if (!ai.length) {
    await setStep(db, jobId, token, 'write', { write: { skipped: 'no-topics', topics: fingerprint } })
    return none
  }

  // ③ 要約（この録音で、まだ作っていなければ）
  if (!steps.summarize) {
    await setStep(db, jobId, token, 'summarize')
    const made = Number((await db.query('SELECT count(*) AS n FROM recording_summaries WHERE recording_id = $1', [rec.id])).rows[0].n)
    let usage: Usage | null = null
    const s0 = Date.now()
    if (!made) {
      const r = await recording.summarizer.summarize({ kindName: kind.name, topics: ai, utterances: ctx.utterances, people: ctx.people })
      usage = r.usage
      for (const t of ai) {
        const text = r.texts[t.id]?.trim()
        if (!text) continue
        await db.query(
          'INSERT INTO recording_summaries (office_id, client_id, recording_id, document_id, topic, text) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (recording_id, topic) DO NOTHING',
          [job.office_id, job.client_id, rec.id, job.document_id, t.id, text],
        )
      }
    }
    const count = Number((await db.query('SELECT count(*) AS n FROM recording_summaries WHERE recording_id = $1', [rec.id])).rows[0].n)
    await setStep(db, jobId, token, 'summarize', { summarize: { seconds: (Date.now() - s0) / 1000, summaries: count, topics: fingerprint, usage } })
  }

  // 使う要約（足していく種類は、この書類につながった録音の要約を 1 回目から全部。単体の種類は今回の録音だけ）
  const append = kind.summary_mode === 'append'
  const recs = (await db.query(
    'SELECT id FROM recordings WHERE document_id = $1 AND recorded_at <= (SELECT recorded_at FROM recordings WHERE id = $2) ORDER BY recorded_at, created_at',
    [job.document_id, rec.id],
  )).rows.map((r) => r.id as string)
  const seqOf = new Map(recs.map((id, i) => [id, i + 1]))
  const rows = (await db.query(
    `SELECT s.id, s.topic, s.text, s.recording_id, r.recorded_at FROM recording_summaries s JOIN recordings r ON r.id = s.recording_id
     WHERE s.document_id = $1 AND (s.recording_id = $2 OR ($3 AND r.recorded_at <= (SELECT recorded_at FROM recordings WHERE id = $2)))
     ORDER BY r.recorded_at, s.topic`,
    [job.document_id, rec.id, append],
  )).rows
  const known = new Set(ai.map((t) => t.id))
  const summaries: SummaryLine[] = rows.filter((r) => known.has(r.topic)).map((r) => ({
    id: r.id, topic: r.topic, text: r.text, seq: seqOf.get(r.recording_id) ?? 1, date: ymd(new Date(r.recorded_at)), isNew: r.recording_id === rec.id,
  }))

  // ④〜⑦ 欄を選ぶ → 書く → 全体のまとめ → 最後のチェック
  await setStep(db, jobId, token, 'write')
  const w0 = Date.now()
  const showNew = append && !first
  const written = await recording.writer.write({ kindName: kind.name, topics, summaries, showNew, current, form })

  // ⑧ 型の確かめ（版の欄の辞書）。通らない値は落として数える
  const { proposed, droppedFields } = prepareWriterValues(written.values, fieldDict(form.localFields))
  const incompleteFields = incompleteFieldKeys(written.incompleteFields, droppedFields)
  await setStep(db, jobId, token, 'write', { write: { seconds: (Date.now() - w0) / 1000, summaries: summaries.length, values: Object.keys(proposed).length, dropped: droppedFields.length, droppedFields, failed: written.failed, incompleteFields, usage: written.usage satisfies Usage, first, showNew, topics: fingerprint } })

  // その日の日付（機械の項目）
  const system: Record<string, unknown> = {}
  for (const t of topics) {
    if (t.by !== 'machine' || !t.keys) continue
    if (!first) system[t.keys.later] = ctx.recordedOn
    else if (current[t.keys.first] === undefined || current[t.keys.first] === null || current[t.keys.first] === '') system[t.keys.first] = ctx.recordedOn
  }
  return { proposed, system, failed: written.failed, incompleteFields }
}

/** 見回り: 積み損ね・止まった処理・待たされたジョブを積み直す（Cloud Scheduler が 5 分ごとに呼ぶ） */
export async function reconcile(deps: WorkerDeps, enqueue: (jobId: string) => Promise<void>): Promise<number> {
  const db = await deps.db()
  await db.query(
    "UPDATE jobs SET status = 'failed', lease_until = NULL, run_token = NULL, error_kind = coalesce(error_kind, 'AttemptsExhausted'), updated_at = now() WHERE attempts >= $1 AND (status = 'queued' OR (status = 'processing' AND lease_until < now()))",
    [MAX_ATTEMPTS],
  )
  const r = await db.query(
    `SELECT id FROM jobs
     WHERE (status = 'queued' AND updated_at < now() - interval '2 minutes')
        OR (status = 'processing' AND lease_until < now())
     ORDER BY created_at LIMIT 20`,
  )
  for (const row of r.rows) await enqueue(row.id)
  return r.rows.length
}
