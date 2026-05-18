'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

export function ScrollCue() {
  const [scrollY,    setScrollY]    = useState(0)
  const [mounted,    setMounted]    = useState(false)

  useEffect(() => {
    setMounted(true)
    const onScroll = () => setScrollY(window.scrollY)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const showDown = scrollY < 80
  const showUp   = mounted && scrollY > (typeof window !== 'undefined' ? window.innerHeight * 0.8 : 600)

  const scrollToTop = () => window.scrollTo({ top: 0, behavior: 'smooth' })

  if (!mounted) return null

  return (
    <>
      {/* Downward cue — visible until user scrolls */}
      <div
        aria-hidden="true"
        className={cn(
          'fixed bottom-8 left-1/2 -translate-x-1/2 z-[190]',
          'flex flex-col items-center gap-1.5 pointer-events-none',
          'transition-opacity duration-700',
          showDown ? 'opacity-100' : 'opacity-0'
        )}
      >
        <span className="text-[10px] font-light tracking-widest text-kvrn-text-on-dark uppercase">Scroll</span>
        <svg
          width="16" height="24" viewBox="0 0 16 24" fill="none"
          className="animate-bounce text-kvrn-text-on-dark"
        >
          <path d="M8 4v12M3 13l5 5 5-5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* Upward back-to-top — appears after scrolling one viewport */}
      <button
        onClick={scrollToTop}
        aria-label="Return to top"
        className={cn(
          'fixed bottom-6 right-6 z-[190] w-9 h-9',
          'flex items-center justify-center',
          'border border-kvrn-border bg-kvrn-bg/90 backdrop-blur-sm',
          'hover:bg-kvrn-text hover:text-kvrn-bg hover:border-kvrn-text',
          'transition-all duration-300',
          showUp ? 'opacity-100 translate-y-0 pointer-events-auto'
                 : 'opacity-0 translate-y-2 pointer-events-none'
        )}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M6 10V2M2 6l4-4 4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </>
  )
}
