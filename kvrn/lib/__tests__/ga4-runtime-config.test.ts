// lib/__tests__/ga4-runtime-config.test.ts
//
// Audit Revision 1 / correction 1: the GA measurement id is RUNTIME configuration.
//   * GET /api/analytics/config reads the Worker environment per request and exposes ONLY the
//     validated public id — never the Measurement Protocol secret, secret status, or any other env value.
//   * Regression protection for the deployment model: KVRN builds locally while the id is a Cloudflare
//     runtime variable, so NO source file may contain a `process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID`
//     expression (Next.js would inline it at build time).

import fs from 'fs'
import path from 'path'
import { describeGaConfig } from '../ga4-server'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) { if (!/node_modules|\.next|backup-before|__tests__/.test(rel)) walk(rel, out) }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel)
  }
  return out
}
const SRC = ['app', 'components', 'context', 'lib'].flatMap(d => walk(d))

const ID = 'G-RUNTIME123'
const SECRET = 'sEcReT_abcdef123456'
const KEYS = ['NEXT_PUBLIC_GA_MEASUREMENT_ID', 'GA4_MEASUREMENT_PROTOCOL_SECRET', 'DATABASE_URL', 'CLOUDFLARE_API_TOKEN'] as const
let saved: Record<string, string | undefined>
beforeEach(() => { saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] } })
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

describe('GET /api/analytics/config', () => {
  let route: typeof import('../../app/api/analytics/config/route')
  beforeAll(async () => { route = await import('../../app/api/analytics/config/route') })
  const call = async () => { const r = await route.GET(); return { r, text: await r.text() } }

  test('returns exactly { measurementId } from the RUNTIME environment, uncacheable', async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = ID
    const { r, text } = await call()
    expect(r.status).toBe(200)
    expect(JSON.parse(text)).toEqual({ measurementId: ID })
    expect(Object.keys(JSON.parse(text))).toEqual(['measurementId'])
    expect(r.headers.get('cache-control')).toMatch(/no-store/)
    expect(r.headers.get('content-type')).toMatch(/application\/json/)
  })

  test('it can NEVER reveal GA4_MEASUREMENT_PROTOCOL_SECRET (nor any other env value), whatever the environment holds', async () => {
    Object.assign(process.env, { NEXT_PUBLIC_GA_MEASUREMENT_ID: ID, GA4_MEASUREMENT_PROTOCOL_SECRET: SECRET,
      DATABASE_URL: 'postgres://user:pw@host/db', CLOUDFLARE_API_TOKEN: 'cf_secret_token' })
    const { r, text } = await call()
    const everything = text + JSON.stringify([...r.headers.entries()])
    for (const bad of [SECRET, 'sEcReT', 'postgres://', 'cf_secret_token', 'GA4_MEASUREMENT_PROTOCOL_SECRET', 'secretState', 'DATABASE_URL']) {
      expect(everything).not.toContain(bad)
    }
    expect(JSON.parse(text)).toEqual({ measurementId: ID })
  })

  test('it does not even hint whether a secret is configured: same response with or without it', async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = ID
    const without = (await call()).text
    process.env.GA4_MEASUREMENT_PROTOCOL_SECRET = SECRET
    const withSecret = (await call()).text
    expect(withSecret).toBe(without)
  })

  test('a secret mistakenly placed in the id variable is refused (null), never echoed', async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = SECRET
    const { text } = await call()
    expect(JSON.parse(text)).toEqual({ measurementId: null })
    expect(text).not.toContain(SECRET)
  })

  test.each([[undefined], [''], ['   '], ['UA-12345-1'], ['G-RUNTIME123&x=1'], ['G-<script>'], ['g-lowercase']])(
    'missing/malformed id %j => { measurementId: null } (GA stays off)', async v => {
      if (v !== undefined) process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = v
      expect(JSON.parse((await call()).text)).toEqual({ measurementId: null })
    })

  test('REGRESSION (deployment model): the value is read per REQUEST, not frozen at import/build time', async () => {
    // Import happened in beforeAll with the variable ABSENT (simulated build shell without it).
    expect(JSON.parse((await call()).text)).toEqual({ measurementId: null })
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = ID                    // the runtime Worker variable appears
    expect(JSON.parse((await call()).text)).toEqual({ measurementId: ID })
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = 'G-CHANGED9999'       // and can change without a rebuild
    expect(JSON.parse((await call()).text)).toEqual({ measurementId: 'G-CHANGED9999' })
  })

  test('the admin status and the browser config can never disagree (same variable, same reader)', async () => {
    for (const v of [undefined, '', 'bad', ID, ' ' + ID + ' ']) {
      if (v === undefined) delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID; else process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = v
      process.env.GA4_MEASUREMENT_PROTOCOL_SECRET = SECRET
      expect(describeGaConfig().measurementId).toBe(JSON.parse((await call()).text).measurementId)
    }
  })
})

describe('source regression: the id is runtime-only (never inlined at build time)', () => {
  const ID_VAR = 'NEXT_PUBLIC_GA_MEASUREMENT_ID'

  test('no source file contains a process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID expression (dot or bracket form)', () => {
    const offenders = SRC.filter(f => {
      const t = strip(read(f))
      return /process\.env\s*\.\s*NEXT_PUBLIC_GA_MEASUREMENT_ID/.test(t) || /process\.env\s*\[\s*['"`]NEXT_PUBLIC_GA_MEASUREMENT_ID['"`]\s*\]/.test(t)
    })
    expect(offenders).toEqual([])
  })

  test('the variable is named only in the two server-side readers that take the environment as a PARAMETER (and never in client code)', () => {
    const hits = SRC.filter(f => strip(read(f)).includes(ID_VAR)).sort()
    expect(hits).toEqual(['lib/ga-common.ts', 'lib/ga4-server.ts'])
    for (const f of hits) expect(strip(read(f))).toMatch(/env\.NEXT_PUBLIC_GA_MEASUREMENT_ID/)         // parameter access, not process.env
    for (const f of ['app/layout.tsx', 'components/analytics/GaTracker.tsx', 'lib/ga-client.ts', 'context/CookiePrefsContext.tsx', 'lib/funnel-client.ts']) {
      expect(strip(read(f))).not.toContain(ID_VAR)
    }
  })

  test('the layout passes no id to the tracker and imports no measurement-id helper', () => {
    const l = strip(read('app/layout.tsx'))
    expect(l).toMatch(/<GaTracker \/>/)
    expect(l).not.toMatch(/measurementId|normalizeMeasurementId|readPublicGaMeasurementId/)
    expect(strip(read('components/analytics/GaTracker.tsx'))).toMatch(/export function GaTracker\(\)/)
  })

  test('the config route is dynamic + no-store, passes the runtime env as a parameter, and imports only the public reader', () => {
    const raw = read('app/api/analytics/config/route.ts')
    const r = strip(raw)
    expect(r).toMatch(/export const dynamic = 'force-dynamic'/)
    expect(r).toMatch(/Cache-Control['"]?:\s*'no-store/)
    expect(r).toMatch(/readPublicGaMeasurementId\(process\.env\)/)
    expect(r).not.toMatch(/GA4_MEASUREMENT_PROTOCOL_SECRET|API_SECRET|ga4-server|resolveGaConfig|describeGaConfig/)
    expect([...r.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]).sort()).toEqual(['@/lib/ga-common', 'next/server'])
    // It returns a single-key object literal only.
    expect(r).toMatch(/NextResponse\.json\(\s*\{ measurementId \}/)
  })

  test('the browser asks for the config only through ensureGaRuntimeId, which checks effective consent BEFORE any fetch', () => {
    const c = strip(read('lib/ga-client.ts'))
    expect(c.match(/GA_CONFIG_ENDPOINT/g)!.length).toBeGreaterThanOrEqual(2)       // declared + used
    const fn = c.slice(c.indexOf('export async function ensureGaRuntimeId'), c.indexOf('export async function syncGa'))
    expect(fn.indexOf('analyticsConsentGranted()')).toBeGreaterThan(-1)
    expect(fn.indexOf('analyticsConsentGranted()')).toBeLessThan(fn.indexOf('doFetch('))
    expect(c.match(/doFetch\(GA_CONFIG_ENDPOINT/g)).toHaveLength(1)                 // the only config request in the codebase
    expect(SRC.filter(f => strip(read(f)).includes('/api/analytics/config')).sort()).toEqual(['lib/ga-client.ts'])
  })

  // .env.example is not part of the CP08 source snapshot (the checkpoint tooling never archives .env*), so these
  // assertions run only where the owner's real file exists.
  const envTest = fs.existsSync(path.join(ROOT, '.env.example')) ? test : test.skip
  test('documentation states the runtime-variable requirement explicitly', () => {
    const doc = read('GA4-INTEGRATION.md')
    expect(doc).toMatch(/RUNTIME/)
    expect(doc).toMatch(/NOT needed .* at build time|not needed .* at build time/i)
    expect(doc).toMatch(/\/api\/analytics\/config/)
    expect(doc).toMatch(/Cloudflare dashboard/)
    expect(doc).not.toMatch(/G-[A-Z0-9]{8,12}(?![A-Z0-9])(?<!G-XXXXXXXXXX)/)
  })
  envTest('.env.example states the runtime-variable requirement explicitly', () => {
    const doc = ''
    const env = read('.env.example')
    expect(env).toMatch(/RUNTIME Worker variable/)
    expect(env).toMatch(/NOT needed at build time/)
    expect(env).toMatch(/^NEXT_PUBLIC_GA_MEASUREMENT_ID=$/m)                          // the real id is never committed
    expect(doc + env).not.toMatch(/G-[A-Z0-9]{8,12}(?![A-Z0-9])(?<!G-XXXXXXXXXX)/)    // no real-looking id hard-coded in docs
  })

  test('the real id is never hard-coded anywhere in source', () => {
    for (const f of SRC) expect(strip(read(f))).not.toMatch(/['"`]G-[A-Z0-9]{8,12}['"`]/)
  })

  test('Clarity is disabled (it cannot load outside the consent gate) and the doc says so', () => {
    const doc = read('GA4-INTEGRATION.md')
    expect(doc).toMatch(/Microsoft Clarity/)
    expect(doc).toMatch(/\*\*disabled\*\*/)
    const layout = strip(read('app/layout.tsx'))
    expect(layout).not.toMatch(/clarity\.ms|NEXT_PUBLIC_CLARITY_PROJECT_ID|<Script[\s>]|next\/script/)   // no unconsented third-party script in the root layout
  })
})
