import { PlanSlotSchema } from '../core/care-plan-slot.ts'
import { pendingLocationSchema } from '../core/diagram/evidence.ts'
import { diagramSchema, diagramKinds, diagramChatFields } from '../core/diagram/fields.ts'
import { chatError } from '../core/chat-error.ts'
import { formKeys } from '../core/binding.ts'
// api の道（Hono）。入口はそれぞれ操作を 1 つ宣言し、宣言に合わせて確かめる（docs/再設計/14_認可.md）。
//   職員の入口（/api/...。責任者の入口は /api/office/...）: staffRoute。誰か（401）→ どの事業所か（行の office_id。404）→ 操作を許すか（403）
//   サイト管理者の入口（/api/admin/...）: siteRoute。site_admins にいなければ 403
//   ログインなしの入口: openRoute（health と、ローカルの置き場だけの、署名で確かめる入口）
// worker の道（/tasks/*）はここには置かない（worker/app.ts）。
import * as documentInputs from '../db/document-inputs.ts'
import { documentInputPath } from '../core/document-input.ts'
import { Hono, type Context, type Handler } from 'hono'
import { z } from 'zod'
import { importPdfPath, pageImageAssetPath, type FormAssetsView } from '../core/form.ts'
import { SURVEY_IMPORT_KEYS, surveyChoice } from '../core/survey-import.ts'
import * as importsDb from '../db/form-imports.ts'
import * as inspections from '../db/inspections.ts'
import { DEFAULT_CHECK_SET } from '../core/checks/index.ts'
import * as forms from '../db/forms.ts'
import * as carePlans from '../db/care-plans.ts'
import { tx, type Db } from '../db/pool.ts'
import * as repo from '../db/repo.ts'
import * as staffDb from '../db/staff.ts'
import * as kinds from '../db/kinds.ts'
import { defaultAccounts, type Accounts, type Verifier } from './auth.ts'
import { fakeModel, runChat, type ChatDocument, type ChatModel } from './chat.ts'
import { FormUnavailable, makePdf } from './pdf.ts'
import { PdfOverflow } from './pdf-layout.ts'
import { previewPdf, publishProblems } from './form-check.ts'
import { checkDraftVersion } from '../worker/form-import/check.ts'
import { BindingSchema, FormPageSchema, LocalFieldSchema, PdfmeSlotSchema } from '../worker/form-import/contract.ts'
import type { LocalField } from '../worker/form-import/draft.ts'
import { allows, operationsOf, STAFF_ROLES, type Operation } from './permissions.ts'
import type { Queue } from './queue.ts'
import { editSlot } from './form-slots.ts'
import { fakeFieldMatcher, slotMeaning, type FieldMatcher } from '../core/slot-meaning.ts'
import { fieldDict } from '../core/dictionary.ts'
import { fakeTopicDrafter, type TopicDrafter } from '../core/topics.ts'
import { dailyWindow, LocalStorage, type Storage } from './storage.ts'
import { randomUUID } from 'node:crypto'
import type { AuditContext } from '../db/audit.ts'

export interface ApiDeps {
  db: () => Promise<Db>
  verifier: () => Verifier
  storage: () => Storage
  queue: () => Queue
  /** 書き方の相談のエージェントが使う Gemini。なければ試しの答え（fake） */
  chat?: () => Promise<ChatModel>
  /** ケアプランの AI 原案。なければ試しの原案（fake） */
  carePlanAi?: () => Promise<carePlans.CarePlanDrafter>
  /** 責任者の言葉を欄に当てはめる（様式の下書きを直す）。なければ試しの当てはめ（fake） */
  fieldMatcher?: () => Promise<FieldMatcher>
  /** 事業所が足した書類の拾う内容の案を作る（#153）。省けば試しの案 */
  topicDrafter?: () => Promise<TopicDrafter>
  /** AUTH_MODE=dev のとき、メールでケアマネを引く */
  devAuth?: boolean
  /** 職員を登録するときにアカウントを作る（なければ AUTH_MODE で決める） */
  accounts?: () => Accounts
}

const ClientInput = z.object({ name: z.string().trim().min(1).max(60), sex: z.enum(['男', '女']).nullish(), status: z.enum(['在宅', '入院中', '入所中']).optional() })
// base: 画面がこの直しの元にした値（null は空）。サーバーの今の値と違えば 409
const PatchInput = z.object({ changes: z.array(z.object({ key: z.string().min(1).max(200), value: z.unknown(), base: z.unknown(), mode: z.enum(['edit', 'revert']).optional() })).min(1).max(200) })
const SurveyImportInput = z.object({
  fileName: z.string().trim().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  recordedOn: z.iso.date().nullable(),
  changes: z.array(z.object({
    key: z.enum(SURVEY_IMPORT_KEYS), choice: z.number().int().min(1).max(4), base: z.unknown(),
  })).min(1).max(SURVEY_IMPORT_KEYS.length),
})
const EditsInput = z.object({ formVersionId: z.string().uuid(), edits: z.array(z.object({ slot: z.string().min(1).max(200), text: z.string().max(20000) })).min(1).max(200) })
const SaveInput = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('document') }),
  z.object({ scope: z.literal('page'), page: z.number().int().min(1).max(20) }),
  z.object({ scope: z.literal('hunk'), key: z.string().min(1), hunkIndex: z.number().int().min(0) }),
])
// ケアプラン（#90）。日付は YYYY-MM-DD、期間の前後はリポジトリで確かめる
const CarePlanInput = z.object({
  effectiveFrom: z.iso.date(),
  effectiveTo: z.iso.date().nullish(),
  copyFromPlanId: z.string().uuid().nullish(),
})
const PlanPeriod = {
  periodText: z.string().trim().max(200).nullish(),
  periodFrom: z.iso.date().nullish(),
  periodTo: z.iso.date().nullish(),
}
const PlanServiceInput = z.object({
  id: z.string().uuid().optional(),
  content: z.string().trim().min(1).max(500),
  insured: z.boolean().optional(),
  kind: z.string().trim().max(100).nullish(),
  provider: z.string().trim().max(200).nullish(),
  frequency: z.string().trim().max(100).nullish(),
  ...PlanPeriod,
})
const PlanShortGoalInput = z.object({
  id: z.string().uuid().optional(),
  goal: z.string().trim().min(1).max(500),
  ...PlanPeriod,
  services: z.array(PlanServiceInput).max(50).optional(),
})
const PlanNeedInput = z.object({
  id: z.string().uuid().optional(),
  need: z.string().trim().min(1).max(1000),
  longGoal: z.object({
    id: z.string().uuid().optional(),
    goal: z.string().trim().min(1).max(1000),
    ...PlanPeriod,
  }),
  shortGoals: z.array(PlanShortGoalInput).max(50).optional(),
})
const PlanNeedsInput = z.object({
  baseVersion: z.number().int().positive(),
  needs: z.array(PlanNeedInput).max(50),
})
const PlanSaveInput = z.object({ baseVersion: z.number().int().positive() })
const PlanScheduleInput = z.object({
  baseVersion: z.number().int().positive(),
  slots: z.array(PlanSlotSchema).max(500),
})
const PlanAiDraftInput = z.object({
  sourceDocumentId: z.string().uuid(),
  sourceRevisionId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]),
})
const PlanAiApplyInput = z.object({
  baseVersion: z.number().int().positive(),
  acceptedProposalIds: z.array(z.string().max(200)).max(200).optional(),
})
const RecordingInput = z.object({
  mime: z.string().min(1).max(100),
  // 録音を始めた書類。省いたときは主な書類
  documentId: z.string().uuid().optional(),
  deviceRecordingId: z.string().uuid().optional(),
  expiredUploadUrl: z.string().max(4096).optional(),
})
// 書き方の相談。やり取りは画面が持っていて、毎回全部を送る（最後はケアマネの相談）
const InspectionInput = z.object({ checkSet: z.string().min(1).max(100).optional() })
const ChatInput = z.object({
  diagramField: z.enum(diagramChatFields).optional(),
  draft: z.object({ key: z.enum(['family.genogram', 'health.bodyMap']), after: z.unknown(), pendingLocations: z.array(pendingLocationSchema).max(100).optional() }).optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'pet']), text: z.string().trim().min(1).max(4000) })).min(1).max(40)
    .refine((m) => m.at(-1)?.role === 'user'),
})
const CompleteInput = z.object({ durationMs: z.number().int().min(0).nullish(), bytes: z.number().int().positive().optional() })
// 職員・最初の責任者を登録する。メールは小文字にそろえる（Identity Platform のメールは大文字・小文字を区別しない）
const Email = z.string().trim().toLowerCase().max(254).pipe(z.email())
const Name = z.string().trim().min(1).max(60)
const StaffInput = z.object({ name: Name, email: Email, role: z.enum(STAFF_ROLES) })
const OfficeInput = z.object({
  name: z.string().trim().min(1).max(100), phone: z.string().trim().max(30).nullish(), fax: z.string().trim().max(30).nullish(),
  admin: z.object({ name: Name, email: Email }),
})
// 責任者が職員を止める・戻す・役割を変える
const StaffPatchInput = z.object({ role: z.enum(STAFF_ROLES).optional(), disabled: z.boolean().optional() })
  .refine((v) => v.role !== undefined || v.disabled !== undefined)

// 様式の取り込み: 何の書類の用紙か
const ImportInput = z.object({ kind: z.string().trim().min(1).max(100) })
// 事業所の書類を足す（#153）。手順 1「書類について」の答え
const OfficeKindInput = z.object({
  name: z.string().trim().min(1).max(40),
  perClient: z.enum(['one', 'many']),
  copyFromPrimary: z.boolean(),
  records: z.boolean(),
  append: z.boolean(),
})
const OfficeTopicsInput = z.object({
  topics: z.array(z.object({ id: z.string().max(41).optional(), name: z.string().trim().min(1).max(40), guide: z.string().trim().max(400) })).max(30),
})
const TopicDraftRequest = z.object({ versionId: z.string().uuid() })
// 様式の下書きを直す。base は画面が元にした版の中身の指紋（content_sha）。直す部分だけを送る
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const FormVersionPatch = z.object({
  base: Sha256,
  schemas: z.array(z.array(PdfmeSlotSchema)).max(100).optional(),
  bindings: z.record(z.string(), BindingSchema).optional(),
  pages: z.array(FormPageSchema).min(1).max(100).optional(),
  localFields: z.array(LocalFieldSchema).optional(),
}).refine((v) => v.schemas || v.bindings || v.pages || v.localFields)
const PublishInput = z.object({ base: Sha256 })
// 印字欄を言葉で直す（ここに何が入るか）か、使っていないことにする
const SlotEditInput = z.union([
  z.object({ base: Sha256, text: z.string().trim().min(1).max(200) }),
  z.object({ base: Sha256, unused: z.literal(true) }),
])

/** 入口の宣言: 操作、またはログインなし（public） */
export type Declared = Operation | 'public'
const DECLARED = Symbol('declared')
const declare = <H extends Handler>(declared: Declared, handler: H): H => Object.assign(handler, { [DECLARED]: declared })

/** /api/ の入口と、その宣言（宣言のない入口は undefined。テストで落とす） */
export function routeDeclarations(app: Hono): { method: string, path: string, declared: Declared | undefined }[] {
  return app.routes
    .filter((r) => r.path.startsWith('/api/'))
    .map((r) => ({ method: r.method, path: r.path, declared: (r.handler as { [DECLARED]?: Declared })[DECLARED] }))
}

const json = (c: Context, body: unknown, status = 200) => c.json(body as object, status as 200)

/** 置き場にあるかの覚え（様式の置き場は上書きも削除もしないので、あったものはずっとある。ないものは毎回見る） */
const present = new Set<string>()
async function exists(storage: Storage, path: string): Promise<boolean> {
  if (present.has(path)) return true
  const ok = (await storage.size('forms', path).catch(() => null)) !== null
  if (ok) present.add(path)
  return ok
}

export function createApp(deps: ApiDeps) {
  const app = new Hono()
  const accounts = deps.accounts ?? (() => defaultAccounts())
  const auditContexts = new WeakMap<object, AuditContext>()

  const auditContextOf = (c: Context): AuditContext => auditContexts.get(c) ?? {
    requestId: randomUUID(),
    correlationId: randomUUID(),
    traceId: c.req.header('x-cloud-trace-context')?.split('/')[0],
    route: c.req.path,
    source: 'api',
  }

  app.use('*', async (c, next) => {
    const auditContext: AuditContext = {
      requestId: randomUUID(),
      correlationId: randomUUID(),
      traceId: c.req.header('x-cloud-trace-context')?.split('/')[0],
      route: c.req.path,
      source: 'api',
    }
    auditContexts.set(c, auditContext)
    c.header('X-Request-Id', auditContext.requestId!)
    await next()
    // 様式の版のように、ブラウザが覚えてよいものは道の中で決める。それ以外は覚えさせない
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
  })

  /** ログインなしの入口 */
  const openRoute = (handler: Handler) => declare('public', handler)

  app.all('/api/health.json', openRoute((c) => {
    if (c.req.method !== 'GET') {
      c.header('Allow', 'GET')
      return json(c, { error: 'method_not_allowed' }, 405)
    }
    return json(c, { status: 'ok', source: 'api' })
  }))

  /** ID トークンを確かめる。なければ・違えば null */
  const login = async (c: Context) => {
    const header = c.req.header('Authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    return token ? deps.verifier().verify(token) : null
  }
  const unauthorized = (c: Context) => json(c, { error: 'unauthorized' }, 401)
  const forbidden = (c: Context) => json(c, { error: 'forbidden' }, 403)

  /**
   * 職員の入口。1. 誰か: staff にいて止めていない（401）。3. 操作を許すか: 役割が宣言した操作を許す（403）。
   * 2. どの事業所か は handler が行の office_id を staff.officeId で絞って確かめる（ほかの事業所は 404。リクエストの値は使わない）
   */
  const staffRoute = (op: Exclude<Operation, 'site.manage'>, handler: (c: Context, staff: repo.Staff, db: Db) => Promise<Response>) =>
    declare(op, async (c: Context) => {
      const user = await login(c)
      if (!user) return unauthorized(c)
      const db = await deps.db()
      const staff = await repo.staffByAuth(db, user.uid, user.email, deps.devAuth, auditContextOf(c))
      if (!staff) return unauthorized(c)
      if (!allows(staff.role, op)) return forbidden(c)
      return handler(c, staff, db)
    })

  /** サイト管理者の入口（/api/admin/...）。site_admins にいなければ 403。利用者の情報を持つ表は読まない */
  const siteRoute = (handler: (c: Context, admin: staffDb.SiteAdmin, db: Db) => Promise<Response>) =>
    declare('site.manage', async (c: Context) => {
      const user = await login(c)
      if (!user) return unauthorized(c)
      const db = await deps.db()
      const admin = await staffDb.siteAdminByAuth(db, user.uid)
      if (!admin) return forbidden(c)
      return handler(c, admin, db)
    })

  const body = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) throw new repo.BadRequest('入力の形が違います')
    return parsed.data
  }

  app.get('/api/me', staffRoute('care.work', async (c, staff) => json(c, { staff: { ...staff, operations: operationsOf(staff.role) } })))

  app.get('/api/clients', staffRoute('care.work', async (c, staff, db) => {
    const sort = c.req.query('sort') === 'name' ? 'name' : 'updated'
    return json(c, { clients: await repo.listClients(db, staff.officeId, { q: c.req.query('q'), sort }) })
  }))

  app.post('/api/clients', staffRoute('care.work', async (c, staff, db) => json(c, await repo.createClient(db, staff, await body(c, ClientInput)), 201)))

  app.get('/api/clients/:id', staffRoute('care.work', async (c, staff, db) => json(c, {
    client: await repo.getClient(db, staff.officeId, c.req.param('id')!),
    jobs: await repo.activeJobs(db, staff.officeId, c.req.param('id')!),
  })))

  // 書類の種類（form_kinds）と、その事業所で書類を作れるか。作業画面のタブと「＋ 書類を作る」が使う
  app.get('/api/form-kinds', staffRoute('care.work', async (c, staff, db) => json(c, { kinds: await kinds.kindsForOffice(db, staff.officeId) })))

  // ---------- ケアプラン（#90）----------

  app.get('/api/clients/:clientId/care-plans', staffRoute('care.work', async (c, staff, db) =>
    json(c, { plans: await carePlans.listClientCarePlans(db, staff.officeId, c.req.param('clientId')!) })))

  app.post('/api/clients/:clientId/care-plans', staffRoute('care.work', async (c, staff, db) => {
    const input = await body(c, CarePlanInput)
    const plan = await carePlans.createCarePlan(db, staff, c.req.param('clientId')!, {
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      copyFromPlanId: input.copyFromPlanId ?? null,
    })
    return json(c, { plan }, 201)
  }))

  app.get('/api/care-plans/:planId', staffRoute('care.work', async (c, staff, db) =>
    json(c, { plan: await carePlans.getCarePlan(db, staff.officeId, c.req.param('planId')!) })))

  app.put('/api/care-plans/:planId/needs', staffRoute('care.work', async (c, staff, db) => {
    const input = await body(c, PlanNeedsInput)
    const plan = await carePlans.saveCarePlanNeeds(db, staff, c.req.param('planId')!, input.baseVersion, input.needs)
    return json(c, { plan })
  }))

  app.put('/api/care-plans/:planId/schedule', staffRoute('care.work', async (c, staff, db) => {
    const input = await body(c, PlanScheduleInput)
    return c.json({ plan: await carePlans.saveCarePlanSchedule(db, staff, c.req.param('planId')!, input.baseVersion, input.slots) })
  }))

  app.post('/api/care-plans/:planId/confirm', staffRoute('care.work', async (c, staff, db) => {
    const input = await body(c, PlanSaveInput)
    return c.json(await carePlans.confirmCarePlan(db, staff, c.req.param('planId')!, input.baseVersion))
  }))

  app.get('/api/care-plans/:planId/pdf', staffRoute('care.work', async (c, staff, db) => {
    const { clientId, sources } = await carePlans.carePlanPdfSources(db, staff, c.req.param('planId')!)
    const selection = c.req.query('form') ?? 'all'
    if (!['all', '1', '2', '3'].includes(selection)) throw new repo.BadRequest('form は 1・2・3・all です')
    const selected = sources.filter((s) => selection === 'all' || String(s.formNo) === selection)
    const pdfs: Uint8Array[] = []
    for (const source of selected) {
      const version = await forms.loadVersion(db, source.formVersionId)
      pdfs.push(await makePdf(deps.storage(), version, source.values))
    }
    const { PDFDocument } = await import('@pdfme/pdf-lib')
    const combined = await PDFDocument.create({ updateMetadata: false })
    for (const bytes of pdfs) {
      const pdf = await PDFDocument.load(bytes)
      for (const page of await combined.copyPages(pdf, pdf.getPageIndices())) combined.addPage(page)
    }
    const bytes = new Uint8Array(await combined.save())
    await repo.audit(db, staff, staff.officeId, 'care_plan.pdf', { clientId }, {
      planId: c.req.param('planId'), form: selection, revisions: selected.map((s) => ({ formNo: s.formNo, rev: s.rev })),
    })
    return new Response(new Blob([bytes], { type: 'application/pdf' }), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="care-plan-${selection}.pdf"`,
        'Cache-Control': 'no-store',
      },
    })
  }))

  app.post('/api/care-plans/:planId/save', staffRoute('care.work', async (c, staff, db) => {
    const { baseVersion } = await body(c, PlanSaveInput)
    return json(c, await carePlans.saveCarePlan(db, staff, c.req.param('planId')!, baseVersion))
  }))

  app.post('/api/care-plans/:planId/ai-drafts', staffRoute('care.work', async (c, staff, db) => {
    const { sourceDocumentId, sourceRevisionId } = await body(c, PlanAiDraftInput)
    const drafter = deps.carePlanAi ? await deps.carePlanAi() : (await import('./care-plan-ai.ts')).fakeCarePlanDrafter
    const draft = await carePlans.createCarePlanAiDraft(db, staff, c.req.param('planId')!, sourceDocumentId, sourceRevisionId, drafter)
    return json(c, { draft }, 201)
  }))

  app.get('/api/care-plans/:planId/ai-drafts/:draftId', staffRoute('care.work', async (c, staff, db) =>
    json(c, { draft: await carePlans.getCarePlanAiDraft(db, staff.officeId, c.req.param('planId')!, c.req.param('draftId')!) })))

  app.post('/api/care-plans/:planId/ai-drafts/:draftId/apply', staffRoute('care.work', async (c, staff, db) => {
    const { baseVersion } = await body(c, PlanAiApplyInput)
    return json(c, await carePlans.applyCarePlanAiDraft(db, staff, c.req.param('planId')!, c.req.param('draftId')!, baseVersion))
  }))

  // 書類を作る（どの種類も同じ流れ。db/repo.ts の createDocument）。1 人 1 通の種類で、もうあれば今の書類を返す（200）
  app.post('/api/clients/:id/documents', staffRoute('care.work', async (c, staff, db) => {
    const { kind } = await body(c, z.object({ kind: z.string().trim().min(1).max(100) }))
    const r = await repo.createDocument(db, staff, c.req.param('id')!, kind)
    return json(c, r, r.created ? 201 : 200)
  }))

  // 様式の版（欄の位置・対応・ページ）。中身は変わらないので、ブラウザが覚えてよい
  app.get('/api/form-versions/:id', staffRoute('care.work', async (c, staff, db) => {
    const v = await forms.versionForOffice(db, staff.officeId, c.req.param('id')!)
    const etag = `"${v.contentSha}"`
    c.header('ETag', etag)
    c.header('Cache-Control', 'private, max-age=31536000, immutable')
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304)
    return json(c, { formVersion: forms.viewOf(v) })
  }))

  /** ページの画像の期限つきの URL（1 日の区切りでそろえるので、同じ日は同じ URL）と、元の PDF があるか */
  const assetsOf = async (v: forms.FormVersion): Promise<FormAssetsView> => {
    const storage = deps.storage()
    const window = dailyWindow()
    const pages = await Promise.all(v.pages.map(async (p) => {
      const path = pageImageAssetPath(v.basePdfSha256, p.pdfIndex + 1, v.officeId)
      return { no: p.no, url: await exists(storage, path) ? await storage.signedReadUrl('forms', path, window) : null }
    }))
    return { pages, hasPdf: await exists(storage, forms.basePdfPath(v)), expiresAt: window.until.toISOString() }
  }

  app.get('/api/form-versions/:id/assets', staffRoute('care.work', async (c, staff, db) =>
    json(c, await assetsOf(await forms.versionForOffice(db, staff.officeId, c.req.param('id')!)))))

  app.get('/api/documents/:id', staffRoute('care.work', async (c, staff, db) => json(c, { document: await repo.getDocument(db, staff.officeId, c.req.param('id')!) })))

  app.get('/api/documents/:id/revisions', staffRoute('care.work', async (c, staff, db) => {
    const document = await repo.getDocument(db, staff.officeId, c.req.param('id')!)
    const rows = await db.query('SELECT id, rev, saved_at FROM revisions WHERE document_id = $1 ORDER BY rev DESC', [document.id])
    return json(c, { revisions: rows.rows.map((r) => ({ id: Number(r.id), rev: Number(r.rev), savedAt: new Date(r.saved_at).toISOString() })) })
  }))

  app.patch('/api/documents/:id/fields', staffRoute('care.work', async (c, staff, db) => {
    const { changes } = await body(c, PatchInput)
    // 欄と値の型は、書類の様式の版の欄の辞書で確かめる（repo.patchFields）
    await carePlans.assertGenericDocumentEdits(db, staff.officeId, c.req.param('id')!, changes.map((ch) => ch.key))
    const r = await repo.patchFields(db, staff, c.req.param('id')!, changes.map((ch) => ({ key: ch.key, value: ch.value ?? null, base: ch.base ?? null, mode: ch.mode })))
    return json(c, { ...r, document: await repo.getDocument(db, staff.officeId, c.req.param('id')!) })
  }))

  // 書き方の相談。AI が道具（用紙を読む・足りない欄・録音を探す・書き換えの案）を使って答える。同じ利用者のほかの書類も読める。用紙は変えない
  app.post('/api/documents/:id/chat', staffRoute('care.work', async (c, staff, db) => {
    const { messages, draft, diagramField } = await body(c, ChatInput)
    if (diagramField && draft && draft.key !== diagramField) throw new repo.BadRequest('相談対象の図と修正対象の案が一致しません')
    if (draft) { const value = diagramSchema.safeParse(draft.after); if (!value.success || value.data.kind !== diagramKinds[draft.key]) throw new repo.BadRequest('図案の形が正しくありません') }
    // 道具は、書類の種類（名前・必須の欄）と様式の版（読む欄・印字欄の対応・その様式だけの欄）から読む
    const asChat = async (d: repo.DocumentView): Promise<ChatDocument & repo.DocumentView> => {
      const kind = await kinds.kindOf(db, d.kind)
      return { ...d, name: kind?.name ?? d.kind, required: kind?.required ?? [], form: await forms.loadFormDef(db, d.formVersionId) }
    }
    const document = await asChat(await repo.getDocument(db, staff.officeId, c.req.param('id')!))
    document.editableKeys = document.form.keys
    if (diagramField && !document.editableKeys.includes(diagramField)) throw new repo.BadRequest('この書類に対象の図欄がありません')

    const recordings = await repo.clientTranscripts(db, staff.officeId, document.clientId)
    const others = await Promise.all((await repo.otherDocuments(db, staff.officeId, document.clientId, document.id)).map(asChat))
    const model = deps.chat ? await deps.chat() : fakeModel
    // 答えは 1 行 1 つの JSON（NDJSON）。道具を使うたびに {type:'step'} を流し、最後に {type:'done', reply, steps, proposals}。
    // 途中で失敗したら {type:'error'}（状態はもう 200 なので）。間の置き場がまとめて返しても、画面は最後に全部出すだけで壊れない
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(ctl) {
        const send = (o: object) => ctl.enqueue(enc.encode(`${JSON.stringify(o)}\n`))
        try {
          const r = await runChat({ model, document, others, recordings, messages, draft, diagramField, onStep: (text) => send({ type: 'step', text }) })
          send({ type: 'done', ...r })
        } catch (e) {
          console.error(JSON.stringify({ severity: 'ERROR', msg: 'api error', path: c.req.routePath, request_id: auditContextOf(c).requestId, error: (e as Error)?.name ?? 'Error' }))
          send({ type: 'error', code: chatError(e).code })
        }
        ctl.close()
      },
    })
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } })
  }))

  app.post('/api/documents/:id/inputs', staffRoute('care.work', async (c, staff, db) => {
    const r = await documentInputs.startInput(db, staff, c.req.param('id')!, await body(c, documentInputs.DocumentUploadInput), deps.storage(), c.req.header('Origin'))
    return json(c, r, 201)
  }))
  app.get('/api/documents/:id/inputs', staffRoute('care.work', async (c, staff, db) =>
    json(c, { inputs: await documentInputs.listInputs(db, staff, c.req.param('id')!) })))
  app.get('/api/document-inputs/:id', staffRoute('care.work', async (c, staff, db) =>
    json(c, { input: await documentInputs.inputView(db, staff, c.req.param('id')!) })))
  app.post('/api/document-inputs/:id/complete', staffRoute('care.work', async (c, staff, db) => {
    const id = c.req.param('id')!
    const queue = deps.queue()
    if (!queue.enqueueDocumentInput) throw new repo.BadRequest('書類読取を設定してください')
    await documentInputs.completeInput(db, staff, id, deps.storage())
    const input = await documentInputs.inputView(db, staff, id)
    if (input.status === 'queued') await queue.enqueueDocumentInput(id, { initial: true })
    return json(c, { input }, 202)
  }))
  app.post('/api/document-inputs/:id/retry', staffRoute('care.work', async (c, staff, db) => {
    const id = c.req.param('id')!
    const queue = deps.queue()
    if (!queue.enqueueDocumentInput) throw new repo.BadRequest('書類読取を設定してください')
    await documentInputs.retryInput(db, staff, id)
    await queue.enqueueDocumentInput(id)
    return json(c, { input: await documentInputs.inputView(db, staff, id) }, 202)
  }))
  app.get('/api/document-inputs/:id/original', staffRoute('care.work', async (c, staff, db) => {
    const r = await documentInputs.getInput(db, staff.officeId, c.req.param('id')!)
    const data = await deps.storage().read('source', documentInputPath(staff.officeId, r.client_id, r.id, r.upload_generation))
    return new Response(new Blob([new Uint8Array(data)], { type: r.mime }), { headers: {
      'Content-Type': r.mime, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(r.file_name)}`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox",
    } })
  }))
  app.post('/api/document-inputs/:id/adopt', staffRoute('care.work', async (c, staff, db) => {
    const input = await body(c, z.object({ targetConfirmed: z.literal(true), changes: z.array(z.object({ key: z.string().min(1).max(200), value: z.unknown().optional(), base: z.unknown() })).min(1).max(200) }))
    if (new Set(input.changes.map((ch) => ch.key)).size !== input.changes.length) throw new repo.BadRequest('同じ欄が重複しています')
    const document = await documentInputs.adoptInput(db, staff, c.req.param('id')!, input.changes)
    return json(c, { document })
  }))

  app.post('/api/documents/:id/survey-import', staffRoute('care.work', async (c, staff, db) => {
    const { fileName, sha256, recordedOn, changes } = await body(c, SurveyImportInput)
    if (new Set(changes.map((ch) => ch.key)).size !== changes.length) throw new repo.BadRequest('同じ欄が重複しています')
    const id = c.req.param('id')!
    await repo.patchFields(db, staff, id, changes.map(({ key, choice, base }) => {
      const value = surveyChoice(key, choice)
      if (value === undefined) throw new repo.BadRequest('認定調査票の選択肢が不正です')
      return { key, value, base, surveySource: { kind: 'survey-import', fileName, sha256, recordedOn, page: 2, choice } }
    }))
    return json(c, { document: await repo.getDocument(db, staff.officeId, id) })
  }))

  // 用紙の印字欄の直し。サーバーがその時点の値に当てる（当てられない直しは理由を返す）
  app.post('/api/documents/:id/edits', staffRoute('care.work', async (c, staff, db) => {
    const { formVersionId, edits } = await body(c, EditsInput)
    // 氏名・作成日などは各表で独立して編集できる。構造の射影だけは計画APIに限定する。
    const r = await repo.applySlotEdits(db, staff, c.req.param('id')!, formVersionId, edits,
      (locked, keys) => carePlans.assertGenericDocumentEdits(locked, staff.officeId, c.req.param('id')!, keys))
    return json(c, { ...r, document: await repo.getDocument(db, staff.officeId, c.req.param('id')!) })
  }))

  app.post('/api/documents/:id/save', staffRoute('care.work', async (c, staff, db) => {
    await carePlans.assertGenericDocumentSave(db, staff.officeId, c.req.param('id')!)
    const r = await repo.saveDocument(db, staff, c.req.param('id')!, await body(c, SaveInput))
    return json(c, { ...r, document: await repo.getDocument(db, staff.officeId, c.req.param('id')!) })
  }))

  app.get('/api/documents/:id/pdf', staffRoute('care.work', async (c, staff, db) => {
    const doc = await repo.getDocument(db, staff.officeId, c.req.param('id')!)
    const rev = await repo.latestRevision(db, staff.officeId, doc.id)
    const version = await forms.loadVersion(db, rev.formVersionId)
    const pdf = await makePdf(deps.storage(), version, rev.values)
    const path = `exports/${staff.officeId}/${doc.id}/rev${rev.rev}-${Date.now()}.pdf`
    let stored: string | null = path
    try {
      await deps.storage().write('output', path, pdf, 'application/pdf')
    } catch {
      stored = null // 出力の置き場に書けなくても、PDF は返す
    }
    await repo.recordExport(db, staff, doc.id, rev.rev, version.id, stored)
    return new Response(new Blob([pdf], { type: 'application/pdf' }), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${version.name}_v${rev.rev}.pdf`)}`,
        'Cache-Control': 'no-store',
      },
    })
  }))

  const startRecording = staffRoute('care.work', async (c, staff, db) => {
    const { mime, deviceRecordingId, expiredUploadUrl, documentId } = await body(c, RecordingInput)
    const result = await tx(db, async (conn) => {
      const rec = await repo.createRecording(conn, staff, c.req.param('id')!, mime, deviceRecordingId, documentId)
      const storage = deps.storage()
      let uploadUrl = rec.uploadUrl
      if (rec.status === 'uploaded' || (uploadUrl && await storage.size('source', rec.objectPath))) {
        uploadUrl = null
      } else if (!uploadUrl || uploadUrl === expiredUploadUrl) {
        uploadUrl = await storage.createUploadSession('source', rec.objectPath, rec.mime, c.req.header('Origin') ?? undefined)
        await repo.setRecordingUploadUrl(conn, rec.id, uploadUrl)
      }
      return { recordingId: rec.id, uploadUrl }
    })
    return json(c, result, 201)
  })
  app.post('/api/clients/:id/recordings', startRecording)
  // 新しい画面が古い API に当たっても、再送のたびに別の録音を作らないよう別の道を使う。
  app.post('/api/clients/:id/recordings/resumable', startRecording)

  app.post('/api/recordings/:id/complete', staffRoute('care.work', async (c, staff, db) => {
    const { durationMs, bytes } = await body(c, CompleteInput)
    const jobId = await repo.completeRecording(db, staff, c.req.param('id')!, durationMs ?? null, bytes,
      (path) => deps.storage().size('source', path))
    if (!jobId) return json(c, { error: 'not_uploaded' }, 409)
    const job = await repo.dispatchRecordingJob(db, jobId, () => deps.queue().enqueue(jobId, { initial: true }))
    return json(c, job, 202)
  }))

  // AI 点検（#113）。書類の値を読むだけで、値は変えない。点検は裏の仕事（worker）
  app.post('/api/clients/:id/inspections', staffRoute('care.work', async (c, staff, db) => {
    const { checkSet } = await body(c, InspectionInput)
    const r = await inspections.createInspection(db, staff, c.req.param('id')!, checkSet ?? DEFAULT_CHECK_SET)
    if (r.created) await deps.queue().enqueueInspection(r.id, { initial: true })
    return json(c, { inspectionId: r.id }, 202)
  }))
  app.get('/api/clients/:id/inspections', staffRoute('care.work', async (c, staff, db) =>
    json(c, { inspections: await inspections.listInspections(db, staff.officeId, c.req.param('id')!) })))
  app.get('/api/inspections/:id', staffRoute('care.work', async (c, staff, db) =>
    json(c, { inspection: await inspections.getInspection(db, staff.officeId, c.req.param('id')!) })))

  app.get('/api/clients/:id/jobs', staffRoute('care.work', async (c, staff, db) => json(c, { jobs: await repo.activeJobs(db, staff.officeId, c.req.param('id')!) })))

  // ---------- 職員の管理（責任者） ----------

  app.get('/api/office/staff', staffRoute('staff.manage', async (c, staff, db) => json(c, { staff: await staffDb.listStaff(db, staff.officeId) })))

  // 職員を登録する。アカウント（Identity Platform）がなければ作る。本人は、パスワードを決めるメール（画面が送る）から決める
  app.post('/api/office/staff', staffRoute('staff.manage', async (c, staff, db) => {
    const input = await body(c, StaffInput)
    const account = await accounts().ensureUser(input.email, input.name)
    const member = await staffDb.createStaff(db, staff, { ...input, authUid: account.uid })
    return json(c, { staff: member, accountCreated: account.created }, 201)
  }))

  app.patch('/api/office/staff/:id', staffRoute('staff.manage', async (c, staff, db) =>
    json(c, { staff: await staffDb.updateStaff(db, staff, c.req.param('id')!, await body(c, StaffPatchInput)) })))

  // ---------- サイト管理者 ----------

  app.get('/api/admin/me', siteRoute(async (c, admin) => json(c, { siteAdmin: { name: admin.name, email: admin.email } })))

  app.get('/api/admin/offices', siteRoute(async (c, _admin, db) => json(c, { offices: await staffDb.listOffices(db) })))

  // 事業所と、その最初の責任者を登録する。責任者のアカウント（Identity Platform）がなければ作る
  app.post('/api/admin/offices', siteRoute(async (c, _admin, db) => {
    const input = await body(c, OfficeInput)
    const account = await accounts().ensureUser(input.admin.email, input.admin.name)
    const r = await staffDb.createOffice(db, { ...input, admin: { ...input.admin, authUid: account.uid } }, auditContextOf(c))
    return json(c, { ...r, accountCreated: account.created }, 201)
  }))

  // ---------- 様式の取り込み（上げた PDF → 下書きの版）。責任者は自分の事業所の様式、サイト管理者は全体の様式 ----------

  type ImportHandler = (c: Context, scope: importsDb.ImportScope, createdBy: string | null, db: Db) => Promise<Response>
  /** 責任者（/api/office/、form.manage）とサイト管理者（/api/admin/、site.manage）で同じ処理。どこの様式か（scope）だけが違う */
  const importRoutes = (prefix: '/api/office' | '/api/admin', guard: (h: ImportHandler) => Handler) => {
    // 取り込みを作り、PDF をブラウザから直接送る URL を返す（置き場は imports/<id>.pdf。中身は worker が確かめる）
    app.post(`${prefix}/form-imports`, guard(async (c, scope, createdBy, db) => {
      const { kind } = await body(c, ImportInput)
      const imp = await importsDb.createImport(db, scope, kind, createdBy)
      const uploadUrl = await deps.storage().createUploadSession('forms', importPdfPath(imp.id, scope.officeId), 'application/pdf', c.req.header('Origin') ?? undefined)
      return json(c, { import: imp, uploadUrl }, 201)
    }))
    app.get(`${prefix}/form-imports`, guard(async (c, scope, _by, db) => json(c, { imports: await importsDb.listImports(db, scope) })))
    app.get(`${prefix}/form-imports/:id`, guard(async (c, scope, _by, db) => json(c, { import: await importsDb.getImport(db, scope, c.req.param('id')!) })))
    // 送り終わり。置き場に届いたのを確かめて、変換を積む（何度呼んでもよい。積むのは待っている間だけ）
    app.post(`${prefix}/form-imports/:id/complete`, guard(async (c, scope, _by, db) => {
      const id = c.req.param('id')!
      const imp = await importsDb.markUploaded(db, scope, id, (path) => deps.storage().size('forms', path), importsDb.MAX_IMPORT_BYTES)
      if (!imp) return json(c, { error: 'not_uploaded' }, 409)
      if (imp.status === 'queued') await deps.queue().enqueueFormImport(id, { initial: true })
      return json(c, { import: imp }, 202)
    }))
  }
  importRoutes('/api/office', (h) => staffRoute('form.manage', (c, staff, db) => h(c, { officeId: staff.officeId }, staff.id, db)))
  importRoutes('/api/admin', (h) => siteRoute((c, _admin, db) => h(c, { officeId: null }, null, db)))

  // ---------- 様式の版（下書き）を確かめる・直す・捨てる・試し印字・公開する ----------
  // 責任者は自分の事業所の様式（全体の様式は読むだけ。変えようとすると 403）、サイト管理者は全体の様式。ほかの事業所の様式は 404。
  // 公開した版・退いた版は直せない（409）。下書きは直すたびに中身が変わるので、ブラウザに覚えさせない

  type VersionHandler = (c: Context, scope: forms.ManagerScope, db: Db) => Promise<Response>
  /** 責任者・サイト管理者に見せる版（置き場の場所は渡さない）と、公開前の確かめのうち印字しないで分かるもの */
  //   slots: 印字欄ごとの入る内容の言葉と、録音から AI が書くか（責任者には key を見せない）。review: 取り込みが迷った欄
  const managerView = async (db: Db, v: forms.FormVersion) => {
    const dict = fieldDict(v.localFields)
    return {
      formVersion: { ...forms.viewOf(v), status: v.status, global: v.officeId === null, localFields: v.localFields },
      problems: checkDraftVersion({ schemas: v.schemas as never, bindings: v.bindings, localFields: v.localFields as LocalField[] }),
      slots: Object.fromEntries(Object.entries(v.bindings).map(([n, b]) => [n, slotMeaning(b, dict, v.localFields)])),
      review: v.status === 'draft' ? await forms.reviewOf(db, v.id) : [],
    }
  }
  const versionRoutes = (prefix: '/api/office' | '/api/admin', guard: (h: VersionHandler) => Handler) => {
    app.get(`${prefix}/form-versions/:id`, guard(async (c, scope, db) => json(c, await managerView(db, await forms.versionForManager(db, scope, c.req.param('id')!)))))
    app.get(`${prefix}/form-versions/:id/assets`, guard(async (c, scope, db) => json(c, await assetsOf(await forms.versionForManager(db, scope, c.req.param('id')!)))))
    app.patch(`${prefix}/form-versions/:id`, guard(async (c, scope, db) => {
      const { base, ...patch } = await body(c, FormVersionPatch)
      return json(c, await managerView(db, await forms.updateDraft(db, scope, c.req.param('id')!, base, patch as forms.DraftPatch)))
    }))
    app.delete(`${prefix}/form-versions/:id`, guard(async (c, scope, db) => {
      await forms.deleteDraft(db, scope, c.req.param('id')!)
      return c.body(null, 204)
    }))
    // 試し印字: 架空の値（forms/samples の架空の利用者と、その様式だけの欄の型ごとの値）で印字した PDF
    app.post(`${prefix}/form-versions/:id/preview`, guard(async (c, scope, db) => {
      const v = await forms.versionForManager(db, scope, c.req.param('id')!)
      const pdf = await previewPdf(deps.storage(), v)
      return new Response(new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), {
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${v.name}_v${v.version}_試し印字.pdf`)}`, 'Cache-Control': 'no-store' },
      })
    }))
    // 公開: 確かめて、通れば公開する（その様式の今の版は退く）。通らなければ 422 と理由の一覧
    app.post(`${prefix}/form-versions/:id/publish`, guard(async (c, scope, db) => {
      const { base } = await body(c, PublishInput)
      const id = c.req.param('id')!
      const v = await forms.versionForManager(db, scope, id)
      if (v.officeId !== scope.officeId) throw new repo.Forbidden('全体の様式は変えられません')
      if (v.status !== 'draft') throw new forms.NotDraft(id)
      if (v.contentSha !== base) throw new repo.Conflict('form_version')
      const problems = await publishProblems(deps.storage(), v)
      if (problems.length) return json(c, { error: 'not_publishable', problems }, 422)
      return json(c, await managerView(db, await forms.publishDraft(db, scope, id, base)))
    }))
    // 印字欄を言葉で直す（AI が欄に当てはめる。当たらなければ、その様式だけの欄を作る）か、使っていないことにする（印字欄を消す）
    app.post(`${prefix}/form-versions/:id/slots/:slot`, guard(async (c, scope, db) => {
      const input = await body(c, SlotEditInput)
      const r = await editSlot(db, scope, c.req.param('id')!, c.req.param('slot')!, input, deps.fieldMatcher ?? (async () => fakeFieldMatcher))
      return json(c, { ...(await managerView(db, r.version)), matched: r.matched })
    }))
  }
  versionRoutes('/api/office', (h) => staffRoute('form.manage', (c, staff, db) => h(c, { officeId: staff.officeId }, db)))

  // ---------- 責任者が書類の種類を足す（#153）: 足す、拾う内容の案を作る・直す、やめる。自分の事業所の種類だけ（全体の種類は 403、ほかの事業所は 404） ----------
  app.post('/api/office/form-kinds', staffRoute('form.manage', async (c, staff, db) => {
    const input = await body(c, OfficeKindInput)
    return json(c, { kind: await kinds.createOfficeKind(db, staff.officeId, input) }, 201)
  }))
  app.put('/api/office/form-kinds/:key/topics', staffRoute('form.manage', async (c, staff, db) => {
    const { topics } = await body(c, OfficeTopicsInput)
    return json(c, { topics: await kinds.setOfficeTopics(db, staff.officeId, c.req.param('key')!, topics) })
  }))
  // 拾う内容の案: 確かめた書式（下書きか公開した版）の欄に入る内容から AI が作り、そのまま保存する（責任者はこのあと直す）
  app.post('/api/office/form-kinds/:key/topics/draft', staffRoute('form.manage', async (c, staff, db) => {
    const key = c.req.param('key')!
    const kind = await kinds.ownKind(db, staff.officeId, key)
    const { versionId } = await body(c, TopicDraftRequest)
    const v = await forms.versionForManager(db, { officeId: staff.officeId }, versionId)
    if (v.kind !== key) throw new repo.BadRequest('別の書類の書式です')
    const dict = fieldDict(v.localFields)
    // 文字の欄のうち、録音から書く欄（事業所の設定や日付だけの欄を除く）と、その様式だけの欄の、入る内容の言葉
    const slots = [...new Set(Object.values(v.bindings).flatMap((b) => {
      const m = slotMeaning(b, dict, v.localFields)
      return !m.mark && (m.rec || b.ref.key.startsWith('local.')) ? [m.what] : []
    }))]
    const drafted = await (await (deps.topicDrafter ?? (async () => fakeTopicDrafter))())({ kindName: kind.name, slots })
    return json(c, { topics: await kinds.setOfficeTopics(db, staff.officeId, key, drafted) })
  }))
  app.post('/api/office/form-kinds/:key/retire', staffRoute('form.manage', async (c, staff, db) => {
    await kinds.retireOfficeKind(db, staff.officeId, c.req.param('key')!)
    return json(c, { ok: true })
  }))

  // ---------- 責任者の書類の設定（#102）: 書類ごとの書式の様子、直す下書き、最初の書式に戻す、前の事業所の書式に戻す ----------
  app.get('/api/office/forms', staffRoute('form.manage', async (c, staff, db) => json(c, { kinds: await forms.officeFormStates(db, staff.officeId) })))
  app.post('/api/office/form-versions/:id/draft', staffRoute('form.manage', async (c, staff, db) => {
    const r = await forms.draftFrom(db, { officeId: staff.officeId }, c.req.param('id')!)
    return json(c, await managerView(db, r.version), r.created ? 201 : 200)
  }))
  app.post('/api/office/forms/:kind/revert', staffRoute('form.manage', async (c, staff, db) => {
    await forms.revertToGlobal(db, staff.officeId, staff.id, c.req.param('kind')!, repo.auditContextOf(staff))
    return json(c, { kinds: await forms.officeFormStates(db, staff.officeId) })
  }))
  app.post('/api/office/form-versions/:id/reuse', staffRoute('form.manage', async (c, staff, db) => {
    const version = await forms.reuseVersion(db, { officeId: staff.officeId }, staff.id, c.req.param('id')!, repo.auditContextOf(staff))
    return json(c, await managerView(db, version))
  }))
  versionRoutes('/api/admin', (h) => siteRoute((c, _admin, db) => h(c, { officeId: null }, db)))

  // ---------- 開発用（ローカルの置き場だけ。ログインの代わりに、置き場が出した期限つきの署名で確かめる。本番の置き場では 404） ----------

  // ブラウザからの送信を受ける（Cloud Storage の再開できる送信と同じ約束）
  app.put('/api/dev-upload/:token', openRoute(async (c) => {
    const storage = deps.storage()
    if (!(storage instanceof LocalStorage)) return json(c, { error: 'not_found' }, 404)
    const r = await storage.receive(c.req.param('token')!, c.req.header('Content-Range'), new Uint8Array(await c.req.arrayBuffer()))
    if (r.range) c.header('Range', r.range)
    return r.status === 308 ? new Response(null, { status: 308, headers: r.range ? { Range: r.range } : {} }) : json(c, {}, r.status)
  }))

  // 期限つきの URL で様式のファイルを渡す（Cloud Storage の署名つき URL と同じ約束）
  app.get('/api/dev-files/forms/*', openRoute(async (c) => {
    const storage = deps.storage()
    if (!(storage instanceof LocalStorage)) return json(c, { error: 'not_found' }, 404)
    const path = decodeURIComponent(c.req.path.slice('/api/dev-files/forms/'.length))
    const q = { from: c.req.query('from'), until: c.req.query('until'), sig: c.req.query('sig') }
    const data = await storage.readSigned('forms', path, q)
    if (!data) return json(c, { error: 'forbidden' }, 403)
    const left = Math.max(0, Number(q.until) - Math.floor(Date.now() / 1000))
    return new Response(new Blob([new Uint8Array(data)]), {
      headers: { 'Content-Type': path.endsWith('.png') ? 'image/png' : path.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream', 'Cache-Control': `private, max-age=${left}` },
    })
  }))

  app.notFound((c) => json(c, { error: 'not_found' }, 404))

  app.onError((err, c) => {
    if (err instanceof repo.NotFound || err instanceof forms.FormNotFound) return json(c, { error: 'not_found' }, 404)
    // ID の形でないもの（PostgreSQL の invalid_text_representation）も「無い」
    if ((err as { code?: string }).code === '22P02') return json(c, { error: 'not_found' }, 404)
    if (err instanceof repo.Forbidden) return json(c, { error: 'forbidden', message: err.message }, 403)
    if (err instanceof staffDb.AlreadyRegistered) return json(c, { error: 'already_registered', message: 'このメールアドレスは、もう登録されています' }, 409)
    if (err instanceof forms.NotDraft) return json(c, { error: 'not_draft', message: '公開した版・退いた版は直せません。PDF を上げ直して新しい下書きを作ってください' }, 409)
    if (err instanceof repo.Conflict) return json(c, { error: 'conflict', message: err.message === 'form_version' ? '様式の版が変わりました。読み直してください' : 'ほかの直し・AI の書き込みと重なりました。読み直してください' }, 409)
    if (err instanceof carePlans.PlanValidationFailed) return json(c, { error: 'validation_failed', problems: err.problems }, 422)
    if (err instanceof carePlans.PlanNotDraft) return json(c, { error: 'not_draft', message: '確定した計画版は直せません。訂正は新しい計画版で行います' }, 409)
    if (err instanceof carePlans.PlanUnsavedChanges) return json(c, { error: 'unsaved_changes', message: '保存していない変更があります' }, 409)
    if (err instanceof carePlans.UsePlanApi) return json(c, { error: 'use_plan_api', message: '第2表・第3表は計画版の API で直してください' }, 409)
    if (err instanceof repo.BadRequest) return json(c, { error: 'bad_request', message: err.message }, 400)
    if (err instanceof FormUnavailable) return json(c, { error: 'form_unavailable', message: 'この様式の元の PDF がまだ用意されていません' }, 503)
    if (err instanceof PdfOverflow) return json(c, { error: 'overflow', slots: err.slots, message: err.message }, 422)
    // ログには中身を出さない（種類と道だけ）
    console.error(JSON.stringify({ severity: 'ERROR', msg: 'api error', path: c.req.routePath, request_id: auditContextOf(c).requestId, error: err.name }))
    return json(c, { error: 'internal' }, 500)
  })

  return app
}
