'use client'
// components/admin/ui/InfoTip.tsx — the eye-style help affordance for deeper explanations.
//
// Accessibility contract (do not weaken):
//   * a real <button> with an aria-label, reachable and operable by keyboard
//   * Enter/Space toggles; Escape closes and returns focus to the button
//   * click/tap outside closes
//   * NOT hover-only: works on touch (the hit area is padded beyond the 28px visual button)
//   * aria-expanded + aria-controls wire the button to its panel
// Use it for definitions, accounting rules, methodology, provider caveats, field units
// (cents/BPS). NEVER use it to hide a destructive-action warning or a current
// Exception / Incomplete / Failed / Unresolved state — those stay visible in the page.
//
// Placement: the panel is rendered in a portal with fixed positioning so it is never clipped
// by a table's or card's overflow, and it is clamped inside the viewport (flipping above the
// button when there is no room below) so it stays readable on a phone.

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface InfoTipProps {
  /** Short accessible name, e.g. "About reserved stock". Defaults to "More information". */
  label?: string
  children: ReactNode
  /** Preferred panel alignment relative to the button (clamped to the viewport). */
  align?: 'start' | 'end'
  className?: string
}

// useLayoutEffect warns during server rendering; the panel only exists on the client.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

const GAP = 6
const EDGE = 8

export function InfoTip({ label = 'More information', children, align = 'start', className = '' }: InfoTipProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus() }
    }
    const onPointer = (e: Event) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('touchstart', onPointer, { passive: true })
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('touchstart', onPointer)
    }
  }, [open])

  // Position next to the button, clamp to the viewport, flip above when there is no room below.
  useIsoLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const btn = btnRef.current; const panel = panelRef.current
      if (!btn || !panel) return
      const b = btn.getBoundingClientRect()
      const pw = panel.offsetWidth; const ph = panel.offsetHeight
      const vw = document.documentElement.clientWidth; const vh = window.innerHeight
      let left = align === 'end' ? b.right - pw : b.left
      left = Math.max(EDGE, Math.min(left, vw - pw - EDGE))
      let top = b.bottom + GAP
      if (top + ph > vh - EDGE && b.top - ph - GAP >= EDGE) top = b.top - ph - GAP
      panel.style.left = `${Math.round(left)}px`
      panel.style.top = `${Math.round(Math.max(EDGE, top))}px`
      panel.style.visibility = 'visible'
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, align])

  return (
    <span ref={rootRef} className={`relative inline-flex align-middle ${className}`}>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(o => !o)}
        className="relative inline-flex h-7 w-7 items-center justify-center rounded-full text-[#8A8A85] transition-colors before:absolute before:-inset-2 before:content-[''] hover:bg-black/[0.05] hover:text-[#171717] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#171717]/40"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <circle cx="12" cy="12" r="2.8" stroke="currentColor" strokeWidth="1.5"/>
        </svg>
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          id={panelId}
          role="note"
          onClick={e => e.stopPropagation()}
          style={{ position: 'fixed', left: 0, top: 0, visibility: 'hidden' }}
          className="z-[200] max-h-[min(60vh,420px)] w-[280px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-[10px] border border-black/[0.09] bg-white p-3 text-left text-[12px] font-normal normal-case leading-[1.5] tracking-normal text-[#3A3A38] shadow-[0_6px_24px_rgba(0,0,0,0.10)]"
        >
          {children}
        </div>,
        document.body,
      )}
    </span>
  )
}
