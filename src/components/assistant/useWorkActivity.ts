import { useEffect, useState } from 'react'

const SECOND = 1000
const MINUTE = 60 * SECOND
const ACTIVE_GAP = MINUTE
const AWAY_AFTER = 10 * MINUTE
const QUIET_AFTER = 3 * SECOND
const BREAK_LEVELS = [30 * MINUTE, 60 * MINUTE]
const preferenceKey = 'pet-break-reminders-hidden-day'
const events = ['pointerdown', 'keydown', 'input', 'wheel', 'focusout'] as const
const localDay = () => new Date().toLocaleDateString('sv-SE')

export function useWorkActivity(enabled: boolean) {
  const [breakLevel, setBreakLevel] = useState(0)
  const [returned, setReturned] = useState(0)
  const [hiddenDay, setHiddenDay] = useState(() => {
    try { return localStorage.getItem(preferenceKey) }
    catch { return null }
  })

  useEffect(() => {
    if (!enabled) { setBreakLevel(0); return }
    let last = 0
    let hiddenAt = 0
    let activeTime = 0
    let reached = 0
    let timer: ReturnType<typeof setTimeout>

    const resetAfterAbsence = () => {
      activeTime = reached = 0
      setBreakLevel(0)
      setReturned((count) => count + 1)
    }
    const settle = () => {
      if (document.hidden || document.activeElement?.matches('textarea, input:not([type="button"]):not([type="checkbox"]):not([type="radio"]), [contenteditable="true"]')) return
      const level = BREAK_LEVELS.filter((threshold) => activeTime >= threshold).length
      if (level > reached) {
        reached = level
        setBreakLevel(level)
      }
    }
    const activity = (event: Event) => {
      if (document.hidden || !(event.target instanceof Element) || !event.target.closest('.pc-work')) return
      const now = Date.now()
      if (last && now - last >= AWAY_AFTER) resetAfterAbsence()
      // 操作が続いた区間だけを足す。タブを開いたままの待ち時間は数えない。
      if (last && now - last <= ACTIVE_GAP) activeTime += now - last
      last = now
      clearTimeout(timer)
      timer = setTimeout(settle, QUIET_AFTER)
    }
    const visibility = () => {
      clearTimeout(timer)
      if (document.hidden) {
        hiddenAt = Date.now()
      } else {
        if (hiddenAt && last && Date.now() - last >= AWAY_AFTER) resetAfterAbsence()
        hiddenAt = last = 0
      }
    }
    for (const event of events) document.addEventListener(event, activity, { capture: true, passive: true })
    document.addEventListener('visibilitychange', visibility)
    return () => {
      clearTimeout(timer)
      for (const event of events) document.removeEventListener(event, activity, true)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [enabled])

  return {
    breakLevel: hiddenDay === localDay() ? 0 : breakLevel,
    returned,
    dismissBreak: () => setBreakLevel(0),
    hideBreaksToday: () => {
      const day = localDay()
      setHiddenDay(day)
      setBreakLevel(0)
      try { localStorage.setItem(preferenceKey, day) } catch { /* 現在の画面では非表示のまま */ }
    },
  }
}
