'use client'

import { useState } from 'react'
import { isValidEmail, cn } from '@/lib/utils'
import { useI18n } from '@/context/I18nContext'

interface WaitlistFormProps {
  variant?:    'light' | 'dark'
  heading?:    string
  subheading?: string
  className?:  string
  source?:     string
}

type State = 'idle' | 'loading' | 'success' | 'error'

export function WaitlistForm({
  variant    = 'light',
  heading,
  subheading,
  className,
  source = 'waitlist',
}: WaitlistFormProps) {
  const { t }  = useI18n()
  const [email,  setEmail]  = useState('')
  const [state,  setState]  = useState<State>('idle')
  const [emailConsent, setEmailConsent] = useState(false)
  const [errMsg, setErrMsg] = useState('')

  const dark      = variant === 'dark'
  const txtColor  = dark ? 'text-[var(--color-text-on-dark)]'         : 'text-[var(--color-text)]'
  const mutColor  = dark ? 'text-[var(--color-text-on-dark)]/50'      : 'text-[var(--color-muted)]'
  const inputCls  = dark
    ? 'bg-white/5 border-[var(--color-text-on-dark)]/20 text-[var(--color-text-on-dark)] placeholder:text-[var(--color-text-on-dark)]/30 focus:border-[var(--color-text-on-dark)]/60'
    : 'bg-[var(--color-bg)] border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-subtle)] focus:border-[var(--color-text)]'
  const btnCls    = dark
    ? 'bg-[var(--color-text-on-dark)] text-[var(--color-bg-dark)] hover:bg-[var(--color-text-on-dark)]/90'
    : 'bg-[var(--color-text)] text-[var(--color-bg)] hover:bg-[#333]'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErrMsg('')

    if (!email.trim() || !isValidEmail(email)) {
      setErrMsg(t['waitlist.pleaseEnterValidEmail'])
      return
    }

    if (!emailConsent) { setErrMsg('Please check the box to receive KVRN marketing emails.'); return }
    setState('loading')
    try {
      const res = await fetch('/api/waitlist', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email.trim(), source, emailMarketingConsent: emailConsent }),
      })
      if (!res.ok) throw new Error()
      setState('success')
    } catch {
      setState('error')
      setErrMsg(t['common.tryAgain'])
    }
  }

  if (state === 'success') {
    return (
      <div className={cn(className)}>
        {heading && <p className={cn('text-[15px] font-light mb-1', txtColor)}>{heading}</p>}
        <p className={cn('text-[13px] font-light', mutColor)}>
          Thanks — your signup request was received.
        </p>
      </div>
    )
  }

  return (
    <div className={cn(className)}>
      {heading    && <p className={cn('text-[15px] font-light mb-1', txtColor)}>{heading}</p>}
      {subheading && <p className={cn('text-[13px] font-light mb-5', mutColor)}>{subheading}</p>}

      <form onSubmit={handleSubmit} noValidate>
        <div className="flex gap-0">
          <label htmlFor={`waitlist-email-${source}`} className="sr-only">{t.emailPlaceholder}</label>
          <input
            id={`waitlist-email-${source}`}
            type="email"
            name="email"
            autoComplete="email"
            placeholder={t.emailPlaceholder}
            value={email}
            onChange={e => { setEmail(e.target.value); setErrMsg('') }}
            required
            aria-required="true"
            aria-invalid={!!errMsg}
            aria-describedby={errMsg ? `waitlist-err-${source}` : undefined}
            className={cn(
              'flex-1 h-12 px-4 text-[13px] font-light border transition-colors duration-150 focus:outline-none',
              inputCls,
              errMsg && 'border-[var(--color-error)]'
            )}
          />
          <button
            type="submit"
            disabled={state === 'loading'}
            aria-busy={state === 'loading'}
            className={cn(
              'h-12 px-6 text-[11px] font-light tracking-[0.12em] uppercase',
              'transition-all duration-150 flex-shrink-0 disabled:opacity-50',
              btnCls
            )}
          >
            {state === 'loading' ? '…' : t.joinBtn}
          </button>
        </div>

        {errMsg && (
          <p id={`waitlist-err-${source}`} role="alert" className="mt-2 text-[12px] font-light text-[var(--color-error)]">
            {errMsg}
          </p>
        )}

        <label className={cn('mt-3 flex items-start gap-3 text-[11px] leading-relaxed font-light', mutColor)}>
          <input type="checkbox" checked={emailConsent} onChange={e => setEmailConsent(e.target.checked)} className="mt-0.5" required />
          <span>I agree to receive KVRN marketing emails about launches, restocks and offers. I can unsubscribe any time. <a className="underline underline-offset-2" href="/privacy">Privacy Policy</a>.</span>
        </label>
      </form>
    </div>
  )
}
