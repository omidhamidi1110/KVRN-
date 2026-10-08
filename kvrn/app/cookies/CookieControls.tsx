'use client'

import { useI18n } from '@/context/I18nContext'
import { fillMessages } from '@/lib/i18n/messages'

export function CookieControls() {
  const t = fillMessages(useI18n().t)
  const handleAccept = () => {
    localStorage.setItem('kvrn_cookie_consent', JSON.stringify({ state: 'granted', ts: Date.now() }))
    window.location.reload()
  }

  const handleDecline = () => {
    localStorage.setItem('kvrn_cookie_consent', JSON.stringify({ state: 'denied', ts: Date.now() }))
    window.location.reload()
  }

  return (
    <div className="space-y-4">
      <p className="text-[14px] text-kvrn-muted leading-relaxed">
        {t['cookies.controls.intro']}
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          onClick={handleAccept}
          className="text-[11px] font-light tracking-widest uppercase border border-kvrn-text px-4 h-9 hover:bg-kvrn-text hover:text-kvrn-bg transition-colors duration-150"
        >
          {t['cookies.controls.accept']}
        </button>
        <button
          onClick={handleDecline}
          className="text-[11px] font-light tracking-widest uppercase text-kvrn-muted hover:text-kvrn-text transition-colors duration-150"
        >
          {t['cookies.controls.decline']}
        </button>
      </div>
      <p className="text-[13px] text-kvrn-muted leading-relaxed">
        {t['cookies.controls.browser']}
      </p>
    </div>
  )
}
