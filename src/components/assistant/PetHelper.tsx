import { diagramChatTitle } from './chatEntry.ts'
import { useEffect, useRef, useState } from 'react'
import { DocumentInput, useDocumentInputs } from '../document-input/DocumentInput.tsx'
import { GLOBAL_DICT, type FieldDict } from '../../../core/dictionary.ts'
import type { SurveyPreview } from '../survey/readSurvey.ts'
import { PetChat } from './PetChat.tsx'
import { PetInspection, useInspections } from '../inspection/PetInspection.tsx'
import { menuStatus } from '../inspection/petInspection.ts'
import { PetIcon, PetMessage } from '../pet/PetVisuals.tsx'
import type { ChatEntry } from './petChat.ts'
import type { availableTopics, ReviewItem } from './topics.ts'
import { fieldLabel } from '../document/fields.ts'
import './PetHelper.css'

const menus = [
  { id: 'documents', icon: 'file-earmark-arrow-down', title: '書類を取り込む' },
  { id: 'review', icon: 'check2-circle', title: '確認する' },
  { id: 'inspect', icon: 'clipboard-check', title: '点検する' },
  { id: 'interview', icon: 'lightbulb', title: '面談のヒント' },
  { id: 'revise', icon: 'pencil', title: '書き方を相談する' },
] as const

type Menu = typeof menus[number]['id']

interface Props {
  diagramRequest?: { key: string, id: number }
  /** 点検（AI 点検）の相手。なければ「点検する」を出さない */
  clientId?: string

  available: boolean
  beforeDocumentAdopt: () => Promise<boolean>
  onDocumentApplied: () => void
  clientName: string
  review: ReviewItem[]
  topics: ReturnType<typeof availableTopics>
  /** 事業所が足した項目で、この書類でまだ話に出ていないもの（#115。名前だけ） */
  unheard?: { id: string, name: string }[]
  onJump: (key: string) => boolean
  onPreview: (preview: SurveyPreview) => number
  onIdentity: (sha256: string, confirmed: boolean) => void
  verifiedSources: ReadonlySet<string>
  /** 書き方の相談（開いている書類。アセスメントでも入院時情報提供書でも使える） */
  chat: { documentId: string | undefined, current: Record<string, unknown>, saved?: Record<string, unknown>, onSet: (key: string, value: unknown, mode: 'edit' | 'revert') => void, onDiagramApply?: (key: string, value: unknown, base: unknown) => Promise<void>, dict?: FieldDict }
  /** 書類を作るときに AI が書く（#195）。元の書類から書ける書類を開いているときだけ */
  fill?: PetFill
}

export type PetFill =
  | { phase: 'offer', sourceName: string, onRun: () => void, error?: string }
  | { phase: 'working', step: string, onShow: () => void }
  | { phase: 'done', sourceName: string, changes: number }

/** 猫の欄の「AI が書く」の知らせ（試作の .cw-pet のことば） */
function PetFillNote({ fill }: { fill: PetFill }) {
  if (fill.phase === 'working') return (
    <div className="assistant-fill" role="status">
      <p><strong>AI が書いています</strong><br />{fill.step}…</p>
      <button type="button" className="assistant-primary" onClick={fill.onShow}>様子を見る</button>
    </div>
  )
  if (fill.phase === 'done') return (
    <div className="assistant-fill" role="status">
      {fill.changes > 0
        ? <p><strong>書き終わりました。</strong><br />緑の下線のところが、AI が書いたところです。押すと、前の文と比べられます。</p>
        : <p><strong>書き終わりました。</strong><br />{fill.sourceName}から書き直す欄・書ける欄はありませんでした。</p>}
      <p>{fill.sourceName}から分からなかった欄は、空けてあります。</p>
    </div>
  )
  return (
    <div className="assistant-fill">
      <p>{fill.sourceName}から、AI が書くこともできます。</p>
      <button type="button" className="assistant-primary" onClick={fill.onRun}>AI に書いてもらう</button>
      {fill.error && <p className="assistant-error" role="alert">{fill.error}</p>}
    </div>
  )
}

export function PetHelper({ clientId, beforeDocumentAdopt, onDocumentApplied, available, clientName, review, topics, unheard = [], onJump, onPreview, onIdentity, verifiedSources, chat, diagramRequest, fill }: Props) {

  const [menu, setMenu] = useState<Menu | null>(null)
  const [activeDiagramRequest, setActiveDiagramRequest] = useState<{ key: string, id: number, documentId?: string }>()
  const [chatTopic, setChatTopic] = useState<string>()
  const scopedDiagramRequest = activeDiagramRequest?.documentId === chat.documentId ? activeDiagramRequest : undefined
  // 相談のやり取りは画面の中だけ。メニューを行き来しても残し、書類が変わったら消す
  const [chatEntries, setChatEntries] = useState<ChatEntry[]>([])
  useEffect(() => { setChatEntries([]); setActiveDiagramRequest(undefined); setChatTopic(undefined) }, [chat.documentId])
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState('')
  const body = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const previousMenu = useRef<Menu | null>(null)
  const menuButtons = useRef<Partial<Record<Menu, HTMLButtonElement | null>>>({})
  const pending = review.filter((item) => !item.confirmed).length
  const inspections = useInspections(clientId)
  const inspectStatus = menuStatus(inspections.list)
  const intake = useDocumentInputs(chat.documentId)
  const inputReview = intake.inputs.filter((input) => input.status === 'review' &&
    (input.result?.candidates.some((candidate) => !input.adopted.includes(candidate.key)) ||
      input.result?.issues.length || input.result?.incompleteFields.length ||
      input.result?.evidence.some((entry) => entry.uncertain))).length
  const inputApplied = intake.inputs.filter((input) => input.status === 'review' && input.adopted.length &&
    input.result?.candidates.every((candidate) => input.adopted.includes(candidate.key))).length
  const inputStatus = [inputReview ? `確認待ち ${inputReview}件` : '', intake.working ? '読み取り中' : '',
    inputApplied ? `反映済み ${inputApplied}件` : '',
    intake.inputs.some((input) => input.status === 'failed') ? '読み取りに失敗した書類があります' : ''].filter(Boolean).join('・')

  useEffect(() => {
    body.current?.scrollTo(0, 0)
    if (menu && !(menu === 'revise' && scopedDiagramRequest)) back.current?.focus({ preventScroll: true })
    else if (previousMenu.current) menuButtons.current[previousMenu.current]?.focus({ preventScroll: true })
  }, [menu])

  useEffect(() => {
    if (diagramRequest) { setActiveDiagramRequest({ ...diagramRequest, documentId: chat.documentId }); setChatTopic(diagramRequest.key); setMenu('revise'); setError('') }
  }, [diagramRequest])

  const open = (next: Menu | null) => {
    if (menu) previousMenu.current = menu
    setMenu(next)
    setActiveDiagramRequest(undefined)
    setChatTopic(undefined)
    setError('')
    setConfirmed(false)
  }
  const jump = (key: string) => setError(onJump(key) ? '' : '用紙に対応する入力欄が見つかりませんでした。')

  return (
    <aside className="assistant-panel" aria-labelledby="assistant-title">
      <div ref={body} className={`assistant-body${menu ? '' : ' assistant-home'}`}>
        {menu && (
          <header className="assistant-header">
            <button ref={back} type="button" aria-label="メニューに戻る" onClick={() => open(null)}><PetIcon name="arrow-left" /></button>
            <h2 id="assistant-title">{menu === 'revise' ? diagramChatTitle(chatTopic) : menus.find(({ id }) => id === menu)?.title}</h2>
          </header>
        )}
        {!menu && (
          <>
            <PetMessage home>今日は何から<br />一緒に進めましょうか？</PetMessage>
            {fill && <PetFillNote fill={fill} />}
            <div className="assistant-stack assistant-menu">
              {menus.filter(({ id }) => id !== 'inspect' || clientId).map(({ id, icon, title }) => (
                <button key={id} ref={(node) => { menuButtons.current[id] = node }} type="button" className="assistant-card" onClick={() => open(id)}>
                  <PetIcon name={icon} />
                  <span><strong>{title}</strong>{id === 'review' && <small>（未確認 {pending}件）</small>}
                    {id === 'documents' && inputStatus && <small role="status">{inputStatus}</small>}
                    {id === 'inspect' && inspectStatus && <small className={`insp-tone-${inspectStatus.tone}`}>{inspectStatus.text}</small>}</span>
                  <PetIcon name="chevron-right" />
                </button>
              ))}
            </div>
          </>
        )}
        {menu === 'documents' && <>
          {chat.documentId ? <DocumentInput key={chat.documentId} documentId={chat.documentId} intake={intake} dict={chat.dict ?? GLOBAL_DICT} clientName={clientName} beforeAdopt={beforeDocumentAdopt} onApplied={onDocumentApplied} /> : <p>書類を開くと取り込めます。</p>}
        </>}
        {menu === 'review' && (
          <>
            <PetMessage>未確認の項目が{pending}件あります。<br />項目を選ぶと、用紙の該当欄に移動します。</PetMessage>
            <div className="assistant-review-tabs" role="group" aria-label="確認状態">
              <button type="button" aria-pressed={!confirmed} onClick={() => { setConfirmed(false); setError('') }}>未確認（{pending}件）</button>
              <button type="button" aria-pressed={confirmed} onClick={() => { setConfirmed(true); setError('') }}><PetIcon name="check2" />確認済み（{review.length - pending}件）</button>
            </div>
            <ul className="assistant-stack">
              {review.filter((item) => item.confirmed === confirmed).map(({ key, value, reason }) => (
                <li key={key}><button type="button" className="assistant-card assistant-review-card" onClick={() => jump(key)}>
                  {confirmed ? <PetIcon name="check2" /> : <span className="assistant-review-dot" />}
                  <span className="assistant-review-content">
                    <strong>{fieldLabel(key)}</strong>
                    <span className="assistant-review-value" title={value}>{value}</span>
                    {reason && <small>{reason}</small>}
                  </span>
                  <PetIcon name="chevron-right" />
                </button></li>
              ))}
            </ul>
            {!review.some((item) => item.confirmed === confirmed) && <p className="assistant-empty">{confirmed ? '確認済みの項目はありません。' : '未確認の項目はありません。'}</p>}
          </>
        )}
        {menu === 'interview' && (
          <>
            <PetMessage>空白の項目を埋めるために、<br />面談で確認するとよい話題の例を提案します。</PetMessage>
            {unheard.length > 0 && (
              <div className="assistant-card assistant-topic assistant-unheard">
                <PetIcon name="lightbulb" /><div><h3>まだ聞いていない</h3><small>事業所で足した項目です。録音で話に出ると、AI が書きます。</small>
                  <ul aria-label="まだ聞いていない項目">{unheard.map((t) => <li key={t.id}>{t.name}</li>)}</ul></div>
              </div>
            )}
            <ul className="assistant-stack">
              {topics.map(({ title, icon, description, keys }) => (
                <li key={title}>
                  <div className="assistant-card assistant-topic">
                    <PetIcon name={icon} /><div><h3>{title}</h3><small>{description}</small></div>
                  </div>
                  <ul className="assistant-topic-targets" aria-label={`${title}の入力欄`}>
                    {keys.map((key) => <li key={key}><button type="button" onClick={() => jump(key)}>{fieldLabel(key)}<PetIcon name="chevron-right" /></button></li>)}
                  </ul>
                </li>
              ))}
            </ul>
            {!topics.length && !unheard.length && <p className="assistant-empty">{available ? '面談のヒントに対応する空欄はありません。' : 'アセスメントを開くと面談のヒントを表示します。'}</p>}
          </>
        )}
        {menu === 'inspect' && clientId && <PetInspection clientId={clientId} list={inspections.list} reload={inspections.reload} onJump={jump} />}
        {menu === 'revise' && (
          <PetChat key={chat.documentId} diagramRequest={scopedDiagramRequest} onTopicChange={setChatTopic} saved={chat.saved} documentId={chat.documentId} entries={chatEntries} setEntries={setChatEntries} current={chat.current} onSet={chat.onSet} onDiagramApply={chat.onDiagramApply}
            onJump={available ? jump : undefined} dict={chat.dict} />

        )}
        {error && <p className="assistant-error" role="alert">{error}</p>}
      </div>
    </aside>
  )
}
