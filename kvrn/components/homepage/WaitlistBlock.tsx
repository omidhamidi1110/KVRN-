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
      setErrMsg('Please enter a valid email address.')
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
    <section
      className="relative min-h-[100svh] flex items-center bg-[#0E0E0E] overflow-hidden"
      aria-labelledby="waitlist-heading"
    >
      {/* Subtle background texture */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{ backgroundImage: 'radial-gradient(circle at 30% 60%, #F0EDE8 0%, transparent 60%)' }}
        aria-hidden="true"
      />

      <div className="container-kvrn w-full py-24 md:py-32 relative z-10">
        <div className="max-w-2xl">

          {/* Eyebrow */}
          <p className="text-[11px] font-light tracking-[0.18em] uppercase text-[#F0EDE8]/30 mb-8">
            KVRN
          </p>

          {/* Headline */}
          <h2
            id="waitlist-heading"
            className="font-display font-light text-[clamp(36px,6vw,72px)] leading-[0.9] tracking-[-0.03em] text-[#F0EDE8] mb-8"
          >
            {t.builtFor}<br />
            {t.designedFor}
          </h2>

          {/* Sub */}
          <p className="text-[16px] font-light text-[#F0EDE8]/60 leading-relaxed mb-2">
            {t.earlyAccess}
          </p>
          <p className="text-[14px] font-light text-[#F0EDE8]/35 mb-10">
            {t.dropsOnly}
          </p>

          {/* Form */}
          {state === 'success' ? (
            <div>
              <p className="text-[22px] font-light text-[#F0EDE8]">{t.onTheList}</p>
              <p className="text-[13px] text-[#F0EDE8]/40 mt-2">{t.collectionOnly}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div className="flex gap-0 max-w-[440px]">
                <label htmlFor="hp-waitlist-email" className="sr-only">
                  {t.emailPlaceholder}
                </label>
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
                  className="flex-1 h-12 px-4 text-[13px] font-light bg-white/8 border border-[#F0EDE8]/20 text-[#F0EDE8] placeholder:text-[#F0EDE8]/30 focus:outline-none focus:border-[#F0EDE8]/50 transition-colors"
                />
                <button
                  type="submit"
                  disabled={state === 'loading'}
                  aria-busy={state === 'loading'}
                  className="h-12 px-7 text-[11px] font-light tracking-[0.14em] uppercase bg-[#F0EDE8] text-[#0E0E0E] hover:bg-white transition-colors flex-shrink-0 disabled:opacity-50"
                >
                  {state === 'loading' ? '…' : t.joinBtn}
                </button>
              </div>

              {errMsg && (
                <p role="alert" className="text-[12px] text-red-400 font-light">{errMsg}</p>
              )}

              <p className="text-[11px] font-light text-[#F0EDE8]/25 tracking-wide">
                {t.collectionOnly}
              </p>
            </form>
          )}
        </div>
      </div>
    </section>
  )
}
