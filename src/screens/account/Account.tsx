import type { Staff } from '../../lib/api.ts'
import { OfficeShell } from '../../components/office-shell/OfficeShell.tsx'

export function Account({ staff }: { staff: Staff }) {
  return (
    <OfficeShell staffName={staff.name} active="account">
      <div className="admin-page">
        <header className="admin-page-header"><h1>アカウント</h1></header>
        <dl className="account-list">
          <div><dt>表示名</dt><dd>{staff.name}（責任者）</dd></div>
          <div><dt>役割</dt><dd>ケアマネ管理者</dd></div>
          <div><dt>事業所</dt><dd>{staff.officeName}</dd></div>
          <div><dt>メールアドレス</dt><dd>{staff.email ?? '未登録'}</dd></div>
        </dl>
        <div className="admin-section"><button type="button" className="admin-button" disabled title="プロフィール編集は準備中です">プロフィールを編集</button></div>
      </div>
    </OfficeShell>
  )
}
