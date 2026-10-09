import { validatePublicEmailConsent } from '../marketing-email-consent'

describe('public email marketing consent', () => {
  it('rejects absent, false and string-form checkbox assertions', () => {
    expect(validatePublicEmailConsent({}, 'waitlist').ok).toBe(false)
    expect(validatePublicEmailConsent({emailMarketingConsent: false}, 'waitlist').ok).toBe(false)
    expect(validatePublicEmailConsent({emailMarketingConsent: 'true'}, 'waitlist').ok).toBe(false)
  })
  it('accepts affirmative email-only enrollment', () => {
    expect(validatePublicEmailConsent({emailMarketingConsent:true,source:'footer'},'waitlist')).toEqual({ok:true,source:'waitlist'})
  })
  it('does not mistake a client-provided source label for verified provenance', () => {
    expect(validatePublicEmailConsent({emailMarketingConsent:true,source:'homepage'},'waitlist')).toEqual({ok:true,source:'waitlist'})
  })
  it('never accepts phone or SMS consent as email enrollment', () => {
    for (const extra of [{phone:'+15555550111'},{smsConsent:false},{smsConsent:true},{smsMarketingConsent:true}]) {
      expect(validatePublicEmailConsent({emailMarketingConsent:true,...extra}, 'waitlist').ok).toBe(false)
    }
  })
  it('rejects admin, checkout and arbitrary sources on public endpoints', () => {
    for (const source of ['manual_admin','checkout','fake','giveaway',123]) {
      expect(validatePublicEmailConsent({emailMarketingConsent:true,source}, 'homepage').ok).toBe(false)
    }
  })
})

it('does not silently turn unsubscribed marketing contacts back on', () => {
  const fs=require('fs') as typeof import('fs')
  const source=fs.readFileSync('lib/marketing-subscribers.ts','utf8')
  expect(source).toContain('marketing_email_consent_events')
  expect(source).toContain('status = marketing_subscribers.status')
  expect(source).not.toContain("status          = 'subscribed'")
})
