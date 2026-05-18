'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

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

  if (!mounted) return null

  return (
    <>
      {/* Down arrow — centered, fades on scroll */}
      <div
        aria-hidden="true"
        className={cn(
          'fixed bottom-10 left-1/2 -translate-x-1/2 z-[190] pointer-events-none',
          'transition-opacity duration-700',
          showDown ? 'opacity-60' : 'opacity-0'
        )}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" className="text-white animate-bounce">
          <path d="M10 4v10M5 9l5 5 5-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* Up arrow circle — right side, appears after scrolling */}
      <button
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        aria-label="Return to top"
        className={cn(
          'fixed bottom-7 right-6 z-[190]',
          'w-9 h-9 rounded-full flex items-center justify-center',
          'bg-[#F9F8F6]/90 backdrop-blur-sm border border-[#E8E5E0]',
          'text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white hover:border-[#1A1A1A]',
          'transition-all duration-300 shadow-sm',
          showUp
            ? 'opacity-100 translate-y-0 pointer-events-auto'
            : 'opacity-0 translate-y-3 pointer-events-none'
        )}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 11V3M3 7l4-4 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
    </>
  )
}
