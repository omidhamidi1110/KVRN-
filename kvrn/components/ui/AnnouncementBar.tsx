'use client'

import { useEffect, useState } from 'react'

// Announcement bar — always visible/sticky, does NOT hide on scroll
const MESSAGES = [
  'Complimentary U.S. shipping on orders over $150',
  'New arrivals available now',
  'Join the list for $10 off your first order',
]

const INTERVAL = 6000
const FADE_MS  = 500

export function AnnouncementBar() {
  const [idx,     setIdx]     = useState(0)
  const [fading,  setFading]  = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    if (!mounted) return
    const timer = setInterval(() => {
      setFading(true)
      setTimeout(() => {
        setIdx(i => (i + 1) % MESSAGES.length)
        setFading(false)
      }, FADE_MS)
    }, INTERVAL)
    return () => clearInterval(timer)
  }, [mounted])

  if (!mounted) return (
    <div className="fixed top-0 left-0 right-0 z-[250] h-[36px] bg-[#181818]" aria-hidden="true" />
  )

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[250] h-[36px] flex items-center justify-center bg-[#181818] overflow-hidden"
      aria-live="polite"
      aria-label="Site announcement"
    >
      <p
        className="text-[11px] font-light tracking-[0.12em] text-[#F0EDE8] text-center px-4 select-none transition-opacity duration-500"
        style={{ opacity: fading ? 0 : 1 }}
      >
        {MESSAGES[idx]}
      </p>
    </div>
  )
}
