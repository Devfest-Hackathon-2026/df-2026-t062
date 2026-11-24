// PC の上の帯（キャンバスの header と同じ）とロゴ
import { useAuth } from '../../lib/auth.tsx'

export function PcHeader({ staffName, roleLabel = 'ケアマネ' }: { staffName: string, roleLabel?: string }) {
  const auth = useAuth()
  return (
    <header style={{ flex: '0 0 auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 24px', background: '#FFFFFF', borderBottom: '1px solid #E1E4EA' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Logo size={32} />
        <div style={{ fontWeight: 700, fontSize: 15 }}>ネコノテ</div>
        </div>
      <button type="button" onClick={() => void auth.signOut()} title="ログアウト" style={{ font: 'inherit', fontSize: 13, color: '#5A6270', background: 'none', border: 0, cursor: 'pointer', padding: 0 }}>{staffName}（{roleLabel}）</button>
    </header>
  )
}

export function Logo({ size }: { size: number }) {
  return (
    <img
      src="/assistant/nekonote-icon.png"
      alt="ネコノテ"
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        display: 'block',
      }}
    />
  )
}