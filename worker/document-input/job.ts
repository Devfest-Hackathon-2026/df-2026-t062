import { createHash, randomUUID } from 'node:crypto'
import { documentInputPath, type DocumentInputResult, type DocumentMime } from '../../core/document-input.ts'
import { fieldDict } from '../../core/dictionary.ts'
import { summaryTopics, topicsFor, type Topic, type OfficeTopics } from '../../core/topics.ts'
import { loadFormDef } from '../../db/forms.ts'
import { prepareWriterValues } from '../job-values.ts'
import { contextFields, type WorkerContext, type WorkerDeps } from '../jobs.ts'
import { safeAiJobErrorCode, writeAiJobEvent, writeAiQueueSnapshot } from '../ai-job-observability.ts'
import { ZERO_USAGE, type Usage, type SummaryLine, type Summarizer } from '../types.ts'
import { unresolvedFieldKeys } from './review.ts'
import { DocumentReadError, readDocument } from './read.ts'

const MAX_ATTEMPTS = 3
class LeaseLost extends Error {}
export async function runDocumentInput(deps: WorkerDeps, id: string, context?: WorkerContext) {
  const db = await deps.db()
  const token = randomUUID()
  const row = (await db.query(`UPDATE document_inputs SET status='processing',attempts=attempts+1,run_token=$2,
    lease_until=now()+interval '30 minutes',updated_at=now(),
    template_version_id=coalesce(template_version_id,(SELECT template_version_id FROM documents WHERE id=document_inputs.document_id))
    WHERE id=$1 AND attempts<$3 AND (status='queued' OR (status='processing' AND lease_until<now())) RETURNING *`, [id, token, MAX_ATTEMPTS])).rows[0]
  if (!row) return
  const t0 = Date.now()
  writeAiJobEvent({ jobType: 'document_input', phase: 'started', jobId: id, attempt: row.attempts, context })
  const update = async (sql: string, args: unknown[] = []) => {
    const r = await db.query(`UPDATE document_inputs SET ${sql},updated_at=now() WHERE id=$1 AND run_token=$2 AND status='processing' AND lease_until>now() RETURNING id`, [id, token, ...args])
    if (!r.rows.length) throw new LeaseLost()
  }
  const heartbeat = setInterval(() => {
    void update("lease_until=now()+interval '30 minutes'").catch(() => {})
  }, 60_000)
  heartbeat.unref()
  try {
    const providers = await deps.providers()
    if (!providers.documentRead) throw new DocumentReadError('reader_not_configured')
    const llm = providers.documentRead()
    const data = await deps.storage().read('source', documentInputPath(row.office_id, row.client_id, id, row.upload_generation))
    if (createHash('sha256').update(data).digest('hex') !== row.sha256) throw new DocumentReadError('hash_mismatch')
    const readUsage = row.read_usage as Usage
    const pages = row.pages
    const started = Date.now()
    const reading = await readDocument(data, { id, mime: row.mime as DocumentMime, ask: llm.ask, pages,
      onPage: async (page, value) => {
        if (Date.now() - started > 20 * 60_000 || llm.usage().yen + readUsage.yen > 200) throw new DocumentReadError('read_limit')
        pages[page] = value
        await update('pages=$3,read_usage=$4', [JSON.stringify(pages), JSON.stringify(addUsage(readUsage, llm.usage()))])
      },
    })
    // Visit が共通接続点。書類別のキー変換や事実の構造化層は作らない。
    const doc = (await db.query('SELECT template_version_id FROM documents WHERE id=$1 AND office_id=$2 AND client_id=$3', [row.document_id, row.office_id, row.client_id])).rows[0]
    if (!doc) throw new DocumentReadError('document_missing')
    const form = await loadFormDef(db, row.template_version_id)
    const rows = (await db.query('SELECT key,value,cite FROM field_values WHERE document_id=$1', [row.document_id])).rows
    const sources = Object.fromEntries(rows.map((r) => [r.key, r.cite]))
    const current = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    // 曖昧な文字は明示して残すが、候補の根拠には使わない。
    const safeIds = new Set(reading.evidence.filter((e) => !e.uncertain).map((e) => e.id))
    const visit = { ...reading.visit, scenes: reading.visit.scenes.map((s) => ({ ...s, entries: s.entries.filter((e) => safeIds.has(e.id)) })) }
    const unresolved = unresolvedFieldKeys(form, reading)
    const writableForm = { ...form, keys: form.keys.filter((key) => !unresolved.has(key)) }
    const pipeline = providers.documentWrite
    if (!pipeline) throw new DocumentReadError('writer_not_configured')
    type Bundle = Awaited<ReturnType<Summarizer['summarize']>> & { topics: Topic[], kindName: string }
    let bundle = row.summary_bundle as Bundle | null
    if (safeIds.size && !bundle) {
      const kind = (await db.query(`SELECT k.key,k.name,k.topics FROM documents d JOIN form_kinds k ON k.key=d.kind WHERE d.id=$1`, [row.document_id])).rows[0]
      const office = (await db.query('SELECT added,notes FROM office_topics WHERE office_id=$1 AND kind=$2', [row.office_id, kind.key])).rows[0] as OfficeTopics | undefined
      const topics = topicsFor(kind.topics as Topic[], office ?? null)
      if (!summaryTopics(topics).length) throw new DocumentReadError('no_topics')
      const summarized = await pipeline.summarizer.summarize({ kindName: kind.name, topics, utterances: [], people: [], records: [visit] })
      bundle = { ...summarized, kindName: kind.name, topics }
      await update('summary_bundle=$3', [JSON.stringify(bundle)])
    }
    const summaries: SummaryLine[] = []
    if (bundle) {
      for (const topic of summaryTopics(bundle.topics)) {
        const text = bundle.texts[topic.id]
        const ids = bundle.sourceIds?.[topic.id]
        if (!text || !ids?.length || !ids.every((id) => safeIds.has(id))) continue
        summaries.push({ id: `d${id}-summary-${topic.id}`, topic: topic.id, text, seq: 1, date: '不明', isNew: true })
      }
    }
    const written = bundle && summaries.length ? await pipeline.writer.write({
      kindName: bundle.kindName, topics: bundle.topics, summaries, current, form: writableForm, showNew: false, sourceKind: '書類',
    }) : { values: {}, usage: ZERO_USAGE, failed: [], incompleteFields: [] }
    const { proposed, droppedFields } = prepareWriterValues(written.values, fieldDict(form.localFields))
    const allowed = new Set(writableForm.keys)
    const adopted = new Set<string>(row.adopted)
    const previous = row.result as DocumentInputResult | null
    const candidates = previous?.candidates.filter((candidate) => adopted.has(candidate.key)) ?? []
    const missingEvidence: string[] = []
    for (const [key, proposal] of Object.entries(proposed)) {
      if (adopted.has(key) || !allowed.has(key) || proposal.value == null) continue
      const references = proposal.cite && !Array.isArray(proposal.cite) ? proposal.cite.ids : []
      const referenced = references.map((reference) => summaries.find((summary) => summary.id === reference))
      const cite = [...new Set(referenced.flatMap((summary) => summary ? bundle?.sourceIds?.[summary.topic] ?? [] : []))]
      if (!cite.length || referenced.some((summary) => !summary) || !cite.every((id) => safeIds.has(id))) {
        missingEvidence.push(key)
        continue
      }
      const source = sources[key]
      const baseSource = source?.kind === 'document-input'
        ? { fileName: source.fileName as string, recordedOn: (source.evidence as { recordedOn: string | null }[]).map((e) => e.recordedOn), inputId: source.inputId as string }
        : source?.kind === 'survey-import' ? { fileName: source.fileName as string, recordedOn: [source.recordedOn as string | null] } : null
      candidates.push({ key, value: proposal.value, base: current[key] ?? null, baseSource, cite })
    }
    const result: DocumentInputResult = { ...reading, candidates,
      incompleteFields: [...new Set([...written.incompleteFields, ...droppedFields, ...missingEvidence, ...unresolved])],
      usage: addUsage(addUsage(addUsage(readUsage, llm.usage()), bundle?.usage ?? ZERO_USAGE), written.usage),
    }
    // 候補を作ったときの版を固定する。採用時はこの版と書類の今の版を照合する。
    await update("status='review',result=$3,run_token=NULL,lease_until=NULL,error_kind=NULL", [JSON.stringify(result)])
    writeAiJobEvent({ jobType: 'document_input', phase: 'succeeded', jobId: id, attempt: row.attempts, durationMs: Date.now() - t0, usage: result.usage, counts: { candidate_count: result.candidates.length }, context })
  } catch (e) {
    if (e instanceof LeaseLost) return
    const kind = e instanceof DocumentReadError ? e.kind : 'processing_failed'
    const retryable = !(e instanceof DocumentReadError) && row.attempts < MAX_ATTEMPTS
    await update('status=$3,error_kind=$4,run_token=NULL,lease_until=NULL', [retryable ? 'queued' : 'failed', kind])
    writeAiJobEvent({ jobType: 'document_input', phase: retryable ? 'retry' : 'failed', jobId: id, attempt: row.attempts, durationMs: Date.now() - t0, errorCode: kind, retryable, context })
    // 原文やモデル応答を含みうる例外はログに渡さない。
    console.error(JSON.stringify({ severity: 'ERROR', ...contextFields(context), msg: 'document input failed', id, error: safeAiJobErrorCode(kind) }))
    if (!(e instanceof DocumentReadError)) throw new Error('document_input_retry')
  } finally { clearInterval(heartbeat) }
}
function addUsage(a: Usage, b: Usage): Usage {
  return Object.fromEntries(Object.keys(ZERO_USAGE).map((key) => [key, a[key as keyof Usage] + b[key as keyof Usage]])) as unknown as Usage
}
export async function reconcileDocumentInputs(deps: WorkerDeps, enqueue: (id: string) => Promise<void>) {
  const db = await deps.db()
  await db.query(`UPDATE document_inputs SET status='failed',error_kind='attempts_exhausted',run_token=NULL,lease_until=NULL
    WHERE attempts >= $1 AND (status='queued' OR (status='processing' AND lease_until<now()))`, [MAX_ATTEMPTS])
  const rows = (await db.query(`SELECT id FROM document_inputs WHERE (status='queued' AND updated_at<now()-interval '2 minutes')
    OR (status='processing' AND lease_until<now()) ORDER BY created_at LIMIT 20`)).rows
  for (const row of rows) await enqueue(row.id)
  await writeAiQueueSnapshot(db, 'document_input', rows.length)
  return rows.length
}
