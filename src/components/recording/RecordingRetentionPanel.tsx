import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError, type RecordingRetentionListItem } from '../../lib/api.ts'
import type { HoldReasonCode } from '../../../db/recording-retention.ts'

const REASONS = [
  ['legal_request', '法的な確認'],
  ['incident_investigation', '事故・苦情の調査'],
  ['security_investigation', 'セキュリティ調査'],
  ['regulatory_request', '規制・行政対応'],
  ['renewed_legal_request', '法的確認の延長'],
  ['temporary_investigation', '一時的な調査'],
  ['too_late', '削除期限直前の確認'],
] as const

function dateText(value: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function localDateTime(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000
  return new Date(value.getTime() - offset).toISOString().slice(0, 16)
}

function statusText(recording: RecordingRetentionListItem) {
  if (recording.retentionHoldTarget && recording.retentionHoldUntil && new Date(recording.retentionHoldUntil).getTime() <= Date.now()) return '保全期限切れ・解除待ち'
  if (recording.retentionHoldSyncStatus === 'legacy') return '保全状態未同期'
  if (recording.retentionHoldTarget && recording.retentionHoldSyncStatus === 'synced') return '保全中'
  if (recording.retentionHoldTarget && recording.retentionHoldSyncStatus === 'applying') return '保全設定を同期中'
  if (!recording.retentionHoldTarget && recording.retentionHold && recording.retentionHoldSyncStatus === 'releasing') return '保全解除を同期中'
  if (recording.retentionHoldSyncStatus === 'failed') return '保全状態の同期に失敗'
  if (recording.retentionHold) return '保全中（状態確認中）'
  return '通常保持'
}

function sourceStatus(recording: RecordingRetentionListItem) {
  if (recording.sourceDeletedAt || recording.sourceDeleteStatus === 'deleted') return '削除済み'
  if (recording.sourceDeleteStatus === 'deleting') return '削除処理中'
  if (recording.sourceDeleteStatus === 'failed') return '削除失敗（再試行対象）'
  if (recording.sourceDeleteStatus === 'requested') return '削除要求済み'
  if (recording.sourceDeleteStatus === 'eligible') return '削除対象'
  if (new Date(recording.sourceExpiresAt).getTime() <= Date.now()) return '削除対象'
  return '保持中'
}

function errorText(error: unknown) {
  if (!(error instanceof ApiError)) return '処理に失敗しました。時間を置いて再試行してください。'
  if (error.code === 'recording_source_deleted') return 'この録音はすでに削除済みのため、保全できません。'
  if (error.code === 'recording_source_deleting') return 'この録音は削除処理中のため、保全できません。'
  if (error.code === 'retention_hold_not_active') return 'この録音は保全中ではありません。画面を更新してください。'
  if (error.code === 'invalid_hold_until') return '保全終了日時は現在から90日以内の未来日時にしてください。'
  if (error.code === 'invalid_hold_reason_code') return '保全理由を選択してください。'
  return '処理に失敗しました。時間を置いて再試行してください。'
}

export function RecordingRetentionPanel({ clientId }: { clientId: string }) {
  const [recordings, setRecordings] = useState<RecordingRetentionListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<RecordingRetentionListItem | null>(null)
  const [holdUntil, setHoldUntil] = useState('')
  const [reasonCode, setReasonCode] = useState<HoldReasonCode>(REASONS[0][0])
  const [busy, setBusy] = useState(false)

  const minDate = useMemo(() => localDateTime(new Date(Date.now() + 60_000)), [])
  const maxDate = useMemo(() => localDateTime(new Date(Date.now() + 90 * 24 * 60 * 60_000)), [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.recordingRetentions(clientId)
      setRecordings(result.recordings)
      setError('')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => { void load() }, [load])

  const openHold = (recording: RecordingRetentionListItem) => {
    setEditing(recording)
    setHoldUntil(recording.retentionHoldUntil ? localDateTime(new Date(recording.retentionHoldUntil)) : localDateTime(new Date(Date.now() + 30 * 24 * 60 * 60_000)))
    setReasonCode((recording.retentionHoldReasonCode as HoldReasonCode | null) ?? REASONS[0][0])
    setError('')
  }

  const submitHold = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!editing) return
    setBusy(true)
    try {
      await api.setRecordingRetentionHold(editing.id, new Date(holdUntil).toISOString(), reasonCode)
      setEditing(null)
      await load()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const release = async (recording: RecordingRetentionListItem) => {
    if (!window.confirm('この録音の保全を解除しますか。期限を過ぎていれば削除対象に戻ります。')) return
    setBusy(true)
    try {
      await api.releaseRecordingRetentionHold(recording.id)
      await load()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
  aria-label="録音の保持管理"
  style={{
    width: 'calc(100% - 56px)',
    maxWidth: 900,
    boxSizing: 'border-box',
    margin: '16px auto 0',
    background: '#FFFFFF',
    border: '1px solid #E1E4EA',
    borderRadius: 12,
    padding: 18,
  }}
>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>録音の保持管理</h2>
          <p style={{ margin: '4px 0 0', color: '#5A6270', fontSize: 12 }}>管理者のみ。音声の内容は表示せず、保持期限と保全状態だけを管理します。</p>
        </div>
        <button type="button" className="btn" disabled={loading || busy} onClick={() => void load()}>更新</button>
      </div>
      {error && <p role="alert" style={{ color: '#A3261C', margin: '12px 0 0', fontSize: 13 }}>{error}</p>}
      {loading ? <p role="status">録音の状態を読み込んでいます…</p> : recordings.length === 0 ? <p>この利用者の録音はありません。</p> : (
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ textAlign: 'left', borderBottom: '1px solid #D9DDE5' }}>
              <th style={{ padding: '8px 6px' }}>録音日時</th><th style={{ padding: '8px 6px' }}>原本</th><th style={{ padding: '8px 6px' }}>原本の保持期限</th><th style={{ padding: '8px 6px' }}>完全消去見込み</th><th style={{ padding: '8px 6px' }}>中間データ期限</th><th style={{ padding: '8px 6px' }}>保全</th><th style={{ padding: '8px 6px' }}>操作</th>
            </tr></thead>
            <tbody>{recordings.map((recording) => {
              const syncing = ['applying', 'releasing'].includes(recording.retentionHoldSyncStatus)
              return <tr key={recording.id} style={{ borderBottom: '1px solid #EEF0F4', verticalAlign: 'top' }}>
                <td style={{ padding: '10px 6px', whiteSpace: 'nowrap' }}>{dateText(recording.recordedAt)}</td>
                <td style={{ padding: '10px 6px' }}>{sourceStatus(recording)}<br /><span style={{ color: '#5A6270' }}>{recording.sourceDeleteStatus}</span></td>
                <td style={{ padding: '10px 6px', whiteSpace: 'nowrap' }}>{dateText(recording.sourceExpiresAt)}</td>
                <td style={{ padding: '10px 6px', whiteSpace: 'nowrap' }}>{dateText(recording.sourcePurgeExpectedAt)}</td>
                <td style={{ padding: '10px 6px', whiteSpace: 'nowrap' }}>{dateText(recording.intermediateExpiresAt)}<br /><span style={{ color: '#5A6270' }}>{recording.intermediateDeleteStatus}</span></td>
                <td style={{ padding: '10px 6px', whiteSpace: 'nowrap' }}>{statusText(recording)}{recording.retentionHoldUntil && <><br /><span style={{ color: '#5A6270' }}>期限 {dateText(recording.retentionHoldUntil)}</span></>}</td>
                <td style={{ padding: '10px 6px', whiteSpace: 'nowrap' }}>
                  <button type="button" className="btn" disabled={busy || syncing || recording.sourceDeleteStatus === 'deleted' || !!recording.sourceDeletedAt} onClick={() => openHold(recording)}>{recording.retentionHoldTarget ? '保全を延長' : '保全を設定'}</button>{' '}
                  {(recording.retentionHold || recording.retentionHoldTarget) && <button type="button" className="btn" disabled={busy || syncing} onClick={() => void release(recording)}>保全を解除</button>}
                </td>
              </tr>
            })}</tbody>
          </table>
        </div>
      )}
      {editing && <div role="dialog" aria-modal="true" aria-labelledby="retention-dialog-title" style={{ position: 'fixed', inset: 0, zIndex: 20, background: 'rgba(20,24,32,0.35)', display: 'grid', placeItems: 'center', padding: 20 }}>
        <form onSubmit={(event) => void submitHold(event)} style={{ background: '#FFFFFF', borderRadius: 12, padding: 22, width: 'min(460px, 100%)', boxShadow: '0 16px 40px rgba(20,24,32,0.25)' }}>
          <h2 id="retention-dialog-title" style={{ margin: 0, fontSize: 18 }}>録音を保全する</h2>
          <p style={{ color: '#5A6270', fontSize: 13 }}>保全中は自動削除の対象になりません。終了日時を過ぎると、保全解除後に削除対象へ戻ります。</p>
          <label style={{ display: 'block', marginTop: 14 }}>保全終了日時
            <input aria-label="保全終了日時" required type="datetime-local" min={minDate} max={maxDate} value={holdUntil} onChange={(event) => setHoldUntil(event.target.value)} style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 4, padding: 8 }} />
          </label>
          <label style={{ display: 'block', marginTop: 14 }}>保全理由
            <select aria-label="保全理由" required value={reasonCode} onChange={(event) => setReasonCode(event.target.value as HoldReasonCode)} style={{ display: 'block', width: '100%', marginTop: 4, padding: 8 }}>
              {REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
            <button type="button" className="btn" disabled={busy} onClick={() => setEditing(null)}>キャンセル</button>
            <button type="submit" className="btn btn-p" disabled={busy}>{busy ? '処理中…' : '保全を保存'}</button>
          </div>
        </form>
      </div>}
    </section>
  )
}
