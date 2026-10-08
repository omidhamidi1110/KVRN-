// Pure UI logic + source guards for the affiliate portal (there is no DOM in this jest setup, so the UI is kept as
// pure functions + React that only renders text nodes; these guards stop the dangerous patterns from creeping in).
import fs from 'fs'
import path from 'path'
import {
  accessBanner, extractFragmentToken, formatCents, labelFor, parseInline, parseMarkdownLite, portalFetch, readCookie, setupSteps,
  toneForStatus, READINESS_LABEL, PAYOUT_STATUS_LABEL,
} from '../affiliate-portal-ui'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out); else out.push(p)
  }
  return out
}
const rel = (f: string) => path.relative(ROOT, f)

describe('money formatting never turns unknown into $0', () => {
  test.each([
    [null, '—'], [undefined, '—'], [NaN, '—'], [Infinity, '—'],
    [0, '$0.00'], [5, '$0.05'], [100, '$1.00'], [123456, '$1,234.56'], [-250, '-$2.50'], [100000000, '$1,000,000.00'],
  ])('%p → %p', (input, out) => { expect(formatCents(input as any)).toBe(out) })
  test('other currencies carry their code', () => { expect(formatCents(1050, 'EUR')).toBe('EUR 10.50') })
})

describe('labels + tones', () => {
  test('known statuses map; unknown ones degrade to readable text, not undefined', () => {
    expect(labelFor(PAYOUT_STATUS_LABEL, 'processing')).toBe('Processing')
    expect(labelFor(READINESS_LABEL, 'problem')).toBe('Needs attention')
    expect(labelFor(READINESS_LABEL, 'some_new_state')).toBe('some new state')
    expect(labelFor(READINESS_LABEL, null)).toBe('—')
  })
  test('tones: failures are never green, unknown is muted', () => {
    expect(toneForStatus('paid')).toBe('good'); expect(toneForStatus('failed')).toBe('bad')
    expect(toneForStatus('pending')).toBe('warn'); expect(toneForStatus('wat')).toBe('muted'); expect(toneForStatus(null)).toBe('muted')
  })
})

describe('sign-in fragment + CSRF cookie helpers', () => {
  const tok = 'A'.repeat(43)
  test('extractFragmentToken accepts only a 43-char url-safe token', () => {
    expect(extractFragmentToken(`#t=${tok}`)).toBe(tok)
    expect(extractFragmentToken(`t=${tok}`)).toBe(tok)
    expect(extractFragmentToken(`#x=1&t=${tok}`)).toBe(tok)
    for (const bad of [null, undefined, '', '#', '#t=', '#t=short', `#t=${tok}x`, `#t=${'A'.repeat(42)}`, `#t=${tok.slice(1)}!`, `#?t=${tok}`, `#t=<script>${'a'.repeat(30)}`]) {
      expect(extractFragmentToken(bad as any)).toBeNull()
    }
  })
  test('readCookie finds exact names only', () => {
    const c = 'a=1; kvrn_aff_csrf=abc123; kvrn_aff=zzz; other=; x_kvrn_aff_csrf=bad'
    expect(readCookie(c, 'kvrn_aff_csrf')).toBe('abc123')
    expect(readCookie(c, 'kvrn_aff')).toBe('zzz')
    expect(readCookie(c, 'other')).toBeNull()
    expect(readCookie(c, 'missing')).toBeNull()
    expect(readCookie('', 'kvrn_aff')).toBeNull()
  })
  test('portalFetch adds the CSRF header for writes only, sends no referrer, and never throws', async () => {
    const calls: any[] = []
    const g: any = globalThis
    const prev = { fetch: g.fetch, document: g.document }
    g.document = { cookie: 'kvrn_aff_csrf=csrfvalue' }
    g.fetch = async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ hello: 'x' }) } }
    try {
      const get = await portalFetch('/api/affiliate/me')
      expect(get).toMatchObject({ ok: true, status: 200, data: { hello: 'x' }, error: null })
      expect(calls[0].init.headers['x-kvrn-csrf']).toBeUndefined()
      await portalFetch('/api/affiliate/profile', { method: 'patch', body: { a: 1 } })
      expect(calls[1].init.headers['x-kvrn-csrf']).toBe('csrfvalue')
      expect(calls[1].init.credentials).toBe('same-origin'); expect(calls[1].init.referrerPolicy).toBe('no-referrer'); expect(calls[1].init.cache).toBe('no-store')
      expect(calls[1].init.body).toBe('{"a":1}')
      g.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'Nope.' }) })
      expect(await portalFetch('/x', { method: 'POST' })).toMatchObject({ ok: false, status: 403, error: 'Nope.' })
      g.fetch = async () => { throw new Error('offline') }
      expect(await portalFetch('/x')).toMatchObject({ ok: false, status: 0 })
      g.fetch = async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json') } })
      expect((await portalFetch('/x')).error).toBe('Something went wrong.')
    } finally { g.fetch = prev.fetch; if (prev.document === undefined) delete g.document; else g.document = prev.document }
  })
})

describe('access banner + setup checklist', () => {
  const me = (o: any) => ({ readOnly: false, accessReason: 'ok', requiresReacceptance: false, ...o })
  test('banner priority: suspended/terminated > read-only > reacceptance; healthy shows none', () => {
    expect(accessBanner(null)).toBeNull()
    expect(accessBanner(me({}))).toBeNull()
    expect(accessBanner(me({ readOnly: true, accessReason: 'suspended' }))?.text).toMatch(/suspended/)
    expect(accessBanner(me({ readOnly: true, accessReason: 'terminated' }))?.text).toMatch(/ended/)
    expect(accessBanner(me({ readOnly: true, accessReason: 'admin' }))?.text).toMatch(/view-only/)
    expect(accessBanner(me({ requiresReacceptance: true }))?.tone).toBe('warn')
    expect(accessBanner(me({ readOnly: true, accessReason: 'suspended' }))?.tone).toBe('bad')
  })
  test('setup steps reflect each readiness domain separately', () => {
    expect(setupSteps(null)).toEqual([])
    const base = { readiness: { identity: 'not_started', tax: 'pending', payoutMethod: 'ready' }, terms: { requiresReacceptance: false, documents: [{ needsAcceptance: false }] } }
    expect(setupSteps(base).map(s => [s.id, s.done])).toEqual([['terms', true], ['identity', false], ['tax', false], ['payout', true]])
    const re = { ...base, terms: { requiresReacceptance: true, documents: [] } }
    expect(setupSteps(re)[0].done).toBe(false)
    const doc = { ...base, terms: { requiresReacceptance: false, documents: [{ needsAcceptance: true }] } }
    expect(setupSteps(doc)[0].done).toBe(false)
    expect(setupSteps({ ...base, readiness: { identity: 'verified', tax: 'complete', payoutMethod: 'ready' } }).every(s => s.done)).toBe(true)
  })
})

describe('markdown-lite renders data, never markup', () => {
  test('headings, paragraphs, lists, bold, https links', () => {
    const b = parseMarkdownLite('# Title\n\nHello **bold** and [terms](https://kvrn.shop/terms).\n\n- one\n- two\n\n1. first\n2) second')
    expect(b.map(x => x.t)).toEqual(['h', 'p', 'ul', 'ol'])
    expect(b[1]).toMatchObject({ t: 'p', inline: [{ t: 'text', v: 'Hello ' }, { t: 'bold', v: 'bold' }, { t: 'text', v: ' and ' }, { t: 'link', v: 'terms', href: 'https://kvrn.shop/terms' }, { t: 'text', v: '.' }] })
    expect((b[2] as any).items).toHaveLength(2); expect((b[3] as any).items).toHaveLength(2)
  })
  test('non-https and script links stay inert text; raw HTML is just text', () => {
    for (const evil of ['[x](javascript:alert(1))', '[x](http://insecure.example)', '[x](data:text/html;base64,AAAA)', '[x](//evil.example)', '[x]( https://a.b)']) {
      expect(parseInline(evil).some(i => i.t === 'link')).toBe(false)
    }
    const html = parseMarkdownLite('<img src=x onerror=alert(1)><script>alert(1)</script>')
    expect(html).toHaveLength(1)
    expect(JSON.stringify(html)).toContain('<script>')           // kept as literal text; React escapes text nodes
    expect(html.every(b => b.t === 'p')).toBe(true)
    expect(parseInline('[x](https://a.b/"onmouseover="x)').some(i => i.t === 'link' && /"/.test((i as any).href))).toBe(false)
  })
  test('hostile input terminates quickly (no catastrophic backtracking) and handles empties', () => {
    const t0 = Date.now()
    parseMarkdownLite('['.repeat(20000) + '**'.repeat(20000) + '](https://' + 'a'.repeat(20000))
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(parseMarkdownLite('')).toEqual([]); expect(parseMarkdownLite(null as any)).toEqual([])
    expect(parseMarkdownLite('a\r\nb')).toEqual([{ t: 'p', inline: [{ t: 'text', v: 'a b' }] }])
  })
})

// ── source guards ────────────────────────────────────────────────────────────
describe('source guards: affiliate API surface', () => {
  const routes = walk(path.join(ROOT, 'app/api/affiliate')).filter(f => /route\.ts$/.test(f))
  const PUBLIC = new Set(['app/api/affiliate/auth/request/route.ts', 'app/api/affiliate/auth/verify/route.ts'])
  test('routes exist', () => { expect(routes.length).toBeGreaterThanOrEqual(13) })

  test.each(routes.map(f => [rel(f), f]))('%s authenticates before touching data', (name, f) => {
    const src = fs.readFileSync(f as string, 'utf8')
    const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => m[1])
    expect(handlers.length).toBeGreaterThan(0)
    expect(src).toMatch(/export const dynamic = 'force-dynamic'/)
    for (const h of handlers) {
      const body = src.slice(src.indexOf(`export async function ${h}`))
      if (PUBLIC.has(name as string)) {
        // public: flag gate first, then origin check and a DB-backed rate limit inside the auth service
        expect(body.slice(0, 400)).toMatch(/isFeatureEnabled\('AFFILIATE_PORTAL'\)/)
      } else {
        const iAuth = body.indexOf('requireAffiliate(')
        expect(iAuth).toBeGreaterThan(-1)
        // nothing may run before the guard except argument parsing of params
        expect(body.slice(0, iAuth)).not.toMatch(/\bsql`|\bsql\(|await req\.json\(|createAffiliate\w+Service/)
      }
    }
  })

  test('the two public routes check origin and use the auth service rate limit; request is non-enumerating', () => {
    const req = read('app/api/affiliate/auth/request/route.ts'); const ver = read('app/api/affiliate/auth/verify/route.ts')
    expect(req).toMatch(/origin/i); expect(ver).toMatch(/origin/i)
    expect(req).toMatch(/requestLogin\(/); expect(ver).toMatch(/redeemLoginToken\(/)
    expect(read('lib/affiliate-auth.ts')).toMatch(/affiliate_auth_rate_allow/)
    expect(req).not.toMatch(/unknown email|no such (user|affiliate)|not registered/i)
  })

  test('affiliate responses go through the privacy scan; no route reads customer tables directly', () => {
    for (const f of routes) {
      const src = fs.readFileSync(f, 'utf8')
      expect(src).not.toMatch(/FROM\s+orders\b|customer_email|customer_name|customer_phone|shipping_address|stripe_payment_intent|stripe_checkout_session/i)
    }
    expect(read('lib/affiliate-portal-http.ts')).toMatch(/assertPortalPayloadSafe/)
  })

  test('cookies: HttpOnly session, SameSite=Lax, Secure in production, both paths', () => {
    const a = read('lib/affiliate-auth.ts')
    expect(a).toMatch(/AFFILIATE_COOKIE_PATHS = \['\/affiliate', '\/api\/affiliate'\]/)
    expect(a).toMatch(/'SameSite=Lax'/); expect(a).toMatch(/\['HttpOnly', age\]/)
    expect(a).toMatch(/isSecureEnv[\s\S]{0,80}NODE_ENV === 'production'/)
    // the CSRF cookie is the only script-readable one
    expect(a.match(/AFFILIATE_CSRF_COOKIE,\s+p\.csrfToken,\s+path, o, \[age\]/)).not.toBeNull()
  })
})

describe('source guards: pages and components', () => {
  const files = [...walk(path.join(ROOT, 'app/affiliate')), path.join(ROOT, 'app/admin/financials/affiliates/AffiliatePayoutReadinessTab.tsx'), path.join(ROOT, 'app/admin/financials/affiliates/AffiliateComplianceTab.tsx')]
  test.each(files.map(f => [rel(f), f]))('%s has no raw-HTML or storage sinks', (_n, f) => {
    const src = fs.readFileSync(f as string, 'utf8')
    expect(src).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write|eval\(|new Function\(/)
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB/)
    expect(src).not.toMatch(/console\.(log|debug|info)\(/)
    // external links must be inert
    for (const m of src.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) expect(m[0]).toMatch(/rel="[^"]*noopener[^"]*"/)
  })

  test('layout: 404 when the flag is off, noindex, no referrer', () => {
    const l = read('app/affiliate/layout.tsx')
    expect(l).toMatch(/isFeatureEnabled\('AFFILIATE_PORTAL'\)[\s\S]{0,40}notFound\(\)/)
    expect(l).toMatch(/index: false/); expect(l).toMatch(/referrer: 'no-referrer'/)
  })

  test('verify page: strips the fragment before any request, posts only after a click, token never goes in a URL or log', () => {
    const v = read('app/affiliate/login/verify/VerifyClient.tsx')
    expect(v.indexOf('extractFragmentToken(')).toBeGreaterThan(-1)
    expect(v.indexOf('history.replaceState')).toBeGreaterThan(v.indexOf('extractFragmentToken('))
    expect(v).toMatch(/\/api\/affiliate\/auth\/verify/)
    expect(v).not.toMatch(/\/api\/affiliate\/auth\/verify\?|\?t=|searchParams|router\.(push|replace)\([^)]*token/)
    expect(v).not.toMatch(/console\./)
    // verification happens in a click handler, not on mount
    expect(v).toMatch(/onClick=\{/)
  })

  test('admin tabs export no-prop named components (the contract affcore stubs)', () => {
    expect(read('app/admin/financials/affiliates/AffiliatePayoutReadinessTab.tsx')).toMatch(/export function AffiliatePayoutReadinessTab\(\)/)
    expect(read('app/admin/financials/affiliates/AffiliateComplianceTab.tsx')).toMatch(/export function AffiliateComplianceTab\(\)/)
  })
})

describe('source guards: admin + cron routes owned by this workstream', () => {
  const mine = [
    'app/api/admin/affiliates/compliance/route.ts', 'app/api/admin/affiliates/ugc/route.ts',
    'app/api/admin/affiliates/payout-readiness/route.ts', 'app/api/admin/affiliates/payout-readiness/statement/route.ts',
  ]
  test.each(mine)('%s calls requireAdmin first in every handler', rel => {
    const src = read(rel)
    for (const h of [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => m[1])) {
      const body = src.slice(src.indexOf(`export async function ${h}`))
      const iAdmin = body.indexOf('requireAdmin(')
      expect(iAdmin).toBeGreaterThan(-1)
      expect(body.slice(0, iAdmin)).not.toMatch(/sql`|sql\(|req\.json|createAffiliate\w+Service/)
    }
    expect(src).not.toMatch(/console\.(log|debug)\(/)
  })
  test('every Admin mutation helper writes admin_audit_logs in the same statement/function', () => {
    const c = read('lib/affiliate-compliance.ts') + read('lib/affiliate-compliance-ugc.ts')
    for (const fn of ['addItem', 'setItemStatus', 'issueWarning', 'resolveWarning', 'openFlag', 'updateFlag', 'recordReview', 'grant', 'revoke']) {
      const start = c.indexOf(`async ${fn}(`); expect(start).toBeGreaterThan(-1)
      const next = c.indexOf('\n    async ', start + 10)
      expect(c.slice(start, next === -1 ? undefined : next)).toMatch(/admin_audit_logs/)
    }
    const m = read('db/migrations/034_affiliate_portal_compliance_payouts.sql')
    for (const fn of ['set_affiliate_readiness', 'set_affiliate_payout_account', 'set_affiliate_portal_access', 'set_affiliate_paid_ads_policy',
      'suspend_affiliate_for_compliance', 'revoke_affiliate_sessions', 'affiliate_record_payout_attempt', 'affiliate_complete_payout_attempt']) {
      const start = m.indexOf(`FUNCTION ${fn}(`); expect(start).toBeGreaterThan(-1)
      const end = m.indexOf('\n$$;', start)
      expect(m.slice(start, end)).toMatch(/admin_audit_logs/)
    }
  })
  test('cron route: CRON_SECRET guard first, counts only', () => {
    const r = read('app/api/internal/affiliate-maintenance/route.ts')
    expect(r.indexOf('requireCronSecret(')).toBeLessThan(r.indexOf('runAffiliateMaintenance('))
    expect(r.indexOf('requireCronSecret(')).toBeGreaterThan(-1)
  })
  test('the cron wrapper already schedules this endpoint (untouched file)', () => {
    expect(read('cloudflare-cron-wrapper.js')).toMatch(/ADDITIVE_CRON_JOBS = \[[^\]]*'affiliate-maintenance'/)
  })
})

describe('source guards: migration 034 + frozen history', () => {
  const m = read('db/migrations/034_affiliate_portal_compliance_payouts.sql')
  test('is the only migration this workstream adds and is idempotent / guarded', () => {
    expect(fs.existsSync(path.join(ROOT, 'db/migrations/034_affiliate_portal_compliance_payouts.sql'))).toBe(true)
    expect(m).toMatch(/^BEGIN;/m); expect(m).toMatch(/COMMIT;\s*$/)
    expect(m).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|TRIGGER)\b|\bTRUNCATE\b|\bALTER\s+TABLE\s+(affiliate_commissions|affiliate_payouts|affiliate_commission_adjustments|orders)\b/i)
    // only fixed-in-place functions of OUR OWN are replaced; none of the frozen 020-026 functions are redefined
    for (const frozen of ['create_affiliate_payout', 'mark_affiliate_payout_paid', 'void_affiliate_payout', 'promote_eligible_commissions_for_affiliate', 'resolve_order_affiliate_attribution', 'set_affiliate_status', 'update_affiliate_terms', 'affiliate_commission_payable']) {
      expect(m).not.toMatch(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+${frozen}\\s*\\(`, 'i'))
    }
  })
  test('no raw bank / tax / identity columns anywhere in the migration', () => {
    const cols = [...m.matchAll(/^\s{2}([a-z_]+)\s+(?:TEXT|UUID|INTEGER|BIGINT|BOOLEAN|JSONB|TIMESTAMPTZ|DATE|VARCHAR)\b/gm)].map(x => x[1])
    expect(cols.length).toBeGreaterThan(40)
    for (const c of cols) expect(c).not.toMatch(/ssn|tin\b|tax_id|ein\b|routing|account_number|iban|swift|passport|license_number|dob|birth|card_number|cvv|id_document|bank_account/i)
  })
  test('frozen migrations 001-027 are untouched in this branch', () => {
    const { execSync } = require('child_process')
    const base = (() => { try { return execSync('git merge-base HEAD master || git merge-base HEAD main', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return '' } })()
    if (!base) return                                           // no `main` ref in this checkout: nothing to compare
    const changed = execSync(`git diff --name-only ${base} HEAD -- db/migrations`, { cwd: ROOT }).toString().split('\n').filter(Boolean)
    expect(changed.filter((f: string) => /\/0(0\d|1\d|2[0-7])_/.test(f))).toEqual([])
  })
})
