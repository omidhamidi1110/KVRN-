'use client'
import { useState } from 'react'
import { portalFetch } from '@/lib/affiliate-portal-ui'

export function LoginClient() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true); setError(null); setMessage(null)
    const r = await portalFetch<{ message?: string }>('/api/affiliate/auth/request', { method: 'POST', body: { email } })
    setBusy(false)
    if (r.ok) setMessage(r.data?.message ?? 'If that email belongs to an approved affiliate, a sign-in link is on its way.')
    else setError(r.error ?? 'Something went wrong. Try again.')
  }

  return (
    <div className="mx-auto max-w-[420px] rounded-[14px] border border-black/[0.08] bg-white p-6">
      <h1 className="text-[18px] font-medium">Sign in</h1>
      <p className="mt-1 text-[13px] text-[#6B6B66]">Enter the email you applied with. We will send you a one-time link. There is no password.</p>
      <form onSubmit={submit} className="mt-4" noValidate>
        <label htmlFor="aff-email" className="mb-1 block text-[12px] font-medium text-[#4A4A46]">Email</label>
        <input id="aff-email" type="email" autoComplete="email" inputMode="email" required value={email}
          onChange={e => setEmail(e.target.value)} maxLength={254}
          className="h-11 w-full rounded-[9px] border border-black/[0.18] bg-white px-3 text-[14px] focus:border-[#171717] focus:outline-none focus:ring-1 focus:ring-[#171717]" />
        <button type="submit" disabled={busy || email.trim().length < 3}
          className="mt-4 h-11 w-full rounded-[9px] bg-[#171717] text-[13px] font-medium text-white disabled:opacity-50">
          {busy ? 'Sending…' : 'Email me a sign-in link'}
        </button>
      </form>
      {message && <p role="status" className="mt-4 rounded-[9px] border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-2 text-[13px] text-[#166534]">{message}</p>}
      {error && <p role="alert" className="mt-4 rounded-[9px] border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-[13px] text-[#991B1B]">{error}</p>}
      <p className="mt-5 text-[12px] text-[#8A8A85]">Not an affiliate yet? Questions? Write to support@kvrn.shop.</p>
    </div>
  )
}
