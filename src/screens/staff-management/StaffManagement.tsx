import { useEffect, useMemo, useState } from 'react'
import { api, type StaffMember } from '../../lib/api.ts'
import { OfficeShell } from '../../components/office-shell/OfficeShell.tsx'

const roleName = (role: string) => role === 'admin' ? 'ケアマネ管理者' : 'ケアマネ'

export function StaffManagement({ staffName }: { staffName: string }) {
  const [members, setMembers] = useState<StaffMember[] | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'created' | 'name' | 'role'>('created')
  const [dialog, setDialog] = useState<'new' | StaffMember | null>(null)
  const [error, setError] = useState('')

  const reload = async () => {
    setError('')
    try { setMembers((await api.officeStaff()).staff) } catch (e) { setError(String((e as Error).message)) }
  }
  useEffect(() => { void reload() }, [])

  const shown = useMemo(() => {
    const words = query.trim().toLocaleLowerCase()
    const rows = (members ?? []).filter((m) => !words || `${m.name} ${m.email ?? ''}`.toLocaleLowerCase().includes(words))
    return [...rows].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'ja') : sort === 'role' ? a.role.localeCompare(b.role) || a.name.localeCompare(b.name, 'ja') : a.createdAt.localeCompare(b.createdAt))
  }, [members, query, sort])

  return <OfficeShell staffName={staffName} active="staff">
    <div className="admin-page">
      <header className="admin-page-header"><h1>職員管理</h1><button type="button" className="admin-button admin-button-primary" onClick={() => setDialog('new')}>＋ 職員を登録</button></header>
      <div className="admin-toolbar">
        <label className="admin-search"><span aria-hidden="true">⌕</span><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="職員名・メールで検索" aria-label="職員名・メールで検索" /></label>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="並び替え"><option value="created">更新日が新しい順</option><option value="name">氏名順</option><option value="role">役割順</option></select>
      </div>
      {error && <p className="admin-error" role="alert">読み込めませんでした（{error}）</p>}
      <div className="admin-table-wrap"><table className="admin-table staff-table"><thead><tr><th>職員</th><th>役割</th><th>状態</th><th>操作</th></tr></thead><tbody>
        {!members && !error && <tr><td colSpan={4} className="admin-empty">読み込んでいます</td></tr>}
        {members && !shown.length && <tr><td colSpan={4} className="admin-empty">該当する職員はいません</td></tr>}
        {shown.map((m) => <tr key={m.id}><td><div className="admin-primary-text">{m.name}</div><div className="admin-secondary-text">{m.email ?? 'メールアドレス未登録'}</div></td><td><span className="admin-badge admin-badge-neutral">{roleName(m.role)}</span></td><td><span className={`admin-badge ${m.disabled ? 'admin-badge-warning' : 'admin-badge-success'}`}>{m.disabled ? '停止中' : '利用中'}</span></td><td><div className="admin-inline-actions"><button type="button" className="admin-small-button" onClick={() => setDialog(m)}>役割を変更</button><button type="button" className={`admin-small-button${m.disabled ? '' : ' admin-small-danger'}`} onClick={() => void changeDisabled(m)}>{m.disabled ? '再開' : '利用停止'}</button></div></td></tr>)}
      </tbody></table></div>
      {dialog === 'new' && <RegisterDialog onClose={() => setDialog(null)} onDone={() => { setDialog(null); void reload() }} />}
      {dialog !== null && dialog !== 'new' && <RoleDialog member={dialog} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void reload() }} />}
    </div>
  </OfficeShell>

  async function changeDisabled(member: StaffMember) {
    if (!confirm(`${member.name}さんを${member.disabled ? '再開' : '利用停止'}しますか？`)) return
    try { await api.updateOfficeStaff(member.id, { disabled: !member.disabled }); await reload() } catch (e) { setError(String((e as Error).message)) }
  }
}

function RegisterDialog({ onClose, onDone }: { onClose: () => void, onDone: () => void }) {
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [role, setRole] = useState<'admin' | 'caremanager'>('caremanager'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setError(''); try { await api.createOfficeStaff({ name, email, role }); onDone() } catch (e) { setError(String((e as Error).message)); setBusy(false) } }
  return <Dialog title="職員を登録" onClose={onClose}><form onSubmit={submit} className="admin-form"><label>氏名<input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></label><label>メールアドレス<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label><label>役割<select value={role} onChange={(e) => setRole(e.target.value as typeof role)}><option value="caremanager">ケアマネ</option><option value="admin">ケアマネ管理者</option></select></label>{error && <p className="admin-error">{error}</p>}<div className="admin-dialog-actions"><button type="button" className="admin-button" onClick={onClose}>やめる</button><button className="admin-button admin-button-primary" disabled={busy}>{busy ? '登録しています…' : '登録する'}</button></div></form></Dialog>
}

function RoleDialog({ member, onClose, onDone }: { member: StaffMember, onClose: () => void, onDone: () => void }) {
  const [role, setRole] = useState<'admin' | 'caremanager'>(member.role === 'admin' ? 'admin' : 'caremanager'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); try { await api.updateOfficeStaff(member.id, { role }); onDone() } catch (e) { setError(String((e as Error).message)); setBusy(false) } }
  return <Dialog title={`${member.name}さんの役割を変更`} onClose={onClose}><form onSubmit={submit} className="admin-form"><label>役割<select value={role} onChange={(e) => setRole(e.target.value as typeof role)}><option value="caremanager">ケアマネ</option><option value="admin">ケアマネ管理者</option></select></label>{error && <p className="admin-error">{error}</p>}<div className="admin-dialog-actions"><button type="button" className="admin-button" onClick={onClose}>やめる</button><button className="admin-button admin-button-primary" disabled={busy}>{busy ? '変更しています…' : '変更する'}</button></div></form></Dialog>
}

function Dialog({ title, onClose, children }: { title: string, onClose: () => void, children: React.ReactNode }) { return <div className="admin-dialog-backdrop" role="presentation" onMouseDown={onClose}><section className="admin-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}><h2>{title}</h2>{children}</section></div> }
