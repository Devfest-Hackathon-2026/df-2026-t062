import { useCallback, useEffect, useState } from 'react'
import { AuthProvider, useAuth } from '../lib/auth.tsx'
import { api, ApiError, setTokenSource, type Staff } from '../lib/api.ts'
import { linkProps, useDevice } from '../lib/router.tsx'
import { useRoute } from './routes.ts'
import { officeGate } from './officeGate.ts'
import { Login } from '../screens/login/Login.tsx'
import { PcList } from '../screens/client-list/PcList.tsx'
import { PcWork } from '../screens/client-work/PcWork.tsx'
import { PadList } from '../screens/client-list/PadList.tsx'
import { PadWork } from '../screens/client-work/PadWork.tsx'
import { OfficeForms } from '../screens/office-forms/OfficeForms.tsx'
import { OfficeKind } from '../screens/office-kind/OfficeKind.tsx'
import { OfficeUpload } from '../screens/office-upload/OfficeUpload.tsx'
import { OfficeReview } from '../screens/office-review/OfficeReview.tsx'
import { OfficeAdd } from '../screens/office-add/OfficeAdd.tsx'
import { OfficeTraining } from '../screens/office-training/OfficeTraining.tsx'
import { OfficeShell } from '../components/office-shell/OfficeShell.tsx'

function OfficeNotice({ message }: { message: string }) {
  return (
    <div className="pc" style={{ padding: 40, fontFamily: "'Noto Sans JP',sans-serif" }}>
      <p role="alert" style={{ margin: 0, fontWeight: 600 }}>{message}</p>
      <p style={{ marginTop: 16 }}><a {...linkProps('/')}>利用者の一覧へ戻る</a></p>
    </div>
  )
}

function Shell() {
  const auth = useAuth()
  const route = useRoute()
  const device = useDevice()
  const [staff, setStaff] = useState<Staff | null>(null)
  const [denied, setDenied] = useState(false)
  /** /api/me が 401/403 以外で失敗したときの見える化（もう一度で取り直す） */
  const [meError, setMeError] = useState('')
  const [trying, setTrying] = useState(false)

  useEffect(() => { setTokenSource(auth.token) }, [auth.token])
  const loadMe = useCallback(async () => {
    setStaff(null)
    setDenied(false)
    if (!auth.signedIn) { setMeError(''); return }
    setTrying(true)
    try {
      const r = await api.me()
      setStaff(r.staff)
      setMeError('')
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setDenied(true)
      else setMeError(String((e as Error).message))
    } finally {
      setTrying(false)
    }
  }, [auth.signedIn, auth.email])
  useEffect(() => { void loadMe() }, [loadMe])

  if (!auth.ready) return null
  if (!auth.signedIn) return <Login />
  if (denied) {
    return (
      <div className="pc" style={{ padding: 40, fontFamily: "'Noto Sans JP',sans-serif" }}>
        <p>このアカウントは、どの事業所にも登録されていません。事業所の管理者に確かめてください。</p>
        <button type="button" className="btn" onClick={() => void auth.signOut()}>別のアカウントで入る</button>
      </div>
    )
  }
  if (meError && !staff) {
    return (
      <div className="pc" style={{ padding: 40, fontFamily: "'Noto Sans JP',sans-serif" }}>
        <p role="alert" style={{ margin: 0, color: '#A3261C', fontWeight: 600 }}>開けませんでした（{meError}）。少し待ってから、もう一度。</p>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-p" disabled={trying} onClick={() => void loadMe()}>{trying ? '確かめています…' : 'もう一度'}</button>
          <button type="button" className="btn" disabled={trying} onClick={() => void auth.signOut()}>別のアカウントで入る</button>
        </div>
      </div>
    )
  }
  if (!staff) return null
  // 書類の設定は責任者の PC だけ（#111 で PC だけと決めた）。ほかは一覧に流さず、理由を出す
  const gate = officeGate(route, staff.role, device)
  if (!gate.ok) return <OfficeNotice message={gate.message} />
  if (staff.role === 'admin' && device === 'pc') {
    if (route.name === 'office') return <OfficeForms staffName={staff.name} />
    if (route.name === 'officeKind') return <OfficeKind key={route.kind} staffName={staff.name} kind={route.kind} />
    if (route.name === 'officeUpload') return <OfficeUpload staffName={staff.name} kind={route.kind} />
    if (route.name === 'officeAdd') return <OfficeAdd staffName={staff.name} />
    if (route.name === 'officeTraining') return <OfficeTraining key={route.kind} staffName={staff.name} kind={route.kind} />
    if (route.name === 'officeReview') return <OfficeReview key={route.versionId} staffName={staff.name} kind={route.kind} versionId={route.versionId} fix={new URLSearchParams(location.search).get('fix') === '1'} />
    if (route.name === 'list') return <OfficeShell staffName={staff.name} active="clients"><PcList staffName={staff.name} embedded /></OfficeShell>
  }
  if (route.name === 'client') return device === 'pad' ? <PadWork clientId={route.id} /> : <PcWork key={route.id} clientId={route.id} staffName={staff.name} isAdmin={staff.role === 'admin'} />
  return device === 'pad' ? <PadList staffName={staff.name} /> : <PcList staffName={staff.name} />
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
