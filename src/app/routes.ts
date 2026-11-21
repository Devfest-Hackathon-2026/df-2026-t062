// URL と画面の対応（数が少ないので、ライブラリを使わない）。移るときは lib/router.tsx の navigate を使う
import { useEffect, useState } from 'react'

export type Route =
  | { name: 'list' }
  | { name: 'client', id: string, doc?: string }
  | { name: 'login' }
  // 責任者の書類の設定（#102）。kind は書類の種類の key
  | { name: 'office' }
  | { name: 'officeKind', kind: string }
  | { name: 'officeUpload', kind: string }
  | { name: 'officeReview', kind: string, versionId: string }

export function parse(path: string, search = ''): Route {
  const m = /^\/clients\/([0-9a-f-]{36})\/?$/.exec(path)
  if (m) return { name: 'client', id: m[1], doc: new URLSearchParams(search).get('doc') ?? undefined }
  if (path === '/login') return { name: 'login' }
  if (path === '/office' || path === '/office/') return { name: 'office' }
  const o = /^\/office\/forms\/([^/]+)(?:\/(upload|review\/([0-9a-f-]{36})))?\/?$/.exec(path)
  if (o) {
    const kind = decodeURIComponent(o[1])
    if (o[2] === 'upload') return { name: 'officeUpload', kind }
    if (o[3]) return { name: 'officeReview', kind, versionId: o[3] }
    return { name: 'officeKind', kind }
  }
  return { name: 'list' }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname, location.search))
  useEffect(() => {
    const on = () => setRoute(parse(location.pathname, location.search))
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return route
}
