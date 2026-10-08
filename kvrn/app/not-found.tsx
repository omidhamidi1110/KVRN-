'use client'

import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import { fillMessages } from '@/lib/i18n/messages'

export default function NotFound() {
  const t = fillMessages(useI18n().t)
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <p className="label-11 text-kvrn-muted mb-4">404</p>
      <h1 className="font-display font-light text-[48px] md:text-[64px] leading-none tracking-tighter mb-4">
        {t['notfound.line1']}
        <br />
        {t['notfound.line2']}
      </h1>
      <p className="text-[15px] text-kvrn-muted mb-10">
        {t['notfound.body']}
      </p>
      <Link
        href="/"
        className="text-[13px] font-light tracking-widest uppercase border border-kvrn-text px-6 h-12 inline-flex items-center hover:bg-kvrn-text hover:text-kvrn-bg transition-colors duration-150"
      >
        {t['notfound.backHome']}
      </Link>
    </div>
  )
}
