import type { CareFeeCalculation,CareFeeSummary,FeeCalculateInput } from '../../core/care-fee-api.ts'
import type { CareMonthView,CareMonthSummary,CareMonthSaved,MonthCreateInput,MonthSaveInput,MonthActionInput } from '../../core/care-month-api.ts'
import type { MonthEntry } from '../../core/care-month.ts'
import type { z } from 'zod'
import type { CareRecordKind, CareRecordSummary, CareRecordRevision, CareRecordDraftView } from '../../core/care-record.ts'
import type { DiagramDraft } from '../../api/chat.ts'
import type { DiagramChatField } from '../../core/diagram/fields.ts'
// api の呼び出し。ログインのトークンを付ける。型は db/repo.ts と同じ形。
import type { DocumentInputView, DocumentMime } from '../../core/document-input.ts'
import type { ClientSummary, DocumentView, JobView, RecordingRetentionListItem, SlotEdit, SlotEditResult, Staff } from '../../db/repo.ts'
import type { FormKindRow } from '../../db/kinds.ts'
import type { FormAssetsView, FormKind, FormVersionView } from '../../core/form.ts'

import type { SurveyImportKey, SurveySource } from '../../core/survey-import.ts'
import type { ChatMessage, ChatReply } from '../../api/chat.ts'
import type { InspectionSummary, InspectionView } from '../../db/inspections.ts'
import type { FillView } from '../../db/document-fills.ts'
import { readChatStream } from './chatStream.ts'
import type { CarePlanView, CarePlanSummary, NeedInput, SlotInput, AiDraftDetail } from '../../db/care-plans.ts'
import type { KindFormState } from '../../db/forms.ts'
import type { FormImportView } from '../../db/form-imports.ts'
import type { SlotMeaning } from '../../core/slot-meaning.ts'
import type { OfficeTopicsEdit, TeachDecision, TrainingItem } from '../../core/topics.ts'
import type { TrainingView } from '../../db/office-topics.ts'
import type { LocalField } from '../../core/dictionary.ts'
import type { HoldReasonCode, RecordingRetentionState } from '../../db/recording-retention.ts'
import type { RecordingConsentView } from '../../core/recording-consent.ts'

export type { ClientSummary, DocumentView, JobView, RecordingRetentionListItem, SlotEdit, SlotEditResult, Staff, KindFormState, FormImportView, SlotMeaning, TrainingView, TrainingItem, TeachDecision, OfficeTopicsEdit }

/** 責任者が見る様式の版（GET /api/office/form-versions/:id）。slots は印字欄ごとの入る内容の言葉、review は取り込みが迷った欄 */
export interface ManagedVersion {
  formVersion: FormVersionView & { status: 'draft' | 'published' | 'retired', global: boolean, localFields: LocalField[] }
  problems: string[]
  slots: Record<string, SlotMeaning>
  review: { slot: string, reason: string }[]
}

/** 書類の種類と、その事業所で書類を作れるか（GET /api/form-kinds） */
export type FormKindView = FormKindRow & { available: boolean }

export interface ClientDetail {
  id: string
  name: string
  status: string
  nextVisitAt: string | null
  documents: { id: string, kind: FormKind, formVersionId: string }[]
  required: { filled: number, total: number }
}

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, message: string, code = '', details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
  details?: unknown
}

let tokenSource: () => Promise<string | null> = async () => null
export function setTokenSource(fn: () => Promise<string | null>) {
  tokenSource = fn
}

async function req<T>(method: string, path: string, body?: unknown, cache: RequestCache = 'no-store'): Promise<T> {
  const token = await tokenSource()
  const res = await fetch(path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache,
  })
  if (!res.ok) await fail(res)
  return res.json() as Promise<T>
}

async function fail(res: Response): Promise<never> {
  const j = await res.json().catch(() => ({}))
  throw new ApiError(res.status, j.message ?? j.error ?? `HTTP ${res.status}`, j.error ?? '', j)
}

/** 様式の版は中身が変わらないので、開いている間は覚えておく（ブラウザも覚える） */
const versions = new Map<string, Promise<FormVersionView>>()

export const api = {
  carePlans: (clientId: string) => req<{ plans: CarePlanSummary[] }>('GET', `/api/clients/${clientId}/care-plans`),
  carePlan: (id: string) => req<{ plan: CarePlanView }>('GET', `/api/care-plans/${id}`),
  createCarePlan: (clientId: string, input: { effectiveFrom: string, effectiveTo?: string | null, copyFromPlanId?: string }) =>
    req<{ plan: CarePlanView }>('POST', `/api/clients/${clientId}/care-plans`, input),
  carePlanNeeds: (id: string, baseVersion: number, needs: NeedInput[]) =>
    req<{ plan: CarePlanView }>('PUT', `/api/care-plans/${id}/needs`, { baseVersion, needs }),
  carePlanSchedule: (id: string, baseVersion: number, slots: SlotInput[]) =>
    req<{ plan: CarePlanView }>('PUT', `/api/care-plans/${id}/schedule`, { baseVersion, slots }),
  saveCarePlan: (id: string, baseVersion: number) =>
    req<{ plan: CarePlanView }>('POST', `/api/care-plans/${id}/save`, { baseVersion }),
  confirmCarePlan: (id: string, baseVersion: number) =>
    req<{ plan: CarePlanView }>('POST', `/api/care-plans/${id}/confirm`, { baseVersion }),
  carePlanAi: (id: string, sourceDocumentId: string, sourceRevisionId: number) =>
    req<{ draft: AiDraftDetail }>('POST', `/api/care-plans/${id}/ai-drafts`, { sourceDocumentId, sourceRevisionId }),
  carePlanAiDraft: (id: string, draftId: string) =>
    req<{ draft: AiDraftDetail }>('GET', `/api/care-plans/${id}/ai-drafts/${draftId}`),
  applyCarePlanAi: (id: string, draftId: string, baseVersion: number) =>
    req<{ plan: CarePlanView, applied: { fields: string[], needs: string[], slots: string[], skipped: { target: string, reason: string }[] } }>('POST', `/api/care-plans/${id}/ai-drafts/${draftId}/apply`, { baseVersion }),
  async carePlanPdf(id: string, form: 'all' | '1' | '2' | '3'): Promise<Blob> {
    const token = await tokenSource()
    const response = await fetch(`/api/care-plans/${id}/pdf?form=${form}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!response.ok) await fail(response)
    return response.blob()
  },
  documentInputs: (id: string) => req<{ inputs: DocumentInputView[] }>('GET', `/api/documents/${id}/inputs`),
  startDocumentInput: (id: string, body: { fileName: string, sha256: string, bytes: number, mime: DocumentMime, expiredUploadUrl?: string }) =>
    req<{ input: DocumentInputView, uploadUrl: string | null }>('POST', `/api/documents/${id}/inputs`, body),
  retryDocumentInput: (id: string) => req<{ input: DocumentInputView }>('POST', `/api/document-inputs/${id}/retry`, {}),
  completeDocumentInput: (id: string) => req<{ input: DocumentInputView }>('POST', `/api/document-inputs/${id}/complete`, {}),
  adoptDocumentInput: (id: string, changes: { key: string, base: unknown }[]) =>
    req<{ document: DocumentView }>('POST', `/api/document-inputs/${id}/adopt`, { targetConfirmed: true, changes }),
  async documentOriginal(id: string): Promise<Blob> {
    const token = await tokenSource()
    const res = await fetch(`/api/document-inputs/${id}/original`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!res.ok) await fail(res)
    return res.blob()
  },
  formVersion(id: string): Promise<FormVersionView> {
    let p = versions.get(id)
    if (!p) {
      p = req<{ formVersion: FormVersionView }>('GET', `/api/form-versions/${id}`, undefined, 'default').then((r) => r.formVersion)
      p.catch(() => versions.delete(id))
      versions.set(id, p)
    }
    return p
  },
  formAssets: (id: string) => req<FormAssetsView>('GET', `/api/form-versions/${id}/assets`),
  me: () => req<{ staff: Staff }>('GET', '/api/me'),
  clients: (q = '', sort: 'updated' | 'name' = 'updated') => req<{ clients: ClientSummary[] }>('GET', `/api/clients?q=${encodeURIComponent(q)}&sort=${sort}`),
  createClient: (input: { name: string, sex?: '男' | '女' | null, status?: string }) => req<{ id: string, documentId: string }>('POST', '/api/clients', input),
  formKinds: () => req<{ kinds: FormKindView[] }>('GET', '/api/form-kinds'),
  publishedForm: (kind:string) => req<{formVersionId:string}>('GET',`/api/form-kinds/${encodeURIComponent(kind)}/published`),
  client: (id: string) => req<{ client: ClientDetail, jobs: JobView[] }>('GET', `/api/clients/${id}`),
  createDocument: (clientId: string, kind: string) => req<{ id: string, kind: string, created: boolean }>('POST', `/api/clients/${clientId}/documents`, { kind }),
  careFees:(clientId:string)=>req<{fees:CareFeeSummary[]}>('GET',`/api/clients/${clientId}/care-plan-fees`),
  careFee:(id:string,calculationId?:string)=>req<{calculation:CareFeeCalculation}>('GET',calculationId?`/api/care-plan-fees/${id}/calculations/${calculationId}`:`/api/care-plan-fees/${id}`),
  careFeeHistory:(id:string)=>req<{history:{id:string;revision:number;createdAt:string}[]}>('GET',`/api/care-plan-fees/${id}/history`),
  calculateCareFee:(monthId:string,input:z.infer<typeof FeeCalculateInput>)=>req<{calculation:CareFeeCalculation}>('POST',`/api/care-plan-months/${monthId}/fees`,input),
  confirmCareFee:(id:string,calculationId:string,baseRevision:number)=>req<{calculation:CareFeeCalculation}>('POST',`/api/care-plan-fees/${id}/confirm`,{calculationId,baseRevision}),
  careMonths:(clientId:string)=>req<{months:CareMonthSummary[]}>('GET',`/api/clients/${clientId}/care-plan-months`),
  careMonth:(id:string)=>req<{month:CareMonthView}>('GET',`/api/care-plan-months/${id}`),
  previewCareMonth:(clientId:string,planId:string,month:string)=>req<{confirmationId:string;sourceHash:string;planVersion:number;entries:MonthEntry[];unexpanded:CareMonthView['unexpanded']}>('POST',`/api/clients/${clientId}/care-plan-months/preview`,{planId,month}),
  createCareMonth:(clientId:string,input:z.infer<typeof MonthCreateInput>)=>req<{month:CareMonthView;created:boolean}>('POST',`/api/clients/${clientId}/care-plan-months`,input),
  saveCareMonth:(id:string,input:z.infer<typeof MonthSaveInput>)=>req<{month:CareMonthView}>('PUT',`/api/care-plan-months/${id}`,input),
  previewMonthAction:(id:string,input:z.infer<typeof MonthActionInput>)=>req<{entries:MonthEntry[];added:MonthEntry[];removed:MonthEntry[];skipped:MonthEntry[]}>('POST',`/api/care-plan-months/${id}/preview`,input),
  careMonthRevision:(id:string,rev:number)=>req<CareMonthSaved>('GET',`/api/care-plan-months/${id}/revisions/${rev}`),
  careRecords: (clientId: string, query: { kind?: CareRecordKind, q?: string, from?: string, to?: string, offset?: number }) => req<{ records: CareRecordSummary[], hasMore: boolean }>('GET', `/api/clients/${clientId}/care-records?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))}`),
  createCareRecord: (clientId: string, kind: CareRecordKind, requestId: string) => req<{ id: string, created: boolean }>('POST', `/api/clients/${clientId}/care-records`, { kind, requestId }),
  careRecordDrafts: (id: string) => req<{ drafts: CareRecordDraftView[] }>('GET', `/api/care-records/${id}/ai-drafts`),
  createCareRecordDraft: (id: string, requestId: string, instructions: string) => req<{ draft: CareRecordDraftView }>('POST', `/api/care-records/${id}/ai-drafts`, { requestId, instructions }),
  applyCareRecordDraft: (id: string, draftId: string) => req<{ draft: CareRecordDraftView, document: DocumentView }>('POST', `/api/care-records/${id}/ai-drafts/${draftId}/apply`, {}),
  confirmCareRecord: (id:string,baseRevision:number,relatedPlanId:string|null) => req<{confirmation: import('../../core/care-record.ts').CareRecordConfirmation}>('POST', `/api/care-records/${id}/confirm`, {baseRevision,relatedPlanId}),
  careRecordRevision: (id: string, rev: number) => req<{ revision: CareRecordRevision }>('GET', `/api/care-records/${id}/revisions/${rev}`),
  /** unheardTopics: 面談のヒント。事業所が足した項目で、この書類でまだ話に出ていないもの（#115） */
  document: (id: string) => req<{ document: DocumentView, unheardTopics?: { id: string, name: string }[] }>('GET', `/api/documents/${id}`),
  revisions: (id: string) => req<{ revisions: { id: number, rev: number, savedAt: string }[] }>('GET', `/api/documents/${id}/revisions`),
  patch: (id: string, changes: { key: string, value: unknown, base: unknown, mode?: 'edit' | 'revert' }[]) =>
    req<{ document: DocumentView }>('PATCH', `/api/documents/${id}/fields`, { changes }),
  /** 書き方の相談。ペットが道具を使うたびに onStep（作業ログの 1 行）を呼び、最後に答えを返す */
  async chat(id: string, messages: ChatMessage[], onStep: (step: string) => void, draft?: DiagramDraft, diagramField?: DiagramChatField): Promise<ChatReply> {
    const token = await tokenSource()
    const res = await fetch(`/api/documents/${id}/chat`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, draft, diagramField }),
      cache: 'no-store',
    })
    if (!res.ok || !res.body) await fail(res)
    return readChatStream(res.body!, onStep)
  },
  importSurvey: (id: string, body: Pick<SurveySource, 'fileName' | 'sha256' | 'recordedOn'> & {
    changes: { key: SurveyImportKey, choice: number, base: unknown }[],
  }) => req<{ document: DocumentView }>('POST', `/api/documents/${id}/survey-import`, body),
  edits: (id: string, formVersionId: string, edits: SlotEdit[]) =>
    req<{ results: SlotEditResult[], document: DocumentView }>('POST', `/api/documents/${id}/edits`, { formVersionId, edits }),
  reviewFields: (id:string,formVersionId:string,fields:{key:string;valueVersion:string;base:unknown}[],reviewed:boolean) =>
    req<{document:DocumentView}>('POST',`/api/documents/${id}/review`,{formVersionId,fields,reviewed}),
  confirmDocument: (id:string,baseRev:number) => req<{document:DocumentView}>('POST',`/api/documents/${id}/confirm`,{baseRev}),
  save: (id: string, body: { scope: 'document' } | { scope: 'page', page: number } | { scope: 'hunk', key: string, hunkIndex: number }) =>
    req<{ rev: number, document: DocumentView }>('POST', `/api/documents/${id}/save`, body),
  jobs: (clientId: string) => req<{ jobs: JobView[] }>('GET', `/api/clients/${clientId}/jobs`),
  /** AI 点検（#113）。始める・これまでの点検・1 回の結果 */
  /** 書類を作るときに、元の書類から AI が書く（#195） */
  startFill: (documentId: string) => req<{ fillId: string }>('POST', `/api/documents/${documentId}/fill`, {}),
  documentFill: (documentId: string) => req<{ fill: FillView | null }>('GET', `/api/documents/${documentId}/fill`),
  startInspection: (clientId: string) => req<{ inspectionId: string }>('POST', `/api/clients/${clientId}/inspections`, {}),
  inspections: (clientId: string) => req<{ inspections: InspectionSummary[] }>('GET', `/api/clients/${clientId}/inspections`),
  inspection: (id: string) => req<{ inspection: InspectionView }>('GET', `/api/inspections/${id}`),
  /** documentId: 録音を始めた書類（省けば主な書類） */
  startRecording: (clientId: string, mime: string, deviceRecordingId: string, expiredUploadUrl?: string, documentId?: string) =>
    req<{ recordingId: string, uploadUrl: string | null }>('POST', `/api/clients/${clientId}/recordings/resumable`, { mime, deviceRecordingId, expiredUploadUrl, documentId }),
  completeRecording: (id: string, durationMs: number, bytes: number) =>
    req<{ jobId: string, status: string }>('POST', `/api/recordings/${id}/complete`, { durationMs, bytes }),
  recordingConsent: (clientId: string) => req<{ consent: RecordingConsentView, policy: { version: string, scope: string } }>('GET', `/api/clients/${clientId}/recording-consent`),
  grantRecordingConsent: (clientId: string) => req<{ consent: RecordingConsentView }>('POST', `/api/clients/${clientId}/recording-consent`, { confirmed: true }),
  withdrawRecordingConsent: (clientId: string) => req<{ consent: RecordingConsentView }>('POST', `/api/clients/${clientId}/recording-consent/withdraw`, {}),
  recordingRetentions: (clientId: string) =>
    req<{ recordings: RecordingRetentionListItem[] }>('GET', `/api/office/clients/${clientId}/recordings/retention`),
  setRecordingRetentionHold: (recordingId: string, holdUntil: string, reasonCode: HoldReasonCode) =>
    req<{ retention: RecordingRetentionState }>('PUT', `/api/office/recordings/${recordingId}/retention-hold`, { holdUntil, reasonCode }),
  releaseRecordingRetentionHold: (recordingId: string) =>
    req<{ retention: RecordingRetentionState }>('DELETE', `/api/office/recordings/${recordingId}/retention-hold`),
  // ---------- 責任者の書類の設定（#102） ----------
  officeForms: () => req<{ kinds: KindFormState[] }>('GET', '/api/office/forms'),
  // ---------- 責任者が書類の種類を足す（#153） ----------
  createOfficeKind: (input: { name: string, perClient: 'one' | 'many', append: boolean }) =>
    req<{ kind: { key: string } }>('POST', '/api/office/form-kinds', input),
  // ---------- 事業所が直せる項目（#115。AI 特訓部屋） ----------
  // 事業所が足した書類の項目を置き換える（AI 特訓部屋の「この項目はいらない」が使う）
  setOfficeTopics: (key: string, topics: { id?: string, name: string, guide: string }[]) =>
    req<{ topics: KindFormState['topics'] }>('PUT', `/api/office/form-kinds/${encodeURIComponent(key)}/topics`, { topics }),
  officeTraining: (key: string) => req<TrainingView>('GET', `/api/office/topics/${encodeURIComponent(key)}`),
  saveOfficeTraining: (key: string, edit: OfficeTopicsEdit) => req<TrainingView>('PUT', `/api/office/topics/${encodeURIComponent(key)}`, edit),
  teachOfficeTopic: (key: string, text: string, current: string | null) =>
    req<{ decision: TeachDecision }>('POST', `/api/office/topics/${encodeURIComponent(key)}/teach`, { text, current }),
  retireOfficeKind: (key: string) => req<{ ok: true }>('POST', `/api/office/form-kinds/${encodeURIComponent(key)}/retire`, {}),
  startFormImport: (kind: string) => req<{ import: FormImportView, uploadUrl: string | null }>('POST', '/api/office/form-imports', { kind }),
  completeFormImport: (id: string) => req<{ import: FormImportView }>('POST', `/api/office/form-imports/${id}/complete`, {}),
  managedVersion: (id: string) => req<ManagedVersion>('GET', `/api/office/form-versions/${id}`),
  positionSlots: (id: string, base: string, schemas: ManagedVersion['formVersion']['schemas']) =>
    req<ManagedVersion>('PATCH', `/api/office/form-versions/${id}`, { base, schemas }),
  managedAssets: (id: string) => req<FormAssetsView>('GET', `/api/office/form-versions/${id}/assets`),
  teachSlot: (id: string, slot: string, base: string, text: string) =>
    req<ManagedVersion & { matched: 'field' | 'local' }>('POST', `/api/office/form-versions/${id}/slots/${encodeURIComponent(slot)}`, { base, text }),
  unusedSlot: (id: string, slot: string, base: string) =>
    req<ManagedVersion & { matched: 'unused' }>('POST', `/api/office/form-versions/${id}/slots/${encodeURIComponent(slot)}`, { base, unused: true }),
  publishVersion: (id: string, base: string) => req<ManagedVersion>('POST', `/api/office/form-versions/${id}/publish`, { base }),
  fixDraft: (id: string) => req<ManagedVersion>('POST', `/api/office/form-versions/${id}/draft`, {}),
  revertForm: (kind: string) => req<{ kinds: KindFormState[] }>('POST', `/api/office/forms/${encodeURIComponent(kind)}/revert`, {}),
  reuseForm: (id: string) => req<ManagedVersion>('POST', `/api/office/form-versions/${id}/reuse`, {}),
  async pdf(id: string, revision?: number): Promise<Blob> {
    const token = await tokenSource()
    const res = await fetch(`/api/documents/${id}/pdf${revision === undefined ? '' : '?rev=' + revision}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`)
    return res.blob()
  },
}
