'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import type { ShellData } from '@/lib/content-shell'
import { activeAnnouncementMessages } from '@/lib/content-shell'
import { useMessageRotator } from './useMessageRotator'

// Announcement bar — always visible/sticky, does NOT hide on scroll
const MESSAGE_KEYS = ['announce.shipping', 'announce.arrivals', 'announce.list'] as const


/**
 * `shell` is provided only when Admin-managed content is enabled. Then the messages, the
 * enabled switch and the start/end window come from Admin; when the bar is disabled or outside
 * its window it renders an empty 36px strip (--bar-height; the nav and several heroes offset by --header-total = 92px).
 */
export function AnnouncementBar({ shell }: { shell?: ShellData | null } = {}) {
  const { locale, t } = useI18n()
  const pathname = usePathname()
  const isAdmin  = pathname === '/admin' || pathname.startsWith('/admin/')

  const [mounted, setMounted] = useState(false)
  const [now,     setNow]     = useState<Date | null>(null)

  useEffect(() => { setMounted(true); setNow(new Date()) }, [])

  // The coded messages, or the Admin ones (resolved in the visitor's language; the window is
  // evaluated in the browser so a scheduled bar appears/disappears without a redeploy).
  const cms: Array<{ id: string; text: string; href?: string }> | null =
    shell?.announcement ? activeAnnouncementMessages(shell.announcement, locale, shell.tr.announcement, now ?? new Date()) : null
  const messages = cms ?? MESSAGE_KEYS.map(k => ({ id: k, text: t[k], href: undefined as string | undefined }))

  const { idx, fading } = useMessageRotator(messages.length, mounted)

  if (isAdmin) return null

  // ONE element, ONE geometry on the server, first client render, after hydration and during rotation: a fixed 36px strip
  // (var(--bar-height)) whose text is vertically centred by flexbox with an explicit line-height. The first message is
  // rendered in the server HTML (no blank strip → text swap, no font-metric-dependent height), so a hard refresh cannot add
  // space above the text. When disabled / outside its window the strip stays (empty) so nothing below shifts.
  const current = messages.length ? messages[idx % messages.length] : null

  return (
    <div
      className="fixed inset-x-0 top-0 z-[250] box-border flex h-[var(--bar-height)] min-h-[var(--bar-height)] max-h-[var(--bar-height)] items-center justify-center overflow-hidden bg-[#0E0E0E] p-0"
      {...(current ? { 'aria-live': 'polite' as const, 'aria-label': t['announce.label'] } : { 'aria-hidden': true })}
    >
      {current && (
        <p
          suppressHydrationWarning
          className={`m-0 max-w-full truncate p-0 px-4 text-center text-[11px] font-light leading-[18px] tracking-[0.12em] text-[#F0EDE8] ${current.href ? '' : 'select-none '}transition-opacity duration-500 motion-reduce:transition-none`}
          style={{ opacity: fading ? 0 : 1 }}
        >
          {current.href
            ? <Link href={current.href} className="hover:opacity-70 transition-opacity">{current.text}</Link>
            : current.text}
        </p>
      )}
    </div>
  )
}
