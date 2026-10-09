'use client'

import { useI18n } from '@/context/I18nContext'
import { fillMessages } from '@/lib/i18n/messages'
import { useCookiePrefs } from '@/context/CookiePrefsContext'

/** Both the standalone Cookies page and the CMS embed use the actual preference store. */
export function CookieControls() {
  const t = fillMessages(useI18n().t)
  const { prefs, acceptAll, denyNonEssential, openPreferences } = useCookiePrefs()
  return (
    <div className="space-y-4">
      <p className="text-[14px] text-kvrn-muted leading-relaxed">{t['cookies.controls.intro']}</p>
      <p role="status" className="text-[13px] text-kvrn-muted">
        Optional analytics: {prefs?.analytics ? 'Selected (browser privacy signals may still block tracking)' : 'Off'}
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={acceptAll}
          className="text-[11px] font-light tracking-widest uppercase border border-kvrn-text px-4 min-h-10 hover:bg-kvrn-text hover:text-kvrn-bg transition-colors duration-150">
          {t['cookies.controls.accept']}
        </button>
        <button type="button" onClick={denyNonEssential}
          className="text-[11px] font-light tracking-widest uppercase text-kvrn-muted hover:text-kvrn-text transition-colors duration-150 min-h-10">
          {t['cookies.controls.decline']}
        </button>
        <button type="button" onClick={openPreferences}
          className="text-[11px] font-light tracking-widest uppercase text-kvrn-text underline underline-offset-4 min-h-10">
          Manage preferences
        </button>
      </div>
      <p className="text-[13px] text-kvrn-muted leading-relaxed">{t['cookies.controls.browser']}</p>
    </div>
  )
}
