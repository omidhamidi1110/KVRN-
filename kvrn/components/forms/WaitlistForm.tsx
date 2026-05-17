'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { isValidEmail } from '@/lib/utils'
import { cn } from '@/lib/utils'

interface WaitlistFormProps {
  variant?:    'light' | 'dark'
  heading?:    string
  subheading?: string
  className?:  string
  dropId?:     string
  source?:     string
}

type FormState = 'idle' | 'loading' | 'success' | 'error'

export function WaitlistForm({
  variant    = 'light',
  heading    = 'Join the list.',
  subheading = 'First to know when Drop 001 goes live.',
  className,
  dropId  = 'drop_001',
  source  = 'homepage',
}: WaitlistFormProps) {
  const [email,      setEmail]      = useState('')
  const [smsConsent, setSmsConsent] = useState(false)
  const [phone,      setPhone]      = useState('')
  const [showPhone,  setShowPhone]  = useState(false)
  const [state,      setState]      = useState<FormState>('idle')
  const [error,      setError]      = useState('')

  const isDark = variant === 'dark'

  const textColor    = isDark ? 'text-kvrn-text-on-dark' : 'text-kvrn-text'
  const mutedColor   = isDark ? 'text-kvrn-text-on-dark/60' : 'text-kvrn-muted'
  const inputBorder  = isDark ? 'border-kvrn-text-on-dark/30 focus:border-kvrn-text-on-dark' : 'border-kvrn-border focus:border-kvrn-text'
  const inputBg      = isDark ? 'bg-white/5 text-kvrn-text-on-dark placeholder:text-kvrn-text-on-dark/40' : 'bg-kvrn-bg text-kvrn-text placeholder:text-kvrn-subtle'

  const handleSmsToggle = () => {
    const next = !smsConsent
    setSmsConsent(next)
    setShowPhone(next)
    if (!next) setPhone('')
  }

  const validate = (): boolean => {
    if (!email.trim()) {
      setError('Email address is required.')
      return false
    }
    if (!isValidEmail(email)) {
      setError('Please enter a valid email address.')
      return false
    }
    return true
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!validate()) return

    setState('loading')

    try {
      const res = await fetch('/api/waitlist', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          phone: smsConsent ? phone.trim() : undefined,
          smsConsent,
          dropId,
          source,
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Something went wrong.')
      }

      setState('success')
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    }
  }

  if (state === 'success') {
    return (
      <div className={cn('text-center', className)}>
        <p className={cn('text-[15px] font-light', textColor)}>
          {heading}
        </p>
        <p className={cn('text-[13px] mt-2', mutedColor)}>
          You&apos;re on the list. We&apos;ll be in touch.
        </p>
      </div>
    )
  }

  return (
    <div className={cn(className)}>
      {heading && (
        <p className={cn('text-[15px] font-light mb-1', textColor)}>
          {heading}
        </p>
      )}
      {subheading && (
        <p className={cn('text-[13px] mb-5', mutedColor)}>
          {subheading}
        </p>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-3">
        {/* Email input row */}
        <div className="flex gap-0">
          <label htmlFor="waitlist-email" className="sr-only">
            Email address
          </label>
          <input
            id="waitlist-email"
            type="email"
            name="email"
            autoComplete="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError('') }}
            required
            aria-required="true"
            aria-describedby={error ? 'waitlist-error' : undefined}
            aria-invalid={!!error}
            className={cn(
              'flex-1 h-12 px-4 text-[13px] font-light border',
              'transition-colors duration-150 focus:outline-none',
              inputBg,
              inputBorder,
              error && 'border-kvrn-error'
            )}
          />
          <Button
            type="submit"
            variant={isDark ? 'ghost' : 'primary'}
            size="md"
            loading={state === 'loading'}
            className="flex-shrink-0"
          >
            Join
          </Button>
        </div>

        {/* SMS opt-in toggle */}
        <label className="flex items-start gap-3 cursor-pointer group">
          <span
            role="checkbox"
            aria-checked={smsConsent}
            aria-label="Also notify me by SMS"
            tabIndex={0}
            onClick={handleSmsToggle}
            onKeyDown={(e) => e.key === ' ' && handleSmsToggle()}
            className={cn(
              'mt-0.5 w-4 h-4 flex-shrink-0 border transition-all duration-150',
              'flex items-center justify-center focus-visible:outline-none focus-visible:ring-1',
              smsConsent
                ? isDark
                  ? 'bg-kvrn-text-on-dark border-kvrn-text-on-dark'
                  : 'bg-kvrn-text border-kvrn-text'
                : isDark
                ? 'border-kvrn-text-on-dark/40'
                : 'border-kvrn-border',
              'focus-visible:ring-kvrn-text'
            )}
          >
            {smsConsent && (
              <svg width="8" height="6" viewBox="0 0 8 6" fill="none" aria-hidden="true">
                <path d="M1 3L3 5L7 1" stroke={isDark ? '#1A1A1A' : '#FAFAF8'} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </span>
          <span className={cn('text-[12px] leading-relaxed select-none', mutedColor)}>
            Also notify me by SMS. Standard message rates apply.
          </span>
        </label>

        {/* Phone input (conditional) */}
        {showPhone && (
          <div>
            <label htmlFor="waitlist-phone" className="sr-only">Phone number</label>
            <input
              id="waitlist-phone"
              type="tel"
              name="phone"
              autoComplete="tel"
              placeholder="+44 7700 900000"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={cn(
                'w-full h-12 px-4 text-[13px] font-light border',
                'transition-colors duration-150 focus:outline-none',
                inputBg,
                inputBorder
              )}
            />
            <p className={cn('text-[11px] mt-1.5', mutedColor)}>
              Reply STOP at any time to unsubscribe.
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <p id="waitlist-error" role="alert" className="text-[12px] text-kvrn-error">
            {error}
          </p>
        )}

        {/* Privacy note */}
        <p className={cn('text-[11px] tracking-wide', mutedColor)}>
          Drop notifications only. No spam.
        </p>
      </form>
    </div>
  )
}
