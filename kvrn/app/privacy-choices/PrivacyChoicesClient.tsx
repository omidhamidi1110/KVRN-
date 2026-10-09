'use client'

import { useCookiePrefs, type CookiePrefs } from '@/context/CookiePrefsContext'
import { effectiveAnalyticsConsent } from '@/lib/consent-effective'

const safeDefaults: CookiePrefs = {
  essential: true,
  personalization: false,
  analytics: false,
  advertising: false,
  doNotSell: true,
}

export function PrivacyChoicesClient() {
  const { prefs, savePrefs, openPreferences } = useCookiePrefs()
  const current = prefs ?? safeDefaults
  const optOut = () => savePrefs({ ...current, essential: true, advertising: false, doNotSell: true })
  const disableAnalytics = () => savePrefs({ ...current, essential: true, analytics: false })
  return (
    <section aria-labelledby="privacy-controls" className="space-y-5 border-y border-[#E8E5E0] py-8 my-10">
      <h2 id="privacy-controls" className="text-lg font-light text-[#1A1A1A]">Your current browser choices</h2>
      <p role="status" className="text-sm text-[#6B6B6B]">
        Optional analytics: {effectiveAnalyticsConsent(current.analytics) ? 'Enabled' : 'Disabled'}.
        {' '}Do not sell or share: {current.doNotSell ? 'Opted out' : 'Not selected'}.
      </p>
      <p className="text-sm text-[#6B6B6B]">These controls use the same first-party preference record as KVRN’s cookie banner. They apply to this browser; they do not submit a personal-information deletion request.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={openPreferences} className="min-h-11 border border-[#1A1A1A] px-4 text-xs uppercase tracking-wide hover:bg-[#1A1A1A] hover:text-white">
          Open Cookie Preferences
        </button>
        <button type="button" onClick={disableAnalytics} className="min-h-11 border border-[#1A1A1A] px-4 text-xs uppercase tracking-wide hover:bg-[#1A1A1A] hover:text-white">
          Disable Optional Analytics
        </button>
        <button type="button" onClick={optOut} className="min-h-11 border border-[#1A1A1A] px-4 text-xs uppercase tracking-wide hover:bg-[#1A1A1A] hover:text-white">
          Opt Out of Sale or Sharing
        </button>
      </div>
    </section>
  )
}
