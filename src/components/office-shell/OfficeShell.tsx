// 責任者の画面の外枠（#102）: 上の帯と左のメニュー、戻るリンク、責任者の画面で使う絵。
import type { ReactNode } from 'react'
import { linkProps } from '../../lib/router.tsx'
import { PcHeader } from '../header/PcHeader.tsx'
import './office.css'

export const Icon = {
  doc: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
  alert: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>,
  arc: <svg className="of-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" /></svg>,
  upload: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>,
  back: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>,
}

export function BackLink({ to, label }: { to: string, label: string }) {
  return <a className="of-back" {...linkProps(to)}>{Icon.back}{label}</a>
}

/** 責任者の外枠: 上の帯と左のメニュー。wide は余白なし（書式を見る画面） */
export function OfficeShell({ staffName, active, wide, children }: { staffName: string, active: 'forms' | 'clients' | null, wide?: boolean, children: ReactNode }) {
  return (
    <div className={`pc${wide ? ' of-wide' : ''}`} style={{ fontFamily: "'Noto Sans JP',system-ui,sans-serif", color: '#1F2430', background: '#F4F5F7', minHeight: '100vh', fontSize: 14, lineHeight: 1.6 }}>
      <PcHeader staffName={staffName} roleLabel="責任者" />
      {wide ? <main className="of-wide-main">{children}</main> : (
        <div className="of-app">
          <nav className="of-nav" aria-label="メニュー">
            <a {...linkProps('/app')} aria-current={active === 'clients' ? 'page' : undefined}>{Icon.users}利用者一覧</a>
            <a {...linkProps('/office')} aria-current={active === 'forms' ? 'page' : undefined}>{Icon.doc}書類の設定</a>
          </nav>
          <main className="of-main">{children}</main>
        </div>
      )}
    </div>
  )
}
