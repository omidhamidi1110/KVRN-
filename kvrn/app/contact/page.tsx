'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/Button'
import { isValidEmail } from '@/lib/utils'

type FormState = 'idle' | 'loading' | 'success' | 'error'

const subjects = [
  'Order enquiry',
  'Sizing question',
  'Return request',
  'Product question',
  'Wholesale',
  'Press',
  'Other',
]

export default function ContactPage() {
  const [formState, setFormState] = useState<FormState>('idle')
  const [errors,    setErrors]    = useState<Record<string, string>>({})
  const [fields,    setFields]    = useState({
    firstName:   '',
    lastName:    '',
    email:       '',
    orderNumber: '',
    subject:     '',
    message:     '',
  })

  const update = (key: keyof typeof fields, val: string) => {
    setFields((prev) => ({ ...prev, [key]: val }))
    setErrors((prev) => ({ ...prev, [key]: '' }))
  }

  const validate = () => {
    const errs: Record<string, string> = {}
    if (!fields.firstName.trim()) errs.firstName = 'Required'
    if (!fields.lastName.trim())  errs.lastName  = 'Required'
    if (!fields.email.trim())     errs.email     = 'Required'
    else if (!isValidEmail(fields.email)) errs.email = 'Please enter a valid email'
    if (!fields.subject)          errs.subject   = 'Please select a subject'
    if (!fields.message.trim())   errs.message   = 'Required'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return
    setFormState('loading')

    try {
      const res = await fetch('/api/contact', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(fields),
      })
      if (!res.ok) throw new Error('Send failed')
      setFormState('success')
    } catch {
      setFormState('error')
    }
  }

  if (formState === 'success') {
    return (
      <div className="pt-[56px] min-h-screen flex items-center">
        <div className="container-kvrn max-w-xl py-24">
          <p className="label-11 mb-4">Message sent</p>
          <h1 className="font-display font-light text-[40px] leading-none tracking-tighter mb-6">
            We&apos;ll be in touch.
          </h1>
          <p className="text-[15px] text-kvrn-muted leading-relaxed mb-8">
            We respond to all messages within 24 hours (Monday–Friday).
            You&apos;ll hear from us at <strong className="font-light">{fields.email}</strong>.
          </p>
          <Link href="/" className="text-[13px] text-kvrn-muted hover:text-kvrn-text transition-colors underline underline-offset-2">
            Return home →
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="pt-[56px]">
      <div className="container-kvrn section-padding max-w-2xl">
        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="mb-10">
          <ol className="flex items-center gap-2 text-[11px] text-kvrn-muted tracking-wide">
            <li><Link href="/" className="hover:text-kvrn-text transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-kvrn-text" aria-current="page">Contact</li>
          </ol>
        </nav>

        <div className="mb-12">
          <h1 className="font-display font-light text-[40px] md:text-[56px] leading-none tracking-tighter mb-4">
            Contact
          </h1>
          <p className="text-[15px] text-kvrn-muted leading-relaxed">
            We respond to all messages within 24 hours.
            For urgent order issues, email{' '}
            <a href="mailto:hello@kvrn.com" className="text-kvrn-text underline underline-offset-2 hover:opacity-70 transition-opacity">
              hello@kvrn.com
            </a>{' '}
            directly.
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          {/* Name row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="firstName" className="label-11 block mb-2">First name</label>
              <input
                id="firstName"
                type="text"
                autoComplete="given-name"
                value={fields.firstName}
                onChange={(e) => update('firstName', e.target.value)}
                aria-invalid={!!errors.firstName}
                aria-describedby={errors.firstName ? 'firstName-error' : undefined}
                className={`input-base ${errors.firstName ? 'error' : ''}`}
              />
              {errors.firstName && <p id="firstName-error" role="alert" className="text-[12px] text-kvrn-error mt-1">{errors.firstName}</p>}
            </div>
            <div>
              <label htmlFor="lastName" className="label-11 block mb-2">Last name</label>
              <input
                id="lastName"
                type="text"
                autoComplete="family-name"
                value={fields.lastName}
                onChange={(e) => update('lastName', e.target.value)}
                aria-invalid={!!errors.lastName}
                className={`input-base ${errors.lastName ? 'error' : ''}`}
              />
              {errors.lastName && <p role="alert" className="text-[12px] text-kvrn-error mt-1">{errors.lastName}</p>}
            </div>
          </div>

          {/* Email */}
          <div>
            <label htmlFor="email" className="label-11 block mb-2">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={fields.email}
              onChange={(e) => update('email', e.target.value)}
              aria-invalid={!!errors.email}
              className={`input-base ${errors.email ? 'error' : ''}`}
            />
            {errors.email && <p role="alert" className="text-[12px] text-kvrn-error mt-1">{errors.email}</p>}
          </div>

          {/* Order number (optional) */}
          <div>
            <label htmlFor="orderNumber" className="label-11 block mb-2">
              Order number <span className="text-kvrn-subtle normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id="orderNumber"
              type="text"
              value={fields.orderNumber}
              onChange={(e) => update('orderNumber', e.target.value)}
              placeholder="e.g. #1042"
              className="input-base"
            />
          </div>

          {/* Subject */}
          <div>
            <label htmlFor="subject" className="label-11 block mb-2">Subject</label>
            <select
              id="subject"
              value={fields.subject}
              onChange={(e) => update('subject', e.target.value)}
              aria-invalid={!!errors.subject}
              className={`input-base appearance-none cursor-pointer ${errors.subject ? 'error' : ''}`}
            >
              <option value="">Select a subject</option>
              {subjects.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {errors.subject && <p role="alert" className="text-[12px] text-kvrn-error mt-1">{errors.subject}</p>}
          </div>

          {/* Message */}
          <div>
            <label htmlFor="message" className="label-11 block mb-2">Message</label>
            <textarea
              id="message"
              value={fields.message}
              onChange={(e) => update('message', e.target.value)}
              rows={5}
              aria-invalid={!!errors.message}
              className={`textarea-base ${errors.message ? 'border-kvrn-error' : ''}`}
            />
            {errors.message && <p role="alert" className="text-[12px] text-kvrn-error mt-1">{errors.message}</p>}
          </div>

          {formState === 'error' && (
            <p role="alert" className="text-[13px] text-kvrn-error">
              Something went wrong. Please email us at hello@kvrn.com instead.
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={formState === 'loading'}
            className="mt-2"
          >
            Send message
          </Button>
        </form>
      </div>
    </div>
  )
}
