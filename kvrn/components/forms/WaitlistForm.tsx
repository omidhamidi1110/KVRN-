'use client'

import { useState } from 'react'
import { isValidEmail, cn } from '@/lib/utils'

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
  source = 'unknown',
}: WaitlistFormProps) {
  const [email,  setEmail]  = useState('')
  const [state,  setState]  = useState<State>('idle')
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
      setErrMsg('Please enter a valid email address.')
      return
    }

    setState('loading')
    try {
      const res = await fetch('/api/waitlist', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email.trim(), source }),
      })
      if (!res.ok) throw new Error()
      setState('success')
    } catch {
      setState('error')
      setErrMsg('Something went wrong. Please try again.')
    }
  }

  if (state === 'success') {
    return (
      <div className={cn(className)}>
        {heading && <p className={cn('text-[15px] font-light mb-1', txtColor)}>{heading}</p>}
        <p className={cn('text-[13px] font-light', mutColor)}>
          You&apos;re on the list.
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
          <label htmlFor={`waitlist-email-${source}`} className="sr-only">Email address</label>
          <input
            id={`waitlist-email-${source}`}
            type="email"
            name="email"
            autoComplete="email"
            placeholder="Email address"
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
            {state === 'loading' ? '…' : 'Join'}
          </button>
        </div>

        {errMsg && (
          <p id={`waitlist-err-${source}`} role="alert" className="mt-2 text-[12px] font-light text-[var(--color-error)]">
            {errMsg}
          </p>
        )}

        <p className={cn('mt-3 text-[11px] font-light tracking-wide', mutColor)}>
          Collection access only. Unsubscribe any time.
        </p>
      </form>
    </div>
  )
}
