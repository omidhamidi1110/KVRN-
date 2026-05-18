'use client'

import { useEffect, useState, useCallback } from 'react'
import { useHeader } from '@/context/HeaderContext'

const MESSAGES = [
  'Complimentary U.S. shipping on orders above $150',
  'Join the mailing list for $10 off your first order',
  'Most orders ship within 1–3 business days',
  'New arrivals available — shop the Phantom collection',
  'Secure checkout',
]

const INTERVAL   = 6000  // 6s per message
const FADE_MS    = 600   // fade duration

export function AnnouncementBar() {
  const { barVisible, hideBar } = useHeader()
  const [idx,     setIdx]     = useState(0)
  const [fading,  setFading]  = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  // Hide bar on scroll past 80px
  useEffect(() => {
    if (!mounted) return
    const onScroll = () => { if (window.scrollY > 80) hideBar() }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [mounted, hideBar])

  // Rotate messages
  useEffect(() => {
    if (!barVisible) return
    const timer = setInterval(() => {
      setFading(true)
      setTimeout(() => {
        setIdx(i => (i + 1) % MESSAGES.length)
        setFading(false)
      }, FADE_MS)
    }, INTERVAL)
    return () => clearInterval(timer)
  }, [barVisible])

  if (!mounted || !barVisible) return null

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[250] h-[36px] flex items-center justify-center bg-kvrn-text text-kvrn-bg overflow-hidden"
      aria-live="polite"
      aria-label="Announcement"
    >
      <p
        className="text-[11px] font-light tracking-widest text-center px-4 transition-opacity duration-500 select-none"
        style={{ opacity: fading ? 0 : 1 }}
      >
        {MESSAGES[idx]}
      </p>
    </div>
  )
}
