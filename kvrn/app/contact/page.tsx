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
    setFields(prev => ({ ...prev, [key]: val }))
    setErrors(prev => ({ ...prev, [key]: '' }))
  }

  const validate = () => {
    const errs: Record<string, string> = {}
    if (!fields.firstName.trim()) errs.firstName = 'Required'
    if (!fields.lastName.trim())  errs.lastName  = 'Required'
    if (!fields.email.trim())     errs.email     = 'Required'
    else if (!isValidEmail(fields.email)) errs.email = 'Enter a valid email address'
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
      if (!res.ok) throw new Error()
      setFormState('success')
    } catch {
      setFormState('error')
    }
  }

  if (formState === 'success') {
    return (
      <div className="pt-[calc(36px+56px)] min-h-screen flex items-center">
        <div className="container-kvrn max-w-xl py-24">
          <p className="label-11 mb-4">Message sent</p>
          <h1 className="font-display font-light text-[40px] leading-none tracking-tighter mb-5">
            We&apos;ll be in touch.
          </h1>
          <p className="text-[14px] text-kvrn-muted leading-relaxed mb-8">
            We respond to all messages within 1–2 business days.
            You&apos;ll hear from us at{' '}
            <strong className="font-light">{fields.email}</strong>.
          </p>
          <Link href="/" className="text-[13px] text-kvrn-muted hover:text-kvrn-text transition-colors underline underline-offset-2">
            Return home →
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="bg-[#0E0E0E] pt-[calc(36px+56px+40px)] pb-14">
        <div className="container-kvrn max-w-2xl">
          <h1 className="font-display font-light text-[40px] md:text-[52px] leading-none tracking-[-0.03em] text-[#F0EDE8]">
            Contact
          </h1>
        </div>
      </div>
      <div className="container-kvrn section-padding max-w-2xl">

        {/* Breadcrumb */}
        <nav aria-label="Breadcrumb" className="mb-10">
          <ol className="flex items-center gap-2 text-[11px] text-kvrn-muted tracking-wide">
            <li><Link href="/" className="hover:text-kvrn-text transition-colors">Home</Link></li>
            <li aria-hidden="true">·</li>
            <li className="text-kvrn-text" aria-current="page">Contact</li>
          </ol>
        </nav>

        {/* Header */}
        <div className="mb-12">
          <h1 className="font-display font-light text-[40px] md:text-[52px] leading-none tracking-tighter mb-5">
            Contact
          </h1>

          {/* Direct email block */}
          <div className="border-l-2 border-kvrn-border pl-5 space-y-3 text-[14px] text-kvrn-muted leading-relaxed">
            <p>
              Questions regarding orders, sizing, shipping, or returns can be sent to{' '}
              <a href="mailto:support@kvrn.shop"
                className="text-kvrn-text underline underline-offset-2 hover:opacity-70 transition-opacity">
                support@kvrn.shop
              </a>.
            </p>
            <p>Typical response time: 1–2 business days.</p>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          {/* Name row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              { id: 'firstName', label: 'First name', autocomplete: 'given-name',  key: 'firstName' as const },
              { id: 'lastName',  label: 'Last name',  autocomplete: 'family-name', key: 'lastName'  as const },
            ].map(f => (
              <div key={f.id}>
                <label htmlFor={f.id} className="label-11 block mb-2">{f.label}</label>
                <input
                  id={f.id} type="text" autoComplete={f.autocomplete}
                  value={fields[f.key]}
                  onChange={e => update(f.key, e.target.value)}
                  aria-invalid={!!errors[f.key]}
                  className={`kvrn-input ${errors[f.key] ? 'error' : ''}`}
                />
                {errors[f.key] && (
                  <p role="alert" className="text-[12px] text-kvrn-error mt-1">{errors[f.key]}</p>
                )}
              </div>
            ))}
          </div>

          {/* Email */}
          <div>
            <label htmlFor="email" className="label-11 block mb-2">Email</label>
            <input
              id="email" type="email" autoComplete="email"
              value={fields.email}
              onChange={e => update('email', e.target.value)}
              aria-invalid={!!errors.email}
              className={`kvrn-input ${errors.email ? 'error' : ''}`}
            />
            {errors.email && <p role="alert" className="text-[12px] text-kvrn-error mt-1">{errors.email}</p>}
          </div>

          {/* Order number (optional) */}
          <div>
            <label htmlFor="orderNumber" className="label-11 block mb-2">
              Order number{' '}
              <span className="text-kvrn-subtle normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id="orderNumber" type="text"
              value={fields.orderNumber}
              onChange={e => update('orderNumber', e.target.value)}
              placeholder="#1042"
              className="kvrn-input"
            />
          </div>

          {/* Subject */}
          <div>
            <label htmlFor="subject" className="label-11 block mb-2">Subject</label>
            <select
              id="subject"
              value={fields.subject}
              onChange={e => update('subject', e.target.value)}
              aria-invalid={!!errors.subject}
              className={`kvrn-input appearance-none cursor-pointer ${errors.subject ? 'error' : ''}`}
            >
              <option value="">Select a subject</option>
              {subjects.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {errors.subject && <p role="alert" className="text-[12px] text-kvrn-error mt-1">{errors.subject}</p>}
          </div>

          {/* Message */}
          <div>
            <label htmlFor="message" className="label-11 block mb-2">Message</label>
            <textarea
              id="message" rows={5}
              value={fields.message}
              onChange={e => update('message', e.target.value)}
              aria-invalid={!!errors.message}
              className={`kvrn-textarea ${errors.message ? 'error' : ''}`}
            />
            {errors.message && <p role="alert" className="text-[12px] text-kvrn-error mt-1">{errors.message}</p>}
          </div>

          {formState === 'error' && (
            <p role="alert" className="text-[13px] text-kvrn-error">
              Something went wrong. Email us directly at{' '}
              <a href="mailto:support@kvrn.shop" className="underline underline-offset-2">
                support@kvrn.shop
              </a>.
            </p>
          )}

          <Button type="submit" variant="primary" size="lg" loading={formState === 'loading'} className="mt-2">
            Send message
          </Button>
        </form>
      </div>
    </div>
  )
}
