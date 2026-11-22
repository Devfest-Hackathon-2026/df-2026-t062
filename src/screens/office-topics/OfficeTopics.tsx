// 責任者の画面（#153）: 事業所の書類を足す 手順 4「聞き取ること」。試作（prototypes/111-admin-adopted の addTopicsScreen と、
// 「聞き取ることを足す」のドロワー）の並びと言葉のまま。#154 で暫定の案として採用した、項目の一覧＋ドロワーの形。
// はじめて開いたとき、確かめた書式の欄から AI が案を作る（全体のまとめは裏で持ち、ここには出さない）。
import { useEffect, useState } from 'react'
import { api, ApiError, type KindFormState } from '../../lib/api.ts'
import { linkProps, navigate } from '../../lib/router.tsx'
import { OfficeShell } from '../../components/office-shell/OfficeShell.tsx'
import { AddPublishDialog, AddSteps } from '../../components/office-add/AddSteps.tsx'
import { useOfficeForms } from '../../components/form-status/formStatus.ts'

type Item = { id?: string, name: string, guide: string }
type Drawer = { index: number | null, name: string, guide: string, bad: boolean } | null

const pen = <svg className="pen" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>

export function OfficeTopics({ staffName, kind }: { staffName: string, kind: string }) {
  const { kinds, error: loadError } = useOfficeForms()
  const k: KindFormState | undefined = kinds?.find((x) => x.key === kind)
  const [items, setItems] = useState<Item[] | null>(null)
  const [thumb, setThumb] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<Drawer>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState<'ask' | 'busy' | null>(null)
  const [publishError, setPublishError] = useState('')
  const versionId = k?.draft?.versionId
  const base = `/office/forms/${encodeURIComponent(kind)}`

  // はじめて開いたとき（全体のまとめしかない）は、AI が案を作る
  useEffect(() => {
    if (!k || !versionId || items) return
    const mine = k.topics.filter((t) => !t.last)
    if (mine.length) { setItems(mine.map(({ id, name, guide }) => ({ id, name, guide }))); return }
    let live = true
    api.draftOfficeTopics(kind, versionId)
      .then((r) => { if (live) setItems(r.topics.filter((t) => !t.last).map(({ id, name, guide }) => ({ id, name, guide }))) })
      .catch((e) => { if (live) { setItems([]); setError(e instanceof ApiError ? e.message : String((e as Error).message)) } })
    return () => { live = false }
  }, [k, versionId, kind, items])
  useEffect(() => {
    if (!versionId) return
    let live = true
    api.managedAssets(versionId).then((a) => { if (live) setThumb(a.pages[0]?.url ?? null) }).catch(() => {})
    return () => { live = false }
  }, [versionId])

  const save = async (next: Item[]) => {
    setSaving(true)
    setError('')
    try {
      const r = await api.setOfficeTopics(kind, next)
      setItems(r.topics.filter((t) => !t.last).map(({ id, name, guide }) => ({ id, name, guide })))
      return true
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String((e as Error).message))
      return false
    } finally { setSaving(false) }
  }
  const saveDrawer = async () => {
    if (!drawer || !items) return
    if (!drawer.name.trim()) { setDrawer({ ...drawer, bad: true }); return }
    const it = { name: drawer.name.trim(), guide: drawer.guide.trim() }
    const next = drawer.index === null ? [...items, it] : items.map((x, i) => (i === drawer.index ? { ...x, ...it } : x))
    if (await save(next)) setDrawer(null)
  }
  const remove = async () => {
    if (!drawer || drawer.index === null || !items) return
    if (await save(items.filter((_, i) => i !== drawer.index))) setDrawer(null)
  }
  const publish = async () => {
    if (!versionId) return
    setPublishing('busy')
    setPublishError('')
    try {
      const v = await api.managedVersion(versionId)
      await api.publishVersion(versionId, v.formVersion.contentSha)
      navigate('/office')
    } catch (e) {
      setPublishing('ask')
      setPublishError(e instanceof ApiError && e.status === 422 ? 'まだ使い始められません。書式の中に、何が入るか決まっていない欄があります。' : `使い始められませんでした（${(e as Error).message}）`)
    }
  }

  if (!k) {
    return <OfficeShell staffName={staffName} active={null} wide><AddSteps step={4} /><main className="oa-body">{loadError ? <div role="alert" className="of-err">読み込めませんでした（{loadError}）</div> : kinds ? <p>この書類はありません。</p> : <div role="status" className="of-muted">読み込んでいます</div>}</main></OfficeShell>
  }
  if (!versionId) {
    return <OfficeShell staffName={staffName} active={null} wide><AddSteps step={4} name={k.name} /><main className="oa-body"><div className="oa-wait"><h2>先に書式を確かめてください</h2><a className="btn btn-p" {...linkProps(base)}>書類に戻る</a></div></main></OfficeShell>
  }

  return (
    <OfficeShell staffName={staffName} active={null} wide>
      <AddSteps step={4} name={k.name} />
      <main className="oa-body">
        <div className="oa-topics">
          <div className="col">
            <h2>この書類で、何を聞き取りますか</h2>
            <p className="of-lead" style={{ margin: 0 }}>上げた書式から、AI が案を作りました。直したり、足したりできます。AI は録音からまとめて書類に書きます。</p>
            {!items ? <div role="status" className="of-muted">AI が案を作っています</div> : (
              <div className="oa-trows">
                {items.length ? items.map((t, i) => (
                  <button key={t.id ?? `n${i}`} type="button" className="oa-trow" onClick={() => setDrawer({ index: i, name: t.name, guide: t.guide, bad: false })} aria-label={`${t.name}を直す`}>
                    <span className="main"><strong>{t.name}</strong>{t.guide && <small>{t.guide}</small>}</span>{pen}
                  </button>
                )) : <div className="oa-tempty">まだありません。</div>}
              </div>
            )}
            <button type="button" className="btn oa-dashed" disabled={!items} onClick={() => setDrawer({ index: null, name: '', guide: '', bad: false })}>＋ 聞き取ることを足す</button>
            {error && <div role="alert" className="of-err">保存できませんでした（{error}）</div>}
            <div className="oa-note">録音で話していないことは、AI は書きません。</div>
          </div>
          <aside aria-label="上げた書式">
            <div className="of-muted" style={{ fontWeight: 700 }}>上げた書式</div>
            {thumb ? <img src={thumb} alt={`${k.name}の書式の 1 ページ目`} /> : <div className="of-thumb" aria-hidden="true"><span /><span /><span style={{ height: 40 }} /></div>}
          </aside>
        </div>
        <div className="oa-actions">
          <a className="btn" {...linkProps(`${base}/review/${versionId}`)}>戻る</a>
          <button type="button" className="btn btn-p" disabled={!items || saving} onClick={() => setPublishing('ask')}>次へ（使い始める）</button>
        </div>
      </main>
      {drawer && (
        <>
          <div className="oa-backdrop" onClick={() => !saving && setDrawer(null)} />
          <aside className="oa-drawer" role="dialog" aria-modal="true" aria-label={drawer.index === null ? '聞き取ることを足す' : `「${items?.[drawer.index]?.name}」を直す`}>
            <div className="oa-drawer-head">
              <div><h2>{drawer.index === null ? '聞き取ることを足す' : `「${items?.[drawer.index]?.name}」を直す`}</h2><p>{k.name}・この事業所だけ</p></div>
              <button type="button" aria-label="閉じる" onClick={() => setDrawer(null)}>×</button>
            </div>
            <div className="oa-fields">
              <label className="oa-field">
                <span>名前</span>
                <input className={drawer.bad ? 'bad' : ''} value={drawer.name} maxLength={40} placeholder="例: ペット" onChange={(e) => setDrawer({ ...drawer, name: e.target.value, bad: false })} />
                {drawer.bad && <span className="of-err">名前を書いてください。</span>}
              </label>
              <label className="oa-field">
                <span>何を聞き取るか</span>
                <textarea value={drawer.guide} maxLength={400} placeholder="例: ペットの有無と、世話を誰がしているか。この話は「ペットの有無」の欄に書く。" onChange={(e) => setDrawer({ ...drawer, guide: e.target.value })} />
              </label>
            </div>
            <div className="oa-drawer-actions">
              {drawer.index !== null && <button type="button" className="del" disabled={saving} onClick={() => void remove()}>この項目を消す</button>}
              <button type="button" className="btn" disabled={saving} onClick={() => setDrawer(null)}>やめる</button>
              <button type="button" className="btn btn-p" disabled={saving} onClick={() => void saveDrawer()}>{drawer.index === null ? '足す' : '保存'}</button>
            </div>
          </aside>
        </>
      )}
      {publishing && <AddPublishDialog name={k.name} busy={publishing === 'busy'} error={publishError} onCancel={() => setPublishing(null)} onOk={() => void publish()} />}
    </OfficeShell>
  )
}
