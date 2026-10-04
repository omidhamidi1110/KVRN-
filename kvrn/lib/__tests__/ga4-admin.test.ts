// lib/__tests__/ga4-admin.test.ts — the modest GA status on /admin/analytics, and the docs/env agree with the code.
import fs from 'fs'
import path from 'path'
import { describeGaConfig } from '../ga4-server'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

describe('admin GA status', () => {
  const page = read('app/admin/analytics/page.tsx')
  const ui = read('app/admin/analytics/AnalyticsClient.tsx')

  test('the server page hands the client component STATES only, computed server-side', () => {
    expect(page).not.toMatch(/^['"]use client['"]/m)
    expect(page).toMatch(/<AnalyticsClient ga=\{describeGaConfig\(\)\} \/>/)
    expect(ui).not.toMatch(/process\.env|GA4_MEASUREMENT_PROTOCOL_SECRET|ga4-server/)
  })
  test('describeGaConfig never contains the secret, in any state', () => {
    for (const secret of ['sEcReT_abcdef123456', 'short', 'has space&amp=chars']) {
      const s = describeGaConfig({ NEXT_PUBLIC_GA_MEASUREMENT_ID: 'G-TEST123456', GA4_MEASUREMENT_PROTOCOL_SECRET: secret })
      expect(JSON.stringify(s)).not.toContain(secret.trim())
      expect(Object.keys(s).sort()).toEqual(['clientState', 'measurementId', 'secretState'])
    }
  })
  test('the page distinguishes KVRN first-party numbers from Google Analytics as an external system', () => {
    expect(ui).toMatch(/KVRN first-party funnel/)
    expect(ui).toMatch(/Google Analytics 4 \(external system\)/)
    expect(ui).toMatch(/GA is a separate system: its numbers will differ/)
  })
  test('the Google Analytics link follows the existing provider-link pattern (new tab, noopener noreferrer)', () => {
    expect(ui).toMatch(/<a href="https:\/\/analytics\.google\.com\/analytics\/web\/" target="_blank" rel="noopener noreferrer"/)
    expect(read('app/admin/sms/AdminSmsClient.tsx')).toMatch(/target="_blank" rel="noopener noreferrer"/)   // the pattern it follows
  })
  test('no Reporting API / OAuth / service-account code was added', () => {
    for (const f of ['app/admin/analytics/AnalyticsClient.tsx', 'lib/ga4-server.ts', 'lib/ga-client.ts', 'lib/ga-common.ts']) {
      expect(read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).not.toMatch(/analyticsdata|googleapis|service[_ ]account|oauth|runReport/i)
    }
  })
  test('the first-party admin API is unchanged: still requireAdmin first', () => {
    expect(read('app/api/admin/analytics/funnel/route.ts')).toMatch(/requireAdmin/)
  })
})

describe('documentation and env example agree with the code', () => {
  const doc = read('GA4-INTEGRATION.md')
  test('the doc names both env vars and the 2.5 s bound that the code uses', () => {
    expect(doc).toMatch(/NEXT_PUBLIC_GA_MEASUREMENT_ID/); expect(doc).toMatch(/GA4_MEASUREMENT_PROTOCOL_SECRET/)
    expect(read('lib/ga4-server.ts')).toMatch(/GA_SERVER_TIMEOUT_MS = 2500/)
    expect(doc).toMatch(/2\.5 s/)
  })
  test('the doc covers accepted, declined, DNT and GPC', () => {
    for (const w of ['No choice yet', 'Accepted', 'Declined', 'Withdrawn mid-session', 'Do Not Track', 'Global Privacy Control']) expect(doc).toContain(w)
  })
  test('the doc lists the five GA4 events and says utm_content/term are not used', () => {
    for (const e of ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase']) expect(doc).toContain('`' + e + '`')
    expect(read('FUNNEL-ANALYTICS.md')).toMatch(/utm_content.*not captured/)
  })
  test('.env.example documents the variables, with the secret marked a Cloudflare secret', () => {
    const env = read('.env.example')
    expect(env).toMatch(/^NEXT_PUBLIC_GA_MEASUREMENT_ID=$/m)
    expect(env).toMatch(/^GA4_MEASUREMENT_PROTOCOL_SECRET=$/m)
    expect(env).toMatch(/Cloudflare SECRET/)
  })
})

describe('Consent Mode: advertising signals are never granted', () => {
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  test('the cookie-preferences gtag update is built by the shared pure helper, which hard-denies every advertising signal', () => {
    const ctx = strip(read('context/CookiePrefsContext.tsx'))
    const apply = ctx.slice(ctx.indexOf('function applyToGtag'), ctx.indexOf('const Ctx'))
    expect(apply).toMatch(/buildGtagConsentUpdate\(prefs\)/)
    expect(apply).not.toMatch(/prefs\.advertising|prefs\.analytics/)       // no raw preference reaches gtag any more

    const src = strip(read('lib/consent-effective.ts'))
    const fn = src.slice(src.indexOf('export function buildGtagConsentUpdate'))
    expect(fn).toMatch(/ad_storage:\s+'denied'/)
    expect(fn).toMatch(/ad_user_data:\s+'denied'/)
    expect(fn).toMatch(/ad_personalization:\s+'denied'/)
    expect(fn).not.toMatch(/prefs\.advertising/)
    // analytics follows EFFECTIVE consent (preference AND no DNT AND no GPC), never the raw preference
    expect(fn).toMatch(/analytics_storage:\s+effectiveAnalyticsConsent\(prefs\.analytics, nav\) \? 'granted' : 'denied'/)
  })
})
