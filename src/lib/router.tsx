// 画面の切り替えの道具（ページを読み込み直さずに URL を変える）と、PC か iPad かの見分け
import { useEffect, useState } from 'react'

export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** <a> をページの読み込みなしで動かす */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
      e.preventDefault()
      navigate(to)
    },
  }
}

/** PC か iPad か。指で触る端末で幅が 1100px 以下なら iPad の画面。?ui=pad|pc で切り替えられる */
export function useDevice(): 'pc' | 'pad' {
  const pick = () => {
    const q = new URLSearchParams(location.search).get('ui')
    if (q === 'pad' || q === 'pc') {
      try { sessionStorage.setItem('careman.ui', q) } catch { /* 使えない */ }
      return q
    }
    try {
      const s = sessionStorage.getItem('careman.ui')
      if (s === 'pad' || s === 'pc') return s
    } catch { /* 使えない */ }
    const coarse = window.matchMedia?.('(pointer: coarse)').matches
    return coarse && Math.min(window.innerWidth, window.innerHeight) <= 1100 ? 'pad' : 'pc'
  }
  const [d, setD] = useState<'pc' | 'pad'>(pick)
  useEffect(() => {
    const on = () => setD(pick())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return d
}
