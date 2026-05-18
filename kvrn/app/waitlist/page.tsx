'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useI18n } from '@/context/I18nContext'
import { isValidEmail } from '@/lib/utils'

type State = 'idle' | 'loading' | 'success' | 'error'

export default function WaitlistPage() {
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
        body: JSON.stringify({ email: email.trim(), source: 'waitlist_page' }),
      })
      if (!res.ok) throw new Error()
      setState('success')
    } catch {
      setState('error')
      setErrMsg('Something went wrong. Please try again.')
    }
  }

  return (
    <div className="min-h-screen bg-[#0E0E0E] flex flex-col" aria-labelledby="waitlist-page-heading">

      {/* Main canvas */}
      <div className="flex-1 flex items-center">
        <div className="container-kvrn w-full pt-[calc(36px+56px+48px)] pb-24">

          {state === 'success' ? (
            <div className="max-w-lg">
              <p className="text-[11px] font-light tracking-[0.18em] uppercase text-[#F0EDE8]/30 mb-10">
                KVRN
              </p>
              <h1 className="font-display font-light text-[clamp(40px,7vw,80px)] leading-[0.9] tracking-[-0.03em] text-[#F0EDE8] mb-6">
                {t.onTheList}
              </h1>
              <p className="text-[15px] font-light text-[#F0EDE8]/50 mb-10">
                {t.collectionOnly}
              </p>
              <Link
                href="/shop"
                className="inline-flex items-center h-11 px-8 border border-[#F0EDE8]/30 text-[11px] font-light tracking-[0.14em] uppercase text-[#F0EDE8]/70 hover:bg-[#F0EDE8] hover:text-[#0E0E0E] hover:border-[#F0EDE8] transition-all duration-300"
              >
                {t.shopNow}
              </Link>
            </div>
          ) : (
            <div className="max-w-lg">
              <p className="text-[11px] font-light tracking-[0.18em] uppercase text-[#F0EDE8]/30 mb-10">
                KVRN
              </p>

              <h1
                id="waitlist-page-heading"
                className="font-display font-light text-[clamp(40px,7vw,80px)] leading-[0.9] tracking-[-0.03em] text-[#F0EDE8] mb-7"
              >
                {t.builtFor}<br />{t.designedFor}
              </h1>

              <p className="text-[16px] font-light text-[#F0EDE8]/60 leading-relaxed mb-2">
                {t.earlyAccess}
              </p>
              <p className="text-[14px] font-light text-[#F0EDE8]/30 mb-12">
                {t.dropsOnly}
              </p>

              <form onSubmit={handleSubmit} noValidate className="space-y-4">
                <div className="flex gap-0">
                  <label htmlFor="waitlist-page-email" className="sr-only">
                    {t.emailPlaceholder}
                  </label>
                  <input
                    id="waitlist-page-email"
                    type="email"
                    autoComplete="email"
                    placeholder={t.emailPlaceholder}
                    value={email}
                    onChange={e => { setEmail(e.target.value); setErrMsg('') }}
                    required
                    className="flex-1 h-13 px-5 text-[14px] font-light bg-white/6 border border-[#F0EDE8]/20 text-[#F0EDE8] placeholder:text-[#F0EDE8]/25 focus:outline-none focus:border-[#F0EDE8]/50 transition-colors h-12"
                  />
                  <button
                    type="submit"
                    disabled={state === 'loading'}
                    className="h-12 px-8 text-[11px] font-light tracking-[0.14em] uppercase bg-[#F0EDE8] text-[#0E0E0E] hover:bg-white transition-colors flex-shrink-0 disabled:opacity-50"
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
            </div>
          )}
        </div>
      </div>

      {/* Footer strip */}
      <div className="border-t border-[#F0EDE8]/8">
        <div className="container-kvrn py-5 flex items-center justify-between">
          <p className="text-[11px] font-light text-[#F0EDE8]/20 tracking-wide">
            © {new Date().getFullYear()} KVRN
          </p>
          <Link href="/shop" className="text-[11px] font-light text-[#F0EDE8]/30 hover:text-[#F0EDE8]/60 transition-colors tracking-wide uppercase">
            {t.shopNow}
          </Link>
        </div>
      </div>
    </div>
  )
}
