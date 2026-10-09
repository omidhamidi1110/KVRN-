'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import type { ShellData } from '@/lib/content-shell'
import { activeAnnouncementMessages } from '@/lib/content-shell'

// Announcement bar — always visible/sticky, does NOT hide on scroll
const MESSAGE_KEYS = ['announce.shipping', 'announce.arrivals', 'announce.list'] as const

const INTERVAL = 6000
const FADE_MS  = 500

/**
 * `shell` is provided only when Admin-managed content is enabled. Then the messages, the
 * enabled switch and the start/end window come from Admin; when the bar is disabled or outside
 * its window it renders an empty 28px strip (many components hardcode the 28px offset).
 */
export function AnnouncementBar({ shell }: { shell?: ShellData | null } = {}) {
  const { locale, t } = useI18n()
  const pathname = usePathname()
  const isAdmin  = pathname === '/admin' || pathname.startsWith('/admin/')

  const [idx,     setIdx]     = useState(0)
  const [fading,  setFading]  = useState(false)
  const [mounted, setMounted] = useState(false)
  const [now,     setNow]     = useState<Date | null>(null)

  useEffect(() => { setMounted(true); setNow(new Date()) }, [])

  // The coded messages, or the Admin ones (resolved in the visitor's language; the window is
  // evaluated in the browser so a scheduled bar appears/disappears without a redeploy).
  const cms: Array<{ id: string; text: string; href?: string }> | null =
    shell?.announcement ? activeAnnouncementMessages(shell.announcement, locale, shell.tr.announcement, now ?? new Date()) : null
  const messages = cms ?? MESSAGE_KEYS.map(k => ({ id: k, text: t[k], href: undefined as string | undefined }))

  useEffect(() => {
    if (!mounted || messages.length < 2) return
    const timer = setInterval(() => {
      setFading(true)
      setTimeout(() => {
        setIdx(i => (i + 1) % messages.length)
        setFading(false)
      }, FADE_MS)
    }, INTERVAL)
    return () => clearInterval(timer)
  }, [mounted, messages.length])

  if (isAdmin) return null

  if (!mounted) return (
    <div className="fixed top-0 left-0 right-0 z-[250] h-[28px] bg-[#0E0E0E]" aria-hidden="true" />
  )

  // Disabled / outside its window: keep the 28px strip so nothing below shifts.
  if (messages.length === 0) return (
    <div className="fixed top-0 left-0 right-0 z-[250] h-[28px] bg-[#0E0E0E]" aria-hidden="true" />
  )
  const current = messages[idx % messages.length]

  return (
    <div
      className="fixed inset-x-0 top-0 z-[250] h-[28px] min-h-[28px] max-h-[28px] leading-none flex items-center justify-center bg-[#0E0E0E] overflow-hidden"
      aria-live="polite"
      aria-label={t['announce.label']}
    >
      <p
        className={`relative -top-px m-0 max-w-full px-4 text-center text-[11px] font-light leading-none tracking-[0.12em] text-[#F0EDE8] ${current.href ? '' : 'select-none '}transition-opacity duration-500`}
        style={{ opacity: fading ? 0 : 1 }}
      >
        {current.href
          ? <Link href={current.href} className="hover:opacity-70 transition-opacity">{current.text}</Link>
          : current.text}
      </p>
    </div>
  )
}
