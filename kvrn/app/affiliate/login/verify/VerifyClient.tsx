'use client'
// The sign-in token lives in the URL FRAGMENT (#t=...). Browsers never send a fragment to a server, so it is absent
// from request logs and Referer headers, and email link scanners that only fetch the URL cannot redeem it (redeeming
// needs this script AND a deliberate click). The fragment is removed from the address bar before anything else runs.
import { useEffect, useRef, useState } from 'react'
import { extractFragmentToken, portalFetch } from '@/lib/affiliate-portal-ui'

export function VerifyClient() {
  const tokenRef = useRef<string | null>(null)
  const [state, setState] = useState<'checking' | 'ready' | 'working' | 'invalid' | 'limited'>('checking')

  useEffect(() => {
    const t = extractFragmentToken(window.location.hash)
    tokenRef.current = t
    try { window.history.replaceState(null, '', window.location.pathname) } catch { /* ignore */ }
    setState(t ? 'ready' : 'invalid')
  }, [])

  async function confirm() {
    const token = tokenRef.current
    if (!token) { setState('invalid'); return }
    setState('working')
    const r = await portalFetch('/api/affiliate/auth/verify', { method: 'POST', body: { token } })
    tokenRef.current = null
    if (r.ok) { window.location.replace('/affiliate/portal'); return }
    setState(r.status === 429 ? 'limited' : 'invalid')
  }

  return (
    <div className="mx-auto max-w-[420px] rounded-[14px] border border-black/[0.08] bg-white p-6">
      <h1 className="text-[18px] font-medium">Confirm sign-in</h1>
      {state === 'checking' && <p className="mt-2 text-[13px] text-[#6B6B66]">One moment…</p>}
      {(state === 'ready' || state === 'working') && (
        <>
          <p className="mt-1 text-[13px] text-[#6B6B66]">Continue to open your affiliate portal on this device.</p>
          <button type="button" onClick={confirm} disabled={state === 'working'}
            className="mt-4 h-11 w-full rounded-[9px] bg-[#171717] text-[13px] font-medium text-white disabled:opacity-50">
            {state === 'working' ? 'Signing in…' : 'Open my portal'}
          </button>
        </>
      )}
      {state === 'invalid' && (
        <>
          <p role="alert" className="mt-2 text-[13px] text-[#991B1B]">This sign-in link is invalid or has expired.</p>
          <a href="/affiliate/login" className="mt-4 inline-block text-[13px] underline underline-offset-2">Request a new link</a>
        </>
      )}
      {state === 'limited' && <p role="alert" className="mt-2 text-[13px] text-[#991B1B]">Too many attempts. Please wait a few minutes and try again.</p>}
    </div>
  )
}
