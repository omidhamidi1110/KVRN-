// /api/admin/content/i18n (Languages & currency) against REAL PostgreSQL: authentication first,
// optimistic revisions, validation, the audit trail, and the rule that nothing in Admin can make a
// non-USD currency payable. Requires a LOCAL TEST_DATABASE_URL; skips visibly otherwise.
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import { HAVE_DB, createFiDb, type FiDb } from './helpers/fi-pg'
import { loadStorefrontI18nSettings } from '../i18n/config'
import { __resetI18nSettingsCache, buildStorefrontI18n } from '../i18n/server'
import { LOCALE_CODES } from '../i18n/locales'

jest.mock('@/lib/admin-auth', () => ({
  requireAdmin: async () => {
    if ((global as any).__I18N_DENY) return { identity: null, error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }) }
    return { identity: { email: 'owner@kvrn.test' }, error: null }
  },
}))
jest.mock('@/lib/db', () => ({ get sql() { return (global as any).__I18N_SQL } }))

const ROOT = path.resolve(__dirname, '../..')
const d = HAVE_DB ? describe : describe.skip
if (!HAVE_DB) test('NOTE: i18n admin DB tests skipped — TEST_DATABASE_URL absent or not local.', () => expect(true).toBe(true))

let F: FiDb
const URL_ = 'http://localhost/api/admin/content/i18n'
const route = () => require('../../app/api/admin/content/i18n/route')
const get = async () => {
  const res = await route().GET(new NextRequest(URL_))
  return { status: res.status as number, json: await res.json() }
}
const put = async (body: unknown) => {
  const res = await route().PUT(new NextRequest(URL_, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
  return { status: res.status as number, json: await res.json() }
}
const config = (over: Record<string, unknown> = {}) => ({
  enabledLocales: ['en', 'es', 'ar'], enabledCurrencies: ['USD', 'EUR'],
  defaultCurrencyByLocale: Object.fromEntries(LOCALE_CODES.map(l => [l, l === 'es' ? 'EUR' : 'USD'])), ...over,
})
const today = () => new Date().toISOString().slice(0, 10)

beforeAll(async () => { if (HAVE_DB) { F = await createFiDb('i18n_admin'); (global as any).__I18N_SQL = F.sql } }, 180_000)
afterAll(async () => { await F?.close() })
afterEach(() => { (global as any).__I18N_DENY = false; delete process.env.KVRN_FLAG_MULTI_CURRENCY_CHECKOUT })

describe('route source: authenticated first, dynamic, no cache', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/api/admin/content/i18n/route.ts'), 'utf8')
  test('every handler calls requireAdmin before doing anything', () => {
    expect(src).toMatch(/export const dynamic = 'force-dynamic'/)
    for (const m of ['GET', 'PUT']) {
      const start = src.indexOf(`export async function ${m}`)
      const body = src.slice(start, start + 200)
      expect(body).toMatch(/requireAdmin\(req\)/)
      expect(body.indexOf('requireAdmin(req)')).toBeLessThan(body.indexOf('respond(') === -1 ? 1e9 : body.indexOf('respond('))
    }
    expect(src).not.toMatch(/export async function (POST|PATCH|DELETE)/)
  })
})

d('Languages & currency admin API (real PG)', () => {
  test('unauthenticated requests get 401 and change nothing', async () => {
    ;(global as any).__I18N_DENY = true
    expect((await get()).status).toBe(401)
    expect((await put({ section: 'config', value: config(), revision: 0 })).status).toBe(401)
    expect((await F.q(`SELECT count(*)::int AS n FROM site_settings WHERE key LIKE 'i18n.%'`))[0].n).toBe(0)
  })

  test('GET describes every locale honestly, and USD as the only payable currency', async () => {
    const r = await get()
    expect(r.status).toBe(200)
    const data = r.json.data
    expect(data.locales.map((l: any) => l.code).sort()).toEqual([...LOCALE_CODES].sort())
    expect(data.messageKeyCount).toBeGreaterThan(300)
    for (const l of data.locales) {
      expect(l.ready).toBe(true); expect(l.staticMissing).toBe(0); expect(l.staticPresent).toBe(l.staticTotal)
      expect(l.review.status).toBe(l.code === 'en' ? 'source' : 'ai_assisted_unreviewed')
      expect(l.cms).toEqual(expect.objectContaining({ translated: 0, missing: 0 }))
    }
    expect(data.config.stored).toBe(false)
    expect(data.fx.status).toBe('missing')
    expect(data.payable.auditPassed).toEqual(['USD'])
    expect(data.currencies.filter((c: any) => c.payable).map((c: any) => c.code)).toEqual(['USD'])
    expect(data.payable.blockers.length).toBe(10)
  })

  test('saving the config writes the setting and an audit row; the storefront reads it back', async () => {
    const before = (await get()).json.data.config.revision
    const r = await put({ section: 'config', value: config(), revision: before })
    expect(r.status).toBe(200)
    expect(r.json.data.revision).toBe(before + 1)
    expect(r.json.data.value.enabledLocales).toEqual(['en', 'es', 'ar'])
    const audit = await F.q(`SELECT actor_email, action, resource, resource_id FROM admin_audit_logs WHERE resource_id = 'i18n.config'`)
    expect(audit).toEqual([{ actor_email: 'owner@kvrn.test', action: 'settings.update', resource: 'site_settings', resource_id: 'i18n.config' }])
    __resetI18nSettingsCache()
    const settings = await loadStorefrontI18nSettings(F.sql, LOCALE_CODES, new Date())
    expect(settings.config.enabledLocales).toEqual(['en', 'es', 'ar'])
    expect(settings.config.defaultCurrencyByLocale.es).toBe('EUR')
    // Spanish with no rate configured: the default currency is not displayable, so the seed is USD.
    const seed = buildStorefrontI18n({ localeCookie: 'es', currencyCookie: null, settings, now: new Date(), multiCurrencyFlag: false })
    expect(seed).toMatchObject({ locale: 'es', currency: 'USD' })
    // A locale that was not enabled cannot be served from a cookie.
    expect(buildStorefrontI18n({ localeCookie: 'ja', currencyCookie: null, settings, now: new Date(), multiCurrencyFlag: false }).locale).toBe('en')
  })

  test('a stale revision is a 409 and changes nothing', async () => {
    const rev = (await get()).json.data.config.revision
    const r = await put({ section: 'config', value: config({ enabledLocales: ['en'] }), revision: rev - 1 })
    expect(r.status).toBe(409)
    expect((await get()).json.data.config.value.enabledLocales).toEqual(['en', 'es', 'ar'])
  })

  test('invalid input is a 400 with field messages: unknown language, USD removed, default outside the enabled set', async () => {
    const rev = (await get()).json.data.config.revision
    const bad1 = await put({ section: 'config', value: config({ enabledLocales: ['en', 'klingon'] }), revision: rev })
    expect(bad1.status).toBe(400)
    const bad2 = await put({ section: 'config', value: config({ enabledCurrencies: ['EUR'] }), revision: rev })
    expect(bad2.status).toBe(400)
    const bad3 = await put({ section: 'config', value: config({ defaultCurrencyByLocale: { ...config().defaultCurrencyByLocale, es: 'GBP' } }), revision: rev })
    expect(bad3.status).toBe(400)
    expect((await put({ section: 'nope', value: {}, revision: rev })).status).toBe(400)
    expect((await put({ section: 'config', value: config() })).status).toBe(400)     // revision required
    expect((await get()).json.data.config.revision).toBe(rev)
  })

  test('exchange rates: validated, dated, audited; the matrix shows an estimate but never a payable currency', async () => {
    const fxRev = (await get()).json.data.fx.revision
    const bad = await put({ section: 'fx', value: { rates: { EUR: -3 }, asOf: today(), source: 'x' }, revision: fxRev })
    expect(bad.status).toBe(400)
    const future = await put({ section: 'fx', value: { rates: { EUR: 0.9 }, asOf: '2999-01-01', source: 'x' }, revision: fxRev })
    expect(future.status).toBe(400)
    const ok = await put({ section: 'fx', value: { rates: { EUR: 0.9, JPY: 150 }, asOf: today(), source: 'ECB reference rates' }, revision: fxRev })
    expect(ok.status).toBe(200)
    expect((await F.q(`SELECT count(*)::int AS n FROM admin_audit_logs WHERE resource_id = 'i18n.fx'`))[0].n).toBe(1)

    // The flag ON must not make anything payable either: the policy, not the flag, decides.
    process.env.KVRN_FLAG_MULTI_CURRENCY_CHECKOUT = 'on'
    const data = (await get()).json.data
    expect(data.fx.status).toBe('fresh')
    expect(data.payable.multiCurrencyFlag).toBe(true)
    const by = Object.fromEntries(data.currencies.map((c: any) => [c.code, c]))
    expect(by.EUR).toMatchObject({ displayable: true, payable: false })      // enabled in the config above and rated
    expect(by.JPY).toMatchObject({ displayable: false, payable: false })     // rated but not enabled
    expect(by.GBP).toMatchObject({ displayable: false, payable: false })
    expect(data.currencies.filter((c: any) => c.payable).map((c: any) => c.code)).toEqual(['USD'])

    // With the rate in place, the storefront seed can show EUR as an estimate — and still charges USD.
    __resetI18nSettingsCache()
    const settings = await loadStorefrontI18nSettings(F.sql, LOCALE_CODES, new Date())
    const seed = buildStorefrontI18n({ localeCookie: 'es', currencyCookie: null, settings, now: new Date(), multiCurrencyFlag: true })
    expect(seed.currency).toBe('EUR'); expect(seed.rates).toEqual({ EUR: 0.9 }); expect(seed.payable).toEqual(['USD'])
  })

  test('clearing the rates puts every price back to USD', async () => {
    const fxRev = (await get()).json.data.fx.revision
    expect((await put({ section: 'fx', value: { clear: true }, revision: fxRev })).status).toBe(200)
    const data = (await get()).json.data
    expect(data.fx.status).toBe('missing')
    expect(data.currencies.filter((c: any) => c.displayable).map((c: any) => c.code)).toEqual(['USD'])
    __resetI18nSettingsCache()
    const settings = await loadStorefrontI18nSettings(F.sql, LOCALE_CODES, new Date())
    expect(buildStorefrontI18n({ localeCookie: 'es', currencyCookie: 'EUR', settings, now: new Date(), multiCurrencyFlag: false }).currency).toBe('USD')
  })

  test('translation completeness reflects real content_translations rows', async () => {
    const pid = '00000000-0000-4000-8000-0000000000aa'
    await F.q(`INSERT INTO content_translations (entity_type, entity_id, locale, field, value, status) VALUES
      ('product', $1, 'es', 'name', 'Sudadera', 'published'), ('product', $1, 'es', 'description', 'Borrador', 'draft')`, [pid])
    const { createI18nAdminService } = await import('../i18n-admin-service')
    const snap = (await import('../product-model')).emptySnapshot({ name: 'Hoodie', slug: 'hoodie', productType: 'hoodies' })
    snap.description = 'A hoodie.'
    const svc = createI18nAdminService(F.sql, { listProductSnapshots: async () => [{ productId: pid, snapshot: snap }] })
    const rows = (await svc.get()).locales
    const es = rows.find(l => l.code === 'es')!
    expect(es.cms.publishedRows).toBe(1); expect(es.cms.draftRows).toBe(1)
    expect(es.cms.translated).toBe(1)                      // only the published name counts
    expect(es.cms.missing).toBeGreaterThanOrEqual(1)       // the draft description does not count as translated
    expect(rows.find(l => l.code === 'fr')!.cms.translated).toBe(0)
  })
})
