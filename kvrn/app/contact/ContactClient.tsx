'use client'

import { PageHero } from '@/components/layout/PageHero'
import { useRef, useState } from 'react'
import Link from 'next/link'
import { isValidEmail } from '@/lib/utils'
import { useI18n } from '@/context/I18nContext'
import { fillMessages, type MessageKey } from '@/lib/i18n/messages'

type State = 'idle' | 'loading' | 'success' | 'error'

const SUBJECTS = ['Order enquiry','Sizing question','Return request','Product question','Press','Other']

// The submitted VALUE stays the English subject (support triage and the /api/contact contract depend on
// it); only the visible label is translated.
const SUBJECT_LABEL: Record<string, MessageKey> = {
  'Order enquiry':    'contact.subject.order',
  'Sizing question':  'contact.subject.sizing',
  'Return request':   'contact.subject.return',
  'Product question': 'contact.subject.product',
  'Press':            'contact.subject.press',
  'Other':            'contact.subject.other',
}

// The validation logic keeps its original English messages (they are the form's state); they are
// translated when shown.
const ERROR_LABEL: Record<string, MessageKey> = {
  'Required':            'contact.errRequired',
  'Enter a valid email': 'contact.errEnterValidEmail',
  'Select a subject':    'contact.errSelectSubject',
}

/** Editable page text from Admin content (CMS_PUBLIC_CONTENT on). Absent = the coded text below. */
export interface ContactSlots {
  heroTitle?: string; intro?: string; successTitle?: string; successBody?: string; supportHours?: string; helpNote?: string
}

export function ContactClient({ slots }: { slots?: Record<string, ContactSlots> } = {}) {
  const { locale, t: dict } = useI18n()
  const t = fillMessages(dict)
  const shown = (m?: string) => (m && ERROR_LABEL[m] ? t[ERROR_LABEL[m]] : m)
  const S: ContactSlots = slots ? (slots[locale] ?? slots.en ?? {}) : {}
  const [state,  setState]  = useState<State>('idle')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [fields, setFields] = useState({
    firstName: '', lastName: '', email: '', orderNumber: '', subject: '', message: '',
  })

  // One id per page view: a double click or a retry after a network error cannot create two threads.
  const submissionId = useRef<string>(
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : '')

  const set = (k: keyof typeof fields, v: string) => {
    // Editing after a failed attempt is a NEW submission (the old id may already be stored server-side).
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) submissionId.current = crypto.randomUUID()
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
        body: JSON.stringify({ ...fields, ...(submissionId.current ? { submissionId: submissionId.current } : {}) }),
      })
      if (!res.ok) throw new Error()
      setState('success')
    } catch { setState('error') }
  }

  if (state === 'success') {
    return (
      <div className="min-h-screen bg-[#F9F8F6] flex items-center">
        <div data-nav-theme="light" className="container-kvrn max-w-xl py-32">
          <h1 className="font-display font-light text-[40px] leading-none tracking-[-0.03em] mb-5">
            {S.successTitle || t['contact.sentTitle']}
          </h1>
          <p className="text-[14px] text-[#6B6B6B] leading-relaxed mb-8">
            {S.successBody || t['contact.sentBody']}
          </p>
          <Link href="/" className="text-[12px] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors underline underline-offset-2">
            {t['contact.returnHome']}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#F9F8F6]">
      {/* Dark intro */}
      <PageHero title={S.heroTitle || t['contact.title']} breadcrumb={S.heroTitle || t['contact.title']} />

      {/* Form */}
      <div className="container-kvrn max-w-2xl py-14">
        {S.intro && <p className="text-[14px] text-[#6B6B6B] leading-relaxed mb-8 whitespace-pre-line">{S.intro}</p>}
        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              { id: 'firstName', label: t.firstName, key: 'firstName' as const },
              { id: 'lastName',  label: t.lastName,  key: 'lastName'  as const },
            ].map(f => (
              <div key={f.id}>
                <label htmlFor={f.id} className="block text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-2">{f.label}</label>
                <input id={f.id} type="text" value={fields[f.key]} onChange={e => set(f.key, e.target.value)}
                  className={`w-full h-11 px-4 text-[13px] font-light border bg-transparent text-[#1A1A1A] placeholder:text-[#C8C4BF] focus:outline-none transition-colors ${errors[f.key] ? 'border-[#B91C1C]' : 'border-[#E8E5E0] focus:border-[#1A1A1A]'}`}
                />
                {errors[f.key] && <p className="text-[11px] text-[#B91C1C] mt-1">{shown(errors[f.key])}</p>}
              </div>
            ))}
          </div>

          {[
            { id: 'email',       label: t.email,                   type: 'email', key: 'email'       as const },
            { id: 'orderNumber', label: t['contact.orderNumberOpt'], type: 'text',  key: 'orderNumber' as const },
          ].map(f => (
            <div key={f.id}>
              <label htmlFor={f.id} className="block text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-2">{f.label}</label>
              <input id={f.id} type={f.type} value={fields[f.key]} onChange={e => set(f.key, e.target.value)}
                className={`w-full h-11 px-4 text-[13px] font-light border bg-transparent text-[#1A1A1A] placeholder:text-[#C8C4BF] focus:outline-none transition-colors ${errors[f.key] ? 'border-[#B91C1C]' : 'border-[#E8E5E0] focus:border-[#1A1A1A]'}`}
              />
              {errors[f.key] && <p className="text-[11px] text-[#B91C1C] mt-1">{shown(errors[f.key])}</p>}
            </div>
          ))}

          <div>
            <label htmlFor="subject" className="block text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-2">{t.subject}</label>
            <select id="subject" value={fields.subject} onChange={e => set('subject', e.target.value)}
              className={`w-full h-11 px-4 text-[13px] font-light border bg-[#F9F8F6] text-[#1A1A1A] focus:outline-none transition-colors appearance-none cursor-pointer ${errors.subject ? 'border-[#B91C1C]' : 'border-[#E8E5E0] focus:border-[#1A1A1A]'}`}
            >
              <option value="">{t['contact.select']}</option>
              {SUBJECTS.map(s => <option key={s} value={s}>{t[SUBJECT_LABEL[s]]}</option>)}
            </select>
            {errors.subject && <p className="text-[11px] text-[#B91C1C] mt-1">{shown(errors.subject)}</p>}
          </div>

          <div>
            <label htmlFor="message" className="block text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-2">{t.message}</label>
            <textarea id="message" rows={5} value={fields.message} onChange={e => set('message', e.target.value)}
              className={`w-full px-4 py-3 text-[13px] font-light border bg-transparent text-[#1A1A1A] placeholder:text-[#C8C4BF] focus:outline-none transition-colors resize-none ${errors.message ? 'border-[#B91C1C]' : 'border-[#E8E5E0] focus:border-[#1A1A1A]'}`}
            />
            {errors.message && <p className="text-[11px] text-[#B91C1C] mt-1">{shown(errors.message)}</p>}
          </div>

          {state === 'error' && (
            <p className="text-[12px] text-[#B91C1C]">
              {t['contact.errorBefore']}{' '}
              <a href="mailto:support@kvrn.shop" className="underline underline-offset-2">support@kvrn.shop</a>.
            </p>
          )}

          <button type="submit" disabled={state === 'loading'}
            className="h-11 px-8 border border-[#1A1A1A] text-[11px] font-light tracking-[0.16em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-[#F0EDE8] transition-all duration-300 disabled:opacity-50">
            {state === 'loading' ? '…' : t.sendMessage}
          </button>
        </form>
        {(S.supportHours || S.helpNote) && (
          <div className="mt-10 pt-8 border-t border-[#E8E5E0] space-y-2 text-[13px] text-[#6B6B6B] leading-relaxed whitespace-pre-line">
            {S.supportHours && <p>{S.supportHours}</p>}
            {S.helpNote && <p>{S.helpNote}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
