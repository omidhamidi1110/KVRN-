'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

// Homepage scroll cue:
// - Centered down arrow fades when user scrolls
// - Centered up arrow appears after scrolling past 80% viewport height
// Both centered, NOT bottom-right
export function ScrollCue() {
  const [scrollY,  setScrollY]  = useState(0)
  const [mounted,  setMounted]  = useState(false)
  const [vh,       setVh]       = useState(700)

  useEffect(() => {
    setMounted(true)
    setVh(window.innerHeight)
    const onScroll = () => setScrollY(window.scrollY)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const showDown = scrollY < 60
  const showUp   = mounted && scrollY > vh * 0.8

  const scrollToTop = () => window.scrollTo({ top: 0, behavior: 'smooth' })

  if (!mounted) return null

  return (
    <>
      {/* Down arrow — centered, fades on scroll */}
      <div
        aria-hidden="true"
        className={cn(
          'fixed bottom-9 left-1/2 -translate-x-1/2 z-[190]',
          'flex flex-col items-center gap-1 pointer-events-none',
          'transition-opacity duration-700',
          showDown ? 'opacity-70' : 'opacity-0'
        )}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-white">
          <path d="M10 4v10M5 9l5 5 5-5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* Up arrow — centered, appears after scrolling */}
      <button
        onClick={scrollToTop}
        aria-label="Return to top"
        className={cn(
          'fixed bottom-9 left-1/2 -translate-x-1/2 z-[190]',
          'w-9 h-9 flex items-center justify-center',
          'border border-[#E8E5E0] bg-[#F9F8F6]/90 backdrop-blur-sm',
          'hover:bg-[#181818] hover:text-white hover:border-[#181818]',
          'text-[#181818] transition-all duration-300',
          showUp
            ? 'opacity-100 translate-y-0 pointer-events-auto'
            : 'opacity-0 translate-y-2 pointer-events-none'
        )}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 11V3M3 7l4-4 4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </>
  )
}
