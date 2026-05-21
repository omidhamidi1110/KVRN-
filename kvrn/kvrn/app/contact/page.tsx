'use client'

import { useState } from 'react'
import Link from 'next/link'
import { isValidEmail } from '@/lib/utils'

type State = 'idle' | 'loading' | 'success' | 'error'

const SUBJECTS = ['Order enquiry','Sizing question','Return request','Product question','Press','Other']

export default function ContactPage() {
  const [state,  setState]  = useState<State>('idle')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [fields, setFields] = useState({
    firstName: '', lastName: '', email: '', orderNumber: '', subject: '', message: '',
  })

  const set = (k: keyof typeof fields, v: string) => {
    setFields(p => ({ ...p, [k]: v }))
    setErrors(p => ({ ...p, [k]: '' }))
  }

  const validate = () => {
    const e: Record<string, string> = {}
    if (!fields.firstName.trim()) e.firstName = 'Required'
    if (!fields.lastName.trim())  e.lastName  = 'Required'
    if (!fields.email.trim())     e.email     = 'Required'
    else if (!isValidEmail(fields.email)) e.email = 'Enter a valid email'
    if (!fields.subject)          e.subject   = 'Select a subject'
    if (!fields.message.trim())   e.message   = 'Required'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return
    setState('loading')
    try {
      const res = await fetch('/api/contact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (!res.ok) throw new Error()
      setState('success')
    } catch { setState('error') }
  }

  if (state === 'success') {
    return (
      <div className="min-h-screen bg-[#F9F8F6] flex items-center">
        <div className="container-kvrn max-w-xl py-32">
          <h1 className="font-display font-light text-[40px] leading-none tracking-[-0.03em] mb-5">
            Message sent.
          </h1>
          <p className="text-[14px] text-[#6B6B6B] leading-relaxed mb-8">
            We will respond within 1–2 business days.
          </p>
          <Link href="/" className="text-[12px] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors underline underline-offset-2">
            Return home
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#F9F8F6]">
      {/* Dark intro */}
      <div className="bg-[#0E0E0E] pt-[calc(36px+56px+48px)] pb-16">
        <div className="container-kvrn max-w-2xl">
          <h1 className="font-display font-light text-[40px] md:text-[56px] leading-[0.9] tracking-[-0.03em] text-[#F0EDE8]">
            Contact
          </h1>
          <p className="text-[14px] text-[#F0EDE8]/45 mt-4 leading-relaxed">
            Questions about orders, sizing, shipping, or returns can be sent to{' '}
            <a href="mailto:support@kvrn.shop" className="text-[#F0EDE8]/70 underline underline-offset-2">
              support@kvrn.shop
            </a>
            . Response time: 1–2 business days.
          </p>
        </div>
      </div>

      {/* Form */}
      <div className="container-kvrn max-w-2xl py-14">
        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              { id: 'firstName', label: 'First name', key: 'firstName' as const },
              { id: 'lastName',  label: 'Last name',  key: 'lastName'  as const },
            ].map(f => (
              <div key={f.id}>
                <label htmlFor={f.id} className="block text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-2">{f.label}</label>
                <input id={f.id} type="text" value={fields[f.key]} onChange={e => set(f.key, e.target.value)}
                  className={`w-full h-11 px-4 text-[13px] font-light border bg-transparent text-[#1A1A1A] placeholder:text-[#C8C4BF] focus:outline-none transition-colors ${errors[f.key] ? 'border-[#B91C1C]' : 'border-[#E8E5E0] focus:border-[#1A1A1A]'}`}
                />
                {errors[f.key] && <p className="text-[11px] text-[#B91C1C] mt-1">{errors[f.key]}</p>}
              </div>
            ))}
          </div>

          {[
            { id: 'email',       label: 'Email',                   type: 'email', key: 'email'       as const },
            { id: 'orderNumber', label: 'Order number (optional)', type: 'text',  key: 'orderNumber' as const },
          ].map(f => (
            <div key={f.id}>
              <label htmlFor={f.id} className="block text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-2">{f.label}</label>
              <input id={f.id} type={f.type} value={fields[f.key]} onChange={e => set(f.key, e.target.value)}
                className={`w-full h-11 px-4 text-[13px] font-light border bg-transparent text-[#1A1A1A] placeholder:text-[#C8C4BF] focus:outline-none transition-colors ${errors[f.key] ? 'border-[#B91C1C]' : 'border-[#E8E5E0] focus:border-[#1A1A1A]'}`}
              />
              {errors[f.key] && <p className="text-[11px] text-[#B91C1C] mt-1">{errors[f.key]}</p>}
            </div>
          ))}

          <div>
            <label htmlFor="subject" className="block text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-2">Subject</label>
            <select id="subject" value={fields.subject} onChange={e => set('subject', e.target.value)}
              className={`w-full h-11 px-4 text-[13px] font-light border bg-[#F9F8F6] text-[#1A1A1A] focus:outline-none transition-colors appearance-none cursor-pointer ${errors.subject ? 'border-[#B91C1C]' : 'border-[#E8E5E0] focus:border-[#1A1A1A]'}`}
            >
              <option value="">Select</option>
              {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {errors.subject && <p className="text-[11px] text-[#B91C1C] mt-1">{errors.subject}</p>}
          </div>

          <div>
            <label htmlFor="message" className="block text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-2">Message</label>
            <textarea id="message" rows={5} value={fields.message} onChange={e => set('message', e.target.value)}
              className={`w-full px-4 py-3 text-[13px] font-light border bg-transparent text-[#1A1A1A] placeholder:text-[#C8C4BF] focus:outline-none transition-colors resize-none ${errors.message ? 'border-[#B91C1C]' : 'border-[#E8E5E0] focus:border-[#1A1A1A]'}`}
            />
            {errors.message && <p className="text-[11px] text-[#B91C1C] mt-1">{errors.message}</p>}
          </div>

          {state === 'error' && (
            <p className="text-[12px] text-[#B91C1C]">
              Something went wrong. Email us at{' '}
              <a href="mailto:support@kvrn.shop" className="underline underline-offset-2">support@kvrn.shop</a>.
            </p>
          )}

          <button type="submit" disabled={state === 'loading'}
            className="h-11 px-8 border border-[#1A1A1A] text-[11px] font-light tracking-[0.16em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-[#F0EDE8] transition-all duration-300 disabled:opacity-50">
            {state === 'loading' ? '…' : 'Send message'}
          </button>
        </form>
      </div>
    </div>
  )
}
