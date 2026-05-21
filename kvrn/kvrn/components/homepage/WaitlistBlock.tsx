'use client'

import { useState } from 'react'
import { useI18n } from '@/context/I18nContext'
import { isValidEmail } from '@/lib/utils'

type State = 'idle' | 'loading' | 'success' | 'error'

export function WaitlistBlock() {
  const { t }    = useI18n()
  const [email,  setEmail]  = useState('')
  const [state,  setState]  = useState<State>('idle')
  const [errMsg, setErrMsg] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErrMsg('')
    if (!email.trim() || !isValidEmail(email)) {
      setErrMsg('Enter a valid email address.')
      return
    }
    setState('loading')
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), source: 'homepage' }),
      })
      if (!res.ok) throw new Error()
      setState('success')
    } catch {
      setState('error')
      setErrMsg('Something went wrong. Please try again.')
    }
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-[#0E0E0E]">
      {/* Subtle radial glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse 70% 60% at 50% 45%, rgba(240,237,232,0.04) 0%, transparent 70%)' }}
        aria-hidden="true"
      />

      {/* Main content — centered */}
      <div className="flex-1 flex items-center justify-center px-6 md:px-8">
        <div className="w-full max-w-[480px] text-center">
          <p className="text-[11px] font-light tracking-[0.22em] uppercase text-white mb-8">
            KVRN
          </p>

          <h2 className="font-display font-light text-[clamp(36px,6vw,68px)] leading-[0.88] tracking-[-0.03em] text-[#F0EDE8] mb-6">
            {t.builtFor}<br />{t.designedFor}
          </h2>

          <p className="text-[15px] font-light text-[#FFFFFF] leading-relaxed mb-2">
            {t.earlyAccess}
          </p>
          <p className="text-[13px] font-light text-[#FFFFFF] mb-10">
            {t.dropsOnly}
          </p>

          {state === 'success' ? (
            <div className="space-y-2">
              <p className="text-[20px] font-light text-[#F0EDE8]">{t.onTheList}</p>
              <p className="text-[13px] text-[#F0EDE8]/35">{t.collectionOnly}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate className="space-y-3">
              {/* Input + button — stacked on mobile, inline on sm+ */}
              <div className="flex flex-row gap-0 w-full">
                <label htmlFor="hp-waitlist-email" className="sr-only">{t.emailPlaceholder}</label>
                <input
                  id="hp-waitlist-email"
                  type="email"
                  autoComplete="email"
                  placeholder={t.emailPlaceholder}
                  value={email}
                  onChange={e => { setEmail(e.target.value); setErrMsg('') }}
                  required
                  aria-required="true"
                  aria-invalid={!!errMsg}
                  className="flex-1 h-12 rounded-none px-5 text-[13px] font-light bg-white/6 border border-[#F0EDE8]/18 text-[#F0EDE8] placeholder:text-[#FFFFFF] focus:outline-none focus:border-[#F0EDE8]/45 transition-colors border-r-0"
                />
                <button
                  type="submit"
                  disabled={state === 'loading'}
                  className="w-[170px] h-12 text-[11px] font-light tracking-[0.16em] uppercase bg-[#F0EDE8] text-[#0E0E0E] hover:bg-white transition-colors disabled:opacity-50 flex-shrink-0"
                >
                  {state === 'loading' ? '…' : t.joinBtn}
                </button>
              </div>

              {state === 'error' && (
                <p role="alert" className="text-[12px] text-[#F87171] font-light">{errMsg}</p>
              )}
              {errMsg && state !== 'error' && (
                <p role="alert" className="text-[12px] text-[#F87171] font-light">{errMsg}</p>
              )}

              <p className="text-[11px] font-light text-[#FFFFFF] tracking-wide">
                {t.collectionOnly}
              </p>
            </form>
          )}
        </div>
      </div>

      {/* Trust strip at bottom */}
      <div className="border-t border-[#F0EDE8]/8 flex-shrink-0">
        <div className="container-kvrn py-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
            {[
              ['Secure checkout',      'Encrypted payment'],
              ['Store credit returns', 'Within return window'],
              ['Ships 1–3 days',       'After confirmation'],
              ['Built to last',        'Premium materials'],
            ].map(([title, sub]) => (
              <div key={title}>
                <p className="text-[11px] font-light text-[#F0EDE8]/60">{title}</p>
                <p className="text-[10px] text-[#F0EDE8]/25 mt-0.5">{sub}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
