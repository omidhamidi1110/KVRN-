'use client'

import { createContext, useContext, useState, useEffect, useCallback } from 'react'

export interface CookiePrefs {
  essential:     true          // always on, cannot be disabled
  personalization: boolean
  analytics:     boolean
  advertising:   boolean
  doNotSell:     boolean
}

export interface CookiePrefsCtx {
  prefs:          CookiePrefs | null  // null = not yet chosen
  savePrefs:      (p: CookiePrefs) => void
  acceptAll:      () => void
  denyNonEssential: () => void
  openPreferences: () => void
  showBanner:     boolean
  showPrefs:      boolean
  closeBanner:    () => void
  closePrefs:     () => void
}

const STORAGE_KEY = 'kvrn_cookie_prefs_v2'
const EXPIRY_MS   = 365 * 24 * 60 * 60 * 1000

const DEFAULT_PREFS: CookiePrefs = {
  essential:       true,
  personalization: false,
  analytics:       false,
  advertising:     false,
  doNotSell:       true,
}

function read(): CookiePrefs | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const { prefs, ts } = JSON.parse(raw) as { prefs: CookiePrefs; ts: number }
    if (Date.now() - ts > EXPIRY_MS) { localStorage.removeItem(STORAGE_KEY); return null }
    return prefs
  } catch { return null }
}

function write(prefs: CookiePrefs) {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ prefs, ts: Date.now() }))
}

function applyToGtag(prefs: CookiePrefs) {
  if (typeof window === 'undefined' || !(window as any).gtag) return
  ;(window as any).gtag('consent', 'update', {
    analytics_storage:      prefs.analytics ? 'granted' : 'denied',
    ad_storage:             prefs.advertising ? 'granted' : 'denied',
    personalization_storage:prefs.personalization ? 'granted' : 'denied',
    functionality_storage:  'granted',
  })
}

const Ctx = createContext<CookiePrefsCtx>({
  prefs: null, savePrefs: () => {}, acceptAll: () => {},
  denyNonEssential: () => {}, openPreferences: () => {},
  showBanner: false, showPrefs: false, closeBanner: () => {}, closePrefs: () => {},
})

export function CookiePrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs,      setPrefs]      = useState<CookiePrefs | null>(null)
  const [showBanner, setShowBanner] = useState(false)
  const [showPrefs,  setShowPrefs]  = useState(false)
  const [mounted,    setMounted]    = useState(false)

  useEffect(() => {
    setMounted(true)
    const stored = read()
    if (stored) {
      setPrefs(stored)
      applyToGtag(stored)
    } else {
      const t = setTimeout(() => setShowBanner(true), 1800)
      return () => clearTimeout(t)
    }
  }, [])

  // Listen for custom event from homepage footer (which can't use context directly)
  useEffect(() => {
    const handler = () => setShowPrefs(true)
    window.addEventListener('kvrn-open-cookie-prefs', handler)
    return () => window.removeEventListener('kvrn-open-cookie-prefs', handler)
  }, [])

  const savePrefs = useCallback((p: CookiePrefs) => {
    const final = { ...p, essential: true as const }
    setPrefs(final)
    write(final)
    applyToGtag(final)
    setShowBanner(false)
    setShowPrefs(false)
  }, [])

  const acceptAll = useCallback(() => {
    savePrefs({ essential: true, personalization: true, analytics: true, advertising: false, doNotSell: true })
  }, [savePrefs])

  const denyNonEssential = useCallback(() => {
    savePrefs(DEFAULT_PREFS)
  }, [savePrefs])

  const openPreferences = useCallback(() => {
    setShowPrefs(true)
    setShowBanner(false)
  }, [])

  return (
    <Ctx.Provider value={{
      prefs, savePrefs, acceptAll, denyNonEssential, openPreferences,
      showBanner, showPrefs,
      closeBanner: () => setShowBanner(false),
      closePrefs:  () => setShowPrefs(false),
    }}>
      {children}
    </Ctx.Provider>
  )
}

export function useCookiePrefs() { return useContext(Ctx) }
