// 書類を作るときに AI が書く（#195）のダイアログ。試作（artifact PCB9zdkE9V3UUxdK8Rt8Bd の「＋ 書類を作る」）の見た目のまま。
//   ask … 作った直後。「アセスメント → AI → 書類」の図と、「自分で書く」「AI に書いてもらう」
//   working … 書いている間。考えている猫と、3 つの段（いまの段に印）。閉じても仕事は続く
import { useEffect, useRef } from 'react'
import type { FillStep } from '../../../db/document-fills.ts'
import './FillDialog.css'

export const FILL_STEPS = ['アセスメントを読む', '欄に書く', '書いた中身を確かめる'] as const
const STEP_INDEX: Record<FillStep, number> = { read: 0, write: 1, check: 2, done: 3 }
/** 段の名前（元の書類がアセスメントでないときは、その名前にする） */
export const fillStepLabel = (i: number, sourceName: string) => i === 0 ? `${sourceName || 'アセスメント'}を読む` : FILL_STEPS[i]
export const fillStepIndex = (step: FillStep) => STEP_INDEX[step]

const BARS = [92, 78, 86, 64]

type Props =
  | { phase: 'ask', sourceName: string, kindName: string, onRun: () => void, onDecline: () => void }
  | { phase: 'working', sourceName: string, step: FillStep, onHide: () => void }

export function FillDialog(props: Props) {
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => { first.current?.focus() }, [props.phase])
  const close = props.phase === 'ask' ? props.onDecline : props.onHide
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])
  const source = props.sourceName || 'アセスメント'
  const bars = () => BARS.map((w, i) => <i key={i} className="g" style={{ width: `${w}%` }} />)

  return (
    <>
      <div className="fill-back" />
      <section className="fill-modal" role="dialog" aria-modal="true" aria-labelledby="fill-h">
        {props.phase === 'ask' ? <>
          <h2 id="fill-h">{source}から、AI が書きましょうか？</h2>
          <div className="fill-flow" role="img" aria-label={`${source}を AI が読んで、${props.kindName}に書く`}>
            <span className="fill-doc"><b>{source}</b>{bars()}</span>
            <span className="fill-arrow" aria-hidden="true">→</span>
            <span className="fill-ai"><img src="/assistant/pet-cat.jpg" alt="" /><small>AI が読んで書く</small></span>
            <span className="fill-arrow" aria-hidden="true">→</span>
            <span className="fill-doc to"><b>{props.kindName}</b>{bars()}</span>
          </div>
          <div className="fill-btns">
            <button ref={first} type="button" className="fill-b" onClick={props.onDecline}>自分で書く</button>
            <button type="button" className="fill-b primary" onClick={props.onRun}>AI に書いてもらう</button>
          </div>
        </> : <>
          <div className="fill-cat"><div className="fill-think" role="img" aria-label="考えている猫"><img src="/assistant/pet-peeking.png" alt="" /><span className="q1">?</span><span className="q2">?</span></div></div>
          <h2 id="fill-h">AI が書いています</h2>
          <ol className="fill-steps">
            {FILL_STEPS.map((_, n) => {
              const now = fillStepIndex(props.step)
              const st = n < now ? 'done' : n === now ? 'now' : ''
              return <li key={n} className={st}><span className="dot" aria-hidden="true">{n < now ? '✓' : ''}</span>{fillStepLabel(n, props.sourceName)}{st === 'now' && <span className="fill-sr">（いまここ）</span>}</li>
            })}
          </ol>
          <p className="fill-muted">数分かかることがあります。閉じても続きます。</p>
          <div className="fill-btns"><button ref={first} type="button" className="fill-b" onClick={props.onHide}>閉じる</button></div>
        </>}
      </section>
    </>
  )
}
