// Pure-logic tests for the affiliate program (no database, no network).
import {
  canonicalizeSocialUrl, emailDedupeKey, validateApplicationInput, safeExternalHref, normalizeEmail, isEmailShape, parsePublicHttpsUrl,
} from '../affiliate-application-input'
import { parseDocument, parseInline, documentPlainText, docSlug, docTypeFromSlug, documentHref } from '../affiliate-program-docs'
import {
  mergeProgramSettings, validateProgramSettingsInput, DEFAULT_PROGRAM_SETTINGS, validateApprovalConfig, validateInviteInput,
  validateProfileSettingsInput, validateDocumentInput, toProgramError, ProgramError,
} from '../affiliate-program'
import { affiliateHashPepperConfigured, issueFormToken, checkFormToken, hashValue, MIN_FILL_MS, MAX_FORM_AGE_MS, clientIpFrom } from '../affiliate-application'
import { renderAffiliateEmail, esc, AFFILIATE_EMAIL_KINDS } from '../affiliate-program-email'
import {
  availableProfileActions, availableApplicationActions, percentToBps, dollarsToCents, approvalFormToConfig, defaultApprovalForm,
  affiliateTabs, applicationStatusBadge, programStatusBadge, readinessMessage, formatTerms, PROFILE_ACTION_WARNING,
  duplicateFlagLabel, isAffiliateTab,
} from '../affiliate-program-ui'

const good = {
  applicantName: 'Ada Lovelace', email: 'Ada@Example.com', country: 'US', stateRegion: 'NY',
  socialUrls: ['https://www.instagram.com/ada_creates/?hl=en'], motivation: 'I love the clothes and make fashion videos.',
  promotionPlan: 'Short videos plus a link in my bio every week.', ageAttested: true, termsAccepted: true, disclosureAccepted: true,
  privacyAccepted: true, accuracyConfirmed: true, esignConsent: true, termsVersion: 'v1', disclosureVersion: 'v1', privacyVersion: 'v1',
}

describe('social URL canonicalisation', () => {
  test.each([
    ['https://www.instagram.com/Ada_Creates/?hl=en#x', 'instagram', 'ada_creates', 'https://instagram.com/ada_creates'],
    ['instagram.com/ada_creates/', 'instagram', 'ada_creates', 'https://instagram.com/ada_creates'],
    ['http://m.facebook.com/ada.l', 'facebook', 'ada.l', 'https://facebook.com/ada.l'],
    ['https://twitter.com/ada', 'x', 'ada', 'https://x.com/ada'],
    ['https://www.tiktok.com/@Ada.Dance?lang=en', 'tiktok', 'ada.dance', 'https://tiktok.com/@ada.dance'],
    ['https://youtube.com/@AdaTV', 'youtube', 'adatv', 'https://youtube.com/@adatv'],
    ['https://youtube.com/channel/UCabc123', 'youtube', 'channel/ucabc123', 'https://youtube.com/channel/UCabc123'],
  ])('%s', (input, platform, handle, url) => {
    const c = canonicalizeSocialUrl(input)
    expect(c).not.toBeNull()
    expect(c!.platform).toBe(platform)
    expect(c!.handle.toLowerCase()).toBe(handle)
    expect(c!.url.toLowerCase()).toBe(url.toLowerCase())
    expect(c!.key).toBe(`${platform}:${c!.handle}`)
    expect(c!.url.startsWith('https://')).toBe(true)
  })

  test('different spellings of one profile share a duplicate key', () => {
    const a = canonicalizeSocialUrl('https://instagram.com/Ada_Creates')
    const b = canonicalizeSocialUrl('http://www.instagram.com/ada_creates/?igsh=1')
    expect(a!.key).toBe(b!.key)
  })

  test.each([
    'javascript:alert(1)', 'data:text/html,hi', 'mailto:a@b.co', 'ftp://instagram.com/x', 'https://user:pw@instagram.com/x',
    'https://localhost/x', 'https://192.168.0.1/x', 'https://[::1]/x', 'https://instagram.com/', 'https://instagram.com/p/abc123',
    'not a url', '', 'https://foo.local/x',
  ])('rejects %p', (input) => { expect(canonicalizeSocialUrl(input)).toBeNull() })

  test('unknown hosts are accepted as "other" and never as a known platform', () => {
    const c = canonicalizeSocialUrl('https://linktr.ee/Ada')
    expect(c!.platform).toBe('other')
    expect(c!.key).toBe('other:linktr.ee/ada')
  })

  test('parsePublicHttpsUrl refuses credentials and bare hosts', () => {
    expect(parsePublicHttpsUrl('https://a:b@example.com')).toBeNull()
    expect(parsePublicHttpsUrl('https://intranet')).toBeNull()
  })

  test('safeExternalHref allows only clean https', () => {
    expect(safeExternalHref('https://example.com/a')).toBe('https://example.com/a')
    expect(safeExternalHref('http://example.com')).toBeNull()
    expect(safeExternalHref('javascript:alert(1)')).toBeNull()
    expect(safeExternalHref('https://u:p@example.com')).toBeNull()
    expect(safeExternalHref(42)).toBeNull()
  })
})

describe('email normalisation', () => {
  test('dedupe key ignores +tags and Gmail dots but not other dots', () => {
    expect(emailDedupeKey('A.da+x@Gmail.com')).toBe('ada@gmail.com')
    expect(emailDedupeKey('a.da@googlemail.com')).toBe('ada@gmail.com')
    expect(emailDedupeKey('a.da+tag@example.com')).toBe('a.da@example.com')
  })
  test('shape check', () => {
    expect(isEmailShape(normalizeEmail(' A@B.co '))).toBe(true)
    expect(isEmailShape('nope')).toBe(false)
    expect(isEmailShape('a b@c.de')).toBe(false)
  })
})

describe('validateApplicationInput', () => {
  test('a complete application is valid and normalised', () => {
    const r = validateApplicationInput({ ...good, idempotencyKey: 'abcdef123456', preferredCode: 'ada10' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.email).toBe('ada@example.com')
      expect(r.value.preferredCode).toBe('ADA10')
      expect(r.value.socialLinks[0].key).toBe('instagram:ada_creates')
      expect(r.value.idempotencyKey).toBe('abcdef123456')
    }
  })

  test.each(['ageAttested', 'termsAccepted', 'disclosureAccepted', 'privacyAccepted', 'accuracyConfirmed', 'esignConsent'])(
    'each consent is required separately: %s', (k) => {
      const r = validateApplicationInput({ ...good, [k]: false })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(Object.keys(r.errors)).toEqual([k])
    })

  test('consent must be literally true, not a truthy string', () => {
    const r = validateApplicationInput({ ...good, ageAttested: 'true' as any })
    expect(r.ok).toBe(false)
  })

  test('country allowlist is enforced; default is US only', () => {
    expect(validateApplicationInput({ ...good, country: 'CA', stateRegion: 'ON' }).ok).toBe(false)
    expect(validateApplicationInput({ ...good, country: 'CA', stateRegion: 'ON' }, ['US', 'CA']).ok).toBe(true)
  })

  test('US and CA need a state; others do not', () => {
    const r = validateApplicationInput({ ...good, stateRegion: '' })
    expect(r.ok).toBe(false)
    expect(validateApplicationInput({ ...good, country: 'GB', stateRegion: '' }, ['GB']).ok).toBe(true)
  })

  test('at least one valid social link, at most five', () => {
    expect(validateApplicationInput({ ...good, socialUrls: [] }).ok).toBe(false)
    expect(validateApplicationInput({ ...good, socialUrls: ['javascript:alert(1)'] }).ok).toBe(false)
    const six = Array.from({ length: 6 }, (_, i) => `https://instagram.com/user${i}`)
    expect(validateApplicationInput({ ...good, socialUrls: six }).ok).toBe(false)
  })

  test('document versions must be supplied', () => {
    const r = validateApplicationInput({ ...good, termsVersion: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.documents).toBeTruthy()
  })

  test('text is stripped of control characters and trimmed', () => {
    const r = validateApplicationInput({ ...good, applicantName: '  Ada\u0000 L  ' })
    expect(r.ok && r.value.applicantName).toBe('Ada L')
  })

  test('null input yields errors, never throws', () => {
    expect(validateApplicationInput(null).ok).toBe(false)
  })

  test('bad audience size and code are rejected', () => {
    expect(validateApplicationInput({ ...good, audienceSize: '12.5' }).ok).toBe(false)
    expect(validateApplicationInput({ ...good, preferredCode: 'bad code!' }).ok).toBe(false)
    const ok = validateApplicationInput({ ...good, audienceSize: '12,500' })
    expect(ok.ok && ok.value.audienceSize).toBe(12500)
  })
})

describe('document parser (text nodes only)', () => {
  test('headings, lists, paragraphs and bold', () => {
    const b = parseDocument('# Title\n\nHello **world** and more.\n\n- one\n- two **b**\n\n## Sub')
    expect(b.map(x => x.type)).toEqual(['heading', 'paragraph', 'list', 'heading'])
    const p = b[1] as any
    expect(p.inline).toEqual([{ text: 'Hello ', bold: false }, { text: 'world', bold: true }, { text: ' and more.', bold: false }])
    expect((b[2] as any).items).toHaveLength(2)
  })
  test('an unmatched ** stays literal', () => {
    expect(parseInline('a **b')).toEqual([{ text: 'a ', bold: false }, { text: '**b', bold: false }])
  })
  test('HTML is never interpreted: it comes back as plain text', () => {
    const b = parseDocument('<script>alert(1)</script> <img src=x onerror=1>')
    expect(JSON.stringify(b)).toContain('<script>')
    expect((b[0] as any).type).toBe('paragraph')
    expect(documentPlainText('<b>x</b>')).toContain('<b>x</b>')
  })
  test('slugs round-trip and reject unknown types', () => {
    expect(docSlug('program_terms')).toBe('program-terms')
    expect(docTypeFromSlug('disclosure-policy')).toBe('disclosure_policy')
    expect(docTypeFromSlug('../../etc')).toBeNull()
    expect(docTypeFromSlug(undefined)).toBeNull()
    expect(documentHref('program_terms', 'v2')).toBe('/affiliates/documents/program-terms?version=v2')
  })
})

describe('program settings', () => {
  test('defaults: U.S. only, placeholders not allowed', () => {
    const s = mergeProgramSettings(undefined)
    expect(s).toEqual(DEFAULT_PROGRAM_SETTINGS)
    expect(s.countries).toEqual(['US'])
    expect(s.allowPlaceholderDocuments).toBe(false)
  })
  test('merge falls back to defaults for invalid stored fields', () => {
    const s = mergeProgramSettings({ countries: 'US', rateLimits: { perIpPerHour: -4 }, inviteExpiryDays: 'x', allowPlaceholderDocuments: 'yes' })
    expect(s.countries).toEqual(['US'])
    expect(s.rateLimits.perIpPerHour).toBe(DEFAULT_PROGRAM_SETTINGS.rateLimits.perIpPerHour)
    expect(s.allowPlaceholderDocuments).toBe(false)
  })
  test('strict validation rejects instead of coercing', () => {
    const ok = { ...DEFAULT_PROGRAM_SETTINGS, countries: ['us', 'CA'] }
    const v = validateProgramSettingsInput(ok)
    expect(v.ok && v.value.countries).toEqual(['US', 'CA'])
    expect(validateProgramSettingsInput({ ...ok, countries: ['USA'] }).ok).toBe(false)
    expect(validateProgramSettingsInput({ ...ok, inviteExpiryDays: 0 }).ok).toBe(false)
    expect(validateProgramSettingsInput({ ...ok, rateLimits: { ...ok.rateLimits, perIpPerHour: 0 } }).ok).toBe(false)
    expect(validateProgramSettingsInput({ ...ok, defaults: { ...ok.defaults, commissionHoldDays: 999 } }).ok).toBe(false)
    expect(validateProgramSettingsInput(null).ok).toBe(false)
  })
})

describe('admin input validators', () => {
  test('approval config: percentage commission', () => {
    const r = validateApprovalConfig({ code: 'ada10', commissionType: 'percentage', commissionRateBps: 1000 })
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.value.code).toBe('ADA10'); expect(r.value.commissionRateBps).toBe(1000); expect(r.value.paidAdsPolicy).toBe('not_permitted'); expect(r.value.activateNow).toBe(false) }
  })
  test('approval config rejects bad values', () => {
    expect(validateApprovalConfig({ code: 'x', commissionType: 'percentage', commissionRateBps: 1000 }).ok).toBe(false)
    expect(validateApprovalConfig({ code: 'ADA10', commissionType: 'percentage', commissionRateBps: 0 }).ok).toBe(false)
    expect(validateApprovalConfig({ code: 'ADA10', commissionType: 'percentage', commissionRateBps: 20000 }).ok).toBe(false)
    expect(validateApprovalConfig({ code: 'ADA10', commissionType: 'fixed', commissionFixedCents: -1 }).ok).toBe(false)
    expect(validateApprovalConfig({ code: 'ADA10', commissionType: 'percentage', commissionRateBps: 1000, commissionHoldDays: 400 }).ok).toBe(false)
    expect(validateApprovalConfig({ code: 'ADA10', commissionType: 'percentage', commissionRateBps: 1000, discountType: 'percentage' }).ok).toBe(false)
    expect(validateApprovalConfig({ code: 'ADA10', commissionType: 'percentage', commissionRateBps: 1000, programStartAt: '2026-05-02', programEndAt: '2026-05-01' }).ok).toBe(false)
    expect(validateApprovalConfig({ code: 'ADA10', commissionType: 'percentage', commissionRateBps: 1000, paidAdsPolicy: 'sure' }).ok).toBe(false)
    expect(validateApprovalConfig({ code: 'ADA10', commissionType: 'percentage', commissionRateBps: 10.5 }).ok).toBe(false)
    expect(validateApprovalConfig({ code: 'ADA10', commissionType: 'percentage', commissionRateBps: NaN }).ok).toBe(false)
  })
  test('invite validation', () => {
    const r = validateInviteInput({ email: 'x@y.co', displayName: 'Ada', socialUrls: ['https://instagram.com/ada'], proposedCode: 'ada5' })
    expect(r.ok).toBe(true)
    expect(validateInviteInput({ email: 'bad', displayName: 'Ada' }).ok).toBe(false)
    expect(validateInviteInput({ email: 'x@y.co', displayName: 'A' }).ok).toBe(false)
    expect(validateInviteInput({ email: 'x@y.co', displayName: 'Ada', socialUrls: ['javascript:1'] }).ok).toBe(false)
  })
  test('profile settings validation only passes known keys', () => {
    const r = validateProfileSettingsInput({ displayName: 'Ada', secret: 'x', payoutThresholdCents: 5000 })
    expect(r.ok && Object.keys(r.value).sort()).toEqual(['displayName', 'payoutThresholdCents'])
    expect(validateProfileSettingsInput({}).ok).toBe(false)
    expect(validateProfileSettingsInput({ paidAdsPolicy: 'x' }).ok).toBe(false)
    expect(validateProfileSettingsInput({ website: 'http://x.co' }).ok).toBe(false)
  })
  test('document validation', () => {
    expect(validateDocumentInput({ docType: 'program_terms', title: 'Terms', body: 'x'.repeat(30) }).ok).toBe(true)
    expect(validateDocumentInput({ docType: 'other', title: 'Terms', body: 'x'.repeat(30) }).ok).toBe(false)
    expect(validateDocumentInput({ docType: 'program_terms', title: 'Terms', body: 'short' }).ok).toBe(false)
  })
})

describe('PG error mapping', () => {
  test('maps KVRN_AFFPROG codes to safe ProgramErrors', () => {
    const e = toProgramError(new Error('KVRN_AFFPROG|CODE_TAKEN'))
    expect(e).toBeInstanceOf(ProgramError)
    expect(e!.status).toBe(409)
    expect(toProgramError(new Error('KVRN_AFFPROG|ACTIVATION_NOT_ALLOWED|the start date has not been reached'))!.message).toContain('start date')
    expect(toProgramError(new Error('duplicate key value violates unique constraint "affiliates_code_uq"'))!.code).toBe('CODE_TAKEN')
    expect(toProgramError(new Error('connection refused'))).toBeNull()
  })
  test('does not echo raw SQL text', () => {
    const e = toProgramError(new Error('KVRN_AFFPROG|INVALID_INPUT|SELECT secret FROM x'))
    expect(e!.message).not.toContain('SELECT')
  })
})

describe('affiliate application secret hardening', () => {
  test('production requires a >=32-character hash pepper', () => {
    expect(affiliateHashPepperConfigured({ NODE_ENV: 'production' })).toBe(false)
    expect(affiliateHashPepperConfigured({ NODE_ENV: 'production', AFFILIATE_HASH_PEPPER: 'short' })).toBe(false)
    expect(affiliateHashPepperConfigured({ NODE_ENV: 'production', AFFILIATE_HASH_PEPPER: ' '.repeat(32) })).toBe(false)
    expect(affiliateHashPepperConfigured({ NODE_ENV: 'production', AFFILIATE_HASH_PEPPER: 'x'.repeat(32) })).toBe(true)
    expect(affiliateHashPepperConfigured({ NODE_ENV: 'test' })).toBe(true)
  })
  test('production client IP never trusts X-Forwarded-For without Cloudflare', () => {
    expect(clientIpFrom(new Headers({ 'x-forwarded-for': '198.51.100.8' }), { NODE_ENV: 'production' })).toBe('unknown')
    expect(clientIpFrom(new Headers({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.8' }), { NODE_ENV: 'production' })).toBe('203.0.113.7')
  })
})

describe('form token', () => {
  const env = { AFFILIATE_HASH_PEPPER: 'test-pepper' }
  test('valid after the minimum fill time and before expiry', async () => {
    const t0 = 1_800_000_000_000
    const tok = await issueFormToken(t0, env)
    expect(await checkFormToken(tok, t0 + 1000, env)).toBe('too_fast')
    expect(await checkFormToken(tok, t0 + MIN_FILL_MS + 1, env)).toBe('ok')
    expect(await checkFormToken(tok, t0 + MAX_FORM_AGE_MS + 1, env)).toBe('expired')
  })
  test('tampering, wrong pepper, garbage and clock skew are invalid', async () => {
    const t0 = 1_800_000_000_000
    const tok = await issueFormToken(t0, env)
    expect(await checkFormToken(tok.replace(/.$/, c => (c === '0' ? '1' : '0')), t0 + 10_000, env)).toBe('invalid')
    expect(await checkFormToken(tok, t0 + 10_000, { AFFILIATE_HASH_PEPPER: 'other' })).toBe('invalid')
    expect(await checkFormToken('nonsense', t0 + 10_000, env)).toBe('invalid')
    expect(await checkFormToken(undefined, t0 + 10_000, env)).toBe('invalid')
    expect(await checkFormToken(tok, t0 - 5_000, env)).toBe('invalid')
  })
  test('hashValue is deterministic, scoped and salted', async () => {
    const a = await hashValue('ip', '1.2.3.4', { AFFILIATE_HASH_PEPPER: 'a' })
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(await hashValue('ip', '1.2.3.4', { AFFILIATE_HASH_PEPPER: 'a' }))
    expect(a).not.toBe(await hashValue('ua', '1.2.3.4', { AFFILIATE_HASH_PEPPER: 'a' }))
    expect(a).not.toBe(await hashValue('ip', '1.2.3.4', { AFFILIATE_HASH_PEPPER: 'b' }))
    expect(a).not.toContain('1.2.3.4')
  })
  test('client IP prefers the Cloudflare header', () => {
    const h = (m: Record<string, string>) => ({ get: (k: string) => m[k.toLowerCase()] ?? null })
    expect(clientIpFrom(h({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' }))).toBe('9.9.9.9')
    expect(clientIpFrom(h({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))).toBe('1.1.1.1')
    expect(clientIpFrom(h({}))).toBe('unknown')
  })
})

describe('email rendering', () => {
  test('every kind renders with a subject and no unescaped input', () => {
    const evil = '<script>alert(1)</script>"\'&'
    for (const kind of AFFILIATE_EMAIL_KINDS) {
      const { subject, html } = renderAffiliateEmail({ kind, payload: { displayName: evil, message: evil }, origin: 'https://kvrn.test', inviteToken: 'a'.repeat(64) })
      expect(subject.length).toBeGreaterThan(5)
      expect(html).not.toContain('<script>')
      expect(html).toContain('KVRN')
    }
  })
  test('esc escapes the five HTML metacharacters', () => {
    expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
    expect(esc(null)).toBe('')
  })
  test('the invite email carries the one-time link; others carry no token', () => {
    const tok = 'b'.repeat(64)
    expect(renderAffiliateEmail({ kind: 'affiliate_invite', payload: {}, origin: 'https://kvrn.test', inviteToken: tok }).html).toContain(`/affiliates/apply#invite=${tok}`)
    expect(renderAffiliateEmail({ kind: 'application_received', payload: {}, origin: 'https://kvrn.test' }).html).not.toContain('invite=')
  })
  test('a rejection shows only the message written for the applicant', () => {
    const { html } = renderAffiliateEmail({ kind: 'application_rejected', payload: { displayName: 'Ada', message: 'Not a fit right now.', internalNote: 'SECRET NOTE' }, origin: 'https://kvrn.test' })
    expect(html).toContain('Not a fit right now.')
    expect(html).not.toContain('SECRET NOTE')
  })
  test('no email promises approval or money', () => {
    const { html } = renderAffiliateEmail({ kind: 'application_received', payload: {}, origin: 'https://kvrn.test' })
    expect(html.toLowerCase()).not.toContain('you are approved')
    expect(html).not.toMatch(/\$\d/)
  })
})

describe('Admin UI helpers', () => {
  test('lifecycle actions by status', () => {
    expect(availableProfileActions('onboarding')).toEqual(['activate', 'terminate'])
    expect(availableProfileActions('active')).toEqual(['suspend', 'terminate'])
    expect(availableProfileActions('suspended')).toEqual(['reinstate', 'terminate'])
    expect(availableProfileActions('terminated')).toEqual(['reinstate'])
    expect(availableProfileActions('weird')).toEqual([])
  })
  test('destructive actions carry a visible warning text', () => {
    expect(PROFILE_ACTION_WARNING.suspend).toMatch(/code and referral link/)
    expect(PROFILE_ACTION_WARNING.terminate).toMatch(/history is kept/i)
  })
  test('application actions: approved is final; rejected can only be anonymized', () => {
    expect(availableApplicationActions('approved_onboarding')).toEqual([])
    expect(availableApplicationActions('rejected')).toEqual(['anonymize'])
    expect(availableApplicationActions('pending')).toContain('approve')
    expect(availableApplicationActions('needs_info')).not.toContain('request_info')
  })
  test('number entry converts once and flags invalid input as NaN', () => {
    expect(percentToBps('12.5')).toBe(1250)
    expect(percentToBps('')).toBeNull()
    expect(percentToBps('abc')).toBeNaN()
    expect(percentToBps('-1')).toBeNaN()
    expect(dollarsToCents('$1,234.56')).toBe(123456)
    expect(dollarsToCents('19.999')).toBe(2000)
    expect(dollarsToCents('')).toBeNull()
  })
  test('approval form -> config -> server validator round trip', () => {
    const form = defaultApprovalForm({ preferredCode: 'ada10', invite: null }, { commissionType: 'percentage', commissionRateBps: 1000, attributionWindowDays: 30, commissionHoldDays: 30, payoutThresholdCents: 5000, payoutSchedule: 'monthly', paidAdsPolicy: 'not_permitted' })
    expect(form.code).toBe('ADA10')
    expect(form.ratePercent).toBe('10')
    expect(form.payoutThresholdDollars).toBe('50.00')
    const cfg = approvalFormToConfig(form)
    expect(cfg.commissionRateBps).toBe(1000)
    const v = validateApprovalConfig(cfg as any)
    expect(v.ok).toBe(true)
  })
  test('invite proposal pre-fills the approval form but program defaults fill the gaps', () => {
    const f = defaultApprovalForm({ preferredCode: 'x', invite: { proposedCode: 'invited5', commissionType: 'fixed', commissionFixedCents: 750, startAt: '2026-11-01T00:00:00.000Z' } },
      { commissionType: 'percentage', commissionRateBps: 1000, attributionWindowDays: 14, commissionHoldDays: 7, payoutThresholdCents: null, payoutSchedule: null, paidAdsPolicy: 'not_permitted' })
    expect(f.code).toBe('INVITED5'); expect(f.commissionType).toBe('fixed'); expect(f.fixedDollars).toBe('7.50'); expect(f.startAt).toBe('2026-11-01'); expect(f.windowDays).toBe('14')
  })
  test('tabs include the required IA and counts only when positive', () => {
    const t = affiliateTabs({ openApplications: 3, unresolved: 0, reacceptance: 2 })
    expect(t.map(x => x.id)).toEqual(['overview', 'applications', 'affiliates', 'commissions', 'payouts', 'unresolved', 'compliance', 'readiness', 'terms', 'audit'])
    expect(t.find(x => x.id === 'applications')!.count).toBe(3)
    expect(t.find(x => x.id === 'unresolved')!.count).toBeUndefined()
    expect(isAffiliateTab('terms')).toBe(true); expect(isAffiliateTab('x')).toBe(false)
  })
  test('badges always carry text', () => {
    expect(applicationStatusBadge('needs_info').label).toBe('Needs info')
    expect(programStatusBadge('onboarding').label).toBe('Onboarding')
    expect(programStatusBadge('suspended').status).toBe('Suspended')
    expect(duplicateFlagLabel('duplicate_social')).toMatch(/Social/)
  })
  test('readiness message lists reasons when closed', () => {
    expect(readinessMessage({ open: true, reasons: [] }).tone).toBe('success')
    const r = readinessMessage({ open: false, reasons: ['x'] })
    expect(r.tone).toBe('warning'); expect(r.reasons).toEqual(['x'])
  })
  test('terms formatting never shows an unset commission as $0', () => {
    expect(formatTerms('percentage', 1250, null)).toBe('12.50%')
    expect(formatTerms('fixed', null, 500)).toBe('$5.00 per order')
    expect(formatTerms('percentage', null, null)).toBe('Not set')
    expect(formatTerms('fixed', null, null)).toBe('Not set')
  })
})
