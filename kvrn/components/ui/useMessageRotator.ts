'use client'
import { useEffect, useRef, useState } from 'react'

/** Shared timing for the public announcement bar and the admin preview (identical cadence/fade/order). */
export const ANNOUNCE_INTERVAL = 6000
export const ANNOUNCE_FADE_MS = 500

/**
 * Cycles an index through `count` messages in order: visible for INTERVAL, fade out for FADE_MS, advance, fade in.
 * `enabled=false` (paused / prefers-reduced-motion / <2 messages) keeps the current index and never fades.
 */
export function useMessageRotator(count: number, enabled: boolean) {
  const [idx, setIdx] = useState(0)
  const [fading, setFading] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!enabled || count < 2) { setFading(false); return }
    const timer = setInterval(() => {
      setFading(true)
      timeoutRef.current = setTimeout(() => { setIdx(i => (i + 1) % count); setFading(false) }, ANNOUNCE_FADE_MS)
    }, ANNOUNCE_INTERVAL)
    return () => { clearInterval(timer); if (timeoutRef.current) clearTimeout(timeoutRef.current) }
  }, [enabled, count])

  // keep idx in range if messages are removed while editing
  const safeIdx = count > 0 ? idx % count : 0
  return { idx: safeIdx, fading, setIdx, reset: () => { setIdx(0); setFading(false) } }
}
