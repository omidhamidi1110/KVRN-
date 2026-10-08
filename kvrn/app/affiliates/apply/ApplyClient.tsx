'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { validateApplicationInput, type FieldErrors } from '@/lib/affiliate-application-input'
import { documentHref } from '@/lib/affiliate-program-docs'

interface DocRef { version: string; title: string }
interface Props {
  formToken: string
  countries: string[]
  docs: { terms: DocRef; disclosure: DocRef; privacy: DocRef }
}

const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : '')
const LABEL = 'block text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-2'
const field = (err?: string) =>
  `w-full h-11 px-4 text-[13px] font-light border bg-transparent text-[#1A1A1A] placeholder:text-[#C8C4BF] focus:outline-none transition-colors ${err ? 'border-[#B91C1C]' : 'border-[#E8E5E0] focus:border-[#1A1A1A]'}`
const area = (err?: string) =>
  `w-full px-4 py-3 text-[13px] font-light border bg-transparent text-[#1A1A1A] placeholder:text-[#C8C4BF] focus:outline-none transition-colors resize-none ${err ? 'border-[#B91C1C]' : 'border-[#E8E5E0] focus:border-[#1A1A1A]'}`

function countryName(code: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code } catch { return code }
}

export function ApplyClient({ formToken, countries, docs }: Props) {
  const [state, setState] = useState<'idle' | 'loading' | 'success'>('idle')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [banner, setBanner] = useState<string | null>(null)
  const [inviteToken, setInviteToken] = useState<string | null>(null)
  const [emailLocked, setEmailLocked] = useState(false)
  const [f, setF] = useState({
    applicantName: '', displayName: '', email: '', country: countries.length === 1 ? countries[0] : '', stateRegion: '',
    website: '', audienceSize: '', contentCategory: '', motivation: '', promotionPlan: '', preferredCode: '', heardAbout: '', applicantNotes: '',
  })
  const [socials, setSocials] = useState<string[]>([''])
  const [honey, setHoney] = useState('')
  // Every consent starts unchecked and is separate. Nothing is implied.
  const [consent, setConsent] = useState({ ageAttested: false, termsAccepted: false, disclosureAccepted: false, privacyAccepted: false, accuracyConfirmed: false, esignConsent: false })
  const idemKey = useRef<string>(newKey())

  // Invitation link: pre-fill name and email (the email is then read-only). Review is still required.
  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('invite')
    if (!t || !/^[0-9a-f]{64}$/.test(t)) return
    // Remove the bearer token from the visible URL/history entry before making any network request.
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    fetch('/api/affiliates/invite', {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (!j?.invite) { setBanner('This invitation link is not valid or has expired. You can still apply below.'); return }
        setInviteToken(t)
        setEmailLocked(true)
        setF(p => ({ ...p, email: j.invite.email, applicantName: p.applicantName || j.invite.displayName }))
      })
      .catch(() => {})
  }, [])

  const touch = (k?: string) => {
    idemKey.current = newKey() || idemKey.current
    if (k) setErrors(p => ({ ...p, [k]: '' }))
  }
  const set = (k: keyof typeof f, v: string) => { touch(k); setF(p => ({ ...p, [k]: v })) }
  const setC = (k: keyof typeof consent, v: boolean) => { touch(k); setConsent(p => ({ ...p, [k]: v })) }

  const payload = () => ({
    ...f, socialUrls: socials, ...consent,
    termsVersion: docs.terms.version, disclosureVersion: docs.disclosure.version, privacyVersion: docs.privacy.version,
    idempotencyKey: idemKey.current, formToken, company_fax: honey, inviteToken: inviteToken ?? undefined,
  })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (state === 'loading') return
    setBanner(null)
    const body = payload()
    const v = validateApplicationInput(body as any, countries)
    if (!v.ok) { setErrors(v.errors); setBanner('Please fix the highlighted fields.'); return }
    setErrors({})
    setState('loading')
    try {
      const res = await fetch('/api/affiliates/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => ({}))
      if (res.ok) { setState('success'); return }
      if (res.status === 400 && j.fields) setErrors(j.fields)
      setBanner(j.error ?? 'Something went wrong. Please try again.')
    } catch {
      setBanner('We could not reach the server. Please try again.')
    }
    setState('idle')
  }

  if (state === 'success') {
    return (
      <div data-nav-theme="light" className="container-kvrn section-padding max-w-xl">
        <h2 className="font-display font-light text-[28px] leading-none tracking-[-0.02em] mb-4">Application received.</h2>
        <p className="text-[14px] text-[#6B6B6B] leading-relaxed mb-8">
          Thank you. We review every application by hand and will email you with our decision. A confirmation is on its way.
        </p>
        <Link href="/" className="text-[12px] text-[#9B9B9B] hover:text-[#1A1A1A] underline underline-offset-2">Return home</Link>
      </div>
    )
  }

  const Err = ({ k }: { k: string }) => (errors[k] ? <p role="alert" className="text-[11px] text-[#B91C1C] mt-1">{errors[k]}</p> : null)
  const ErrId = (k: string) => (errors[k] ? `${k}-err` : undefined)

  const check = (k: keyof typeof consent, children: React.ReactNode) => (
    <div>
      <label className="flex items-start gap-3 text-[13px] text-[#4A4A46] leading-snug cursor-pointer">
        <input type="checkbox" checked={consent[k]} onChange={e => setC(k, e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[#1A1A1A]" aria-invalid={!!errors[k]} />
        <span>{children}</span>
      </label>
      <Err k={k} />
    </div>
  )

  return (
    <div data-nav-theme="light" className="container-kvrn max-w-2xl py-14">
      <p className="text-[14px] text-[#6B6B6B] leading-relaxed mb-8">
        Tell us about you and your audience. Applying does not guarantee acceptance, and nothing is active until you are approved.
      </p>
      {banner && <p role="alert" className="mb-6 border border-[#E8E5E0] px-4 py-3 text-[13px] text-[#1A1A1A]">{banner}</p>}
      <form onSubmit={submit} noValidate className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="applicantName" className={LABEL}>Full name</label>
            <input id="applicantName" autoComplete="name" value={f.applicantName} onChange={e => set('applicantName', e.target.value)} className={field(errors.applicantName)} aria-describedby={ErrId('applicantName')} />
            <Err k="applicantName" />
          </div>
          <div>
            <label htmlFor="displayName" className={LABEL}>Creator name (optional)</label>
            <input id="displayName" value={f.displayName} onChange={e => set('displayName', e.target.value)} className={field()} />
          </div>
        </div>
        <div>
          <label htmlFor="email" className={LABEL}>Email</label>
          <input id="email" type="email" autoComplete="email" value={f.email} readOnly={emailLocked} onChange={e => set('email', e.target.value)} className={field(errors.email)} />
          {emailLocked && <p className="text-[11px] text-[#9B9B9B] mt-1">This is the address your invitation was sent to.</p>}
          <Err k="email" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="country" className={LABEL}>Country</label>
            <select id="country" value={f.country} onChange={e => set('country', e.target.value)} className={`${field(errors.country)} appearance-none bg-[#F9F8F6]`}>
              <option value="">Select</option>
              {countries.map(c => <option key={c} value={c}>{countryName(c)}</option>)}
            </select>
            <Err k="country" />
          </div>
          <div>
            <label htmlFor="stateRegion" className={LABEL}>State or province</label>
            <input id="stateRegion" autoComplete="address-level1" value={f.stateRegion} onChange={e => set('stateRegion', e.target.value)} className={field(errors.stateRegion)} />
            <Err k="stateRegion" />
          </div>
        </div>

        <div>
          <span className={LABEL}>Social profile links</span>
          <div className="space-y-2">
            {socials.map((s, i) => (
              <div key={i} className="flex gap-2">
                <input aria-label={`Social profile link ${i + 1}`} inputMode="url" placeholder="https://instagram.com/yourname" value={s}
                  onChange={e => { touch('socialUrls'); setSocials(p => p.map((x, j) => (j === i ? e.target.value : x))) }} className={field(errors.socialUrls)} />
                {socials.length > 1 && (
                  <button type="button" onClick={() => { touch(); setSocials(p => p.filter((_, j) => j !== i)) }}
                    className="h-11 px-3 text-[12px] text-[#6B6B6B] border border-[#E8E5E0] hover:border-[#1A1A1A]">Remove</button>
                )}
              </div>
            ))}
          </div>
          {socials.length < 5 && (
            <button type="button" onClick={() => setSocials(p => [...p, ''])} className="mt-2 text-[12px] text-[#6B6B6B] underline underline-offset-2 hover:text-[#1A1A1A]">Add another link</button>
          )}
          <Err k="socialUrls" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="website" className={LABEL}>Website (optional)</label>
            <input id="website" inputMode="url" value={f.website} onChange={e => set('website', e.target.value)} className={field(errors.website)} />
            <Err k="website" />
          </div>
          <div>
            <label htmlFor="audienceSize" className={LABEL}>Audience size (optional)</label>
            <input id="audienceSize" inputMode="numeric" value={f.audienceSize} onChange={e => set('audienceSize', e.target.value)} className={field(errors.audienceSize)} />
            <Err k="audienceSize" />
          </div>
        </div>
        <div>
          <label htmlFor="contentCategory" className={LABEL}>What do you create? (optional)</label>
          <input id="contentCategory" value={f.contentCategory} onChange={e => set('contentCategory', e.target.value)} className={field()} />
        </div>
        <div>
          <label htmlFor="motivation" className={LABEL}>Why KVRN?</label>
          <textarea id="motivation" rows={4} value={f.motivation} onChange={e => set('motivation', e.target.value)} className={area(errors.motivation)} />
          <Err k="motivation" />
        </div>
        <div>
          <label htmlFor="promotionPlan" className={LABEL}>How would you promote KVRN?</label>
          <textarea id="promotionPlan" rows={4} value={f.promotionPlan} onChange={e => set('promotionPlan', e.target.value)} className={area(errors.promotionPlan)} />
          <Err k="promotionPlan" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="preferredCode" className={LABEL}>Preferred code (optional)</label>
            <input id="preferredCode" autoCapitalize="characters" value={f.preferredCode} onChange={e => set('preferredCode', e.target.value.toUpperCase())} className={field(errors.preferredCode)} />
            <p className="text-[11px] text-[#9B9B9B] mt-1">We may adjust it if it is taken.</p>
            <Err k="preferredCode" />
          </div>
          <div>
            <label htmlFor="heardAbout" className={LABEL}>How did you hear about us? (optional)</label>
            <input id="heardAbout" value={f.heardAbout} onChange={e => set('heardAbout', e.target.value)} className={field()} />
          </div>
        </div>
        <div>
          <label htmlFor="applicantNotes" className={LABEL}>Anything else? (optional)</label>
          <textarea id="applicantNotes" rows={3} value={f.applicantNotes} onChange={e => set('applicantNotes', e.target.value)} className={area()} />
        </div>

        {/* Honeypot: hidden from people and assistive tech; bots fill it. */}
        <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
          <label htmlFor="company_fax">Leave this field empty</label>
          <input id="company_fax" name="company_fax" tabIndex={-1} autoComplete="off" value={honey} onChange={e => setHoney(e.target.value)} />
        </div>

        <fieldset className="space-y-4 border-t border-[#E8E5E0] pt-6">
          <legend className={LABEL}>Agreements</legend>
          {check('ageAttested', <>I am 18 years of age or older.</>)}
          {check('termsAccepted', <>I have read and accept the <Link className="underline underline-offset-2" target="_blank" href={documentHref('program_terms', docs.terms.version)}>{docs.terms.title}</Link> ({docs.terms.version}).</>)}
          {check('disclosureAccepted', <>I have read and accept the <Link className="underline underline-offset-2" target="_blank" href={documentHref('disclosure_policy', docs.disclosure.version)}>{docs.disclosure.title}</Link> ({docs.disclosure.version}), including disclosing my relationship with KVRN.</>)}
          {check('privacyAccepted', <>I have read the <Link className="underline underline-offset-2" target="_blank" href={documentHref('privacy_notice', docs.privacy.version)}>{docs.privacy.title}</Link> ({docs.privacy.version}).</>)}
          {check('accuracyConfirmed', <>The information I provided is accurate and complete.</>)}
          {check('esignConsent', <>I agree to use electronic signatures and records for this application and the program.</>)}
          <Err k="documents" />
        </fieldset>

        <button type="submit" disabled={state === 'loading'}
          className="h-11 px-8 border border-[#1A1A1A] text-[11px] font-light tracking-[0.16em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-[#F0EDE8] transition-all duration-300 disabled:opacity-50">
          {state === 'loading' ? 'Sending…' : 'Submit application'}
        </button>
      </form>
    </div>
  )
}
