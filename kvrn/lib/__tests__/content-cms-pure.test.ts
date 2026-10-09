// Pure (no DB) content CMS tests: nav/footer required-link guards, unsafe URLs, announcement
// window/timezone logic, translation completeness per entity, variant states, shell label
// resolution, site metadata equivalence, size guide conversion, and source guards.
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import {
  validateNavigation, validateFooter, validateAnnouncement, validateSizeGuide, validatePolicy, validatePage, validateContact,
  isAnnouncementActive, parseUtcInstant, translatableFields, localizeSnapshot, KINDS, missingRequiredPaths,
  REQUIRED_NAV_PATHS, REQUIRED_FOOTER_PATHS, validateGlobalSeo, policyPath, type ContentKind,
} from '../content-schemas'
import { DEFAULT_NAVIGATION, DEFAULT_FOOTER, DEFAULT_ANNOUNCEMENT, DEFAULT_ABOUT, DEFAULT_CONTACT, DEFAULT_GLOBAL_SEO, DEFAULT_SIZE_GUIDE_PAGE } from '../content-defaults'
import { SEED_FAQ, SEED_TERMS, SEED_SIZE_GUIDE_HOODIE, SEED_POLICIES } from '../content-seed-data'
import { buildVariants, pickVariant } from '../content-localize'
import { sourceHash, summarizeCompleteness } from '../translations'
import { resolveLinkLabel, resolveGroupHeading, resolveText, copyrightLine, activeAnnouncementMessages, type ShellData } from '../content-shell'
import { siteMetadata, orgSchema, jsonLd, mergeGlobalSeo, pageMetadata } from '../content-seo'
import { parseEnabledLocales } from '../content-locales'
import { convertCell } from '../content-size-guide'
import { para } from '../content-richtext'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex')
const fromChar = (...codes: number[]) => String.fromCharCode(...codes)

describe('navigation: required links and safe URLs', () => {
  const nav = JSON.parse(JSON.stringify(DEFAULT_NAVIGATION))
  const without = (list: 'desktop' | 'mobile', path: string) => ({ ...nav, [list]: nav[list].filter((l: any) => l.href !== path) })
  test('the coded navigation is valid', () => { expect(validateNavigation(nav).ok).toBe(true) })
  test.each(REQUIRED_NAV_PATHS.flatMap(p => (['desktop', 'mobile'] as const).map(l => [l, p] as const)))('removing %s %s is refused', (l, p) => {
    const r = validateNavigation(without(l, p))
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain(p)
  })
  test('a filtered shop link does not stand in for the shop link', () => {
    expect(missingRequiredPaths([{ href: '/shop?type=hoodies' }], ['/shop'])).toEqual(['/shop'])
    expect(missingRequiredPaths([{ href: '/shop' }, { href: '/Contact/' }], REQUIRED_NAV_PATHS)).toEqual([])
  })
  test.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', '//evil.example', 'http://insecure.example', 'mailto:a@b.co',
    '/a b', '/x\\y', '/../etc', 'vbscript:x',
  ])('unsafe nav URL %j is refused', (href) => {
    const r = validateNavigation({ ...nav, desktop: [...nav.desktop, { id: 'x1', label: 'X', href }] })
    expect(r.ok).toBe(false)
  })
  test('https externals and internal paths are accepted; duplicate ids and empty labels are not', () => {
    expect(validateNavigation({ ...nav, desktop: [...nav.desktop, { id: 'ok1', label: 'Partner', href: 'https://example.com/a', newTab: true }] }).ok).toBe(true)
    expect(validateNavigation({ ...nav, desktop: [...nav.desktop, { id: nav.desktop[0].id, label: 'Dup', href: '/x' }] }).ok).toBe(false)
    expect(validateNavigation({ ...nav, desktop: [...nav.desktop, { id: 'e1', label: '  ', href: '/x' }] }).ok).toBe(false)
  })
})

describe('footer: required legal/support/store links', () => {
  const f = JSON.parse(JSON.stringify(DEFAULT_FOOTER))
  const stripPath = (p: string) => ({ ...f, groups: f.groups.map((g: any) => ({ ...g, links: g.links.filter((l: any) => l.href !== p) })) })
  test('the coded footer is valid', () => { expect(validateFooter(f).ok).toBe(true) })
  test.each([...REQUIRED_FOOTER_PATHS])('removing %s is refused', (p) => {
    const r = validateFooter(stripPath(p))
    expect(r.ok).toBe(false); expect(JSON.stringify(r)).toContain(p)
  })
  test('social links must be https; labels, holder required; mailto allowed in footer links', () => {
    expect(validateFooter({ ...f, social: [{ id: 's', platform: 'instagram', label: 'IG', href: 'http://x.co' }] }).ok).toBe(false)
    expect(validateFooter({ ...f, social: [{ id: 's', platform: 'instagram', label: 'IG', href: 'javascript:1' }] }).ok).toBe(false)
    expect(validateFooter({ ...f, copyrightHolder: '' }).ok).toBe(false)
    expect(validateFooter({ ...f, groups: f.groups.map((g: any, i: number) => i === 0 ? { ...g, links: [...g.links, { id: 'm1', label: 'Mail', href: 'mailto:support@kvrn.shop' }] } : g) }).ok).toBe(true)
  })
})

describe('announcement window (UTC, timezone-safe)', () => {
  const base = { enabled: true, messages: [{ id: 'a', text: 'Hi' }], startsAt: null as string | null, endsAt: null as string | null }
  const at = (s: string) => new Date(s)
  test('disabled or message-less is never shown', () => {
    expect(isAnnouncementActive({ ...base, enabled: false }, at('2026-01-01T00:00:00Z'))).toBe(false)
    expect(isAnnouncementActive({ ...base, messages: [] }, at('2026-01-01T00:00:00Z'))).toBe(false)
  })
  test('start inclusive, end exclusive', () => {
    const a = { ...base, startsAt: '2026-03-01T10:00:00.000Z', endsAt: '2026-03-02T10:00:00.000Z' }
    expect(isAnnouncementActive(a, at('2026-03-01T09:59:59.999Z'))).toBe(false)
    expect(isAnnouncementActive(a, at('2026-03-01T10:00:00.000Z'))).toBe(true)
    expect(isAnnouncementActive(a, at('2026-03-02T09:59:59.999Z'))).toBe(true)
    expect(isAnnouncementActive(a, at('2026-03-02T10:00:00.000Z'))).toBe(false)
  })
  test('offsets are normalised to the same UTC instant; zone-less times are refused', () => {
    expect(parseUtcInstant('2026-03-01T15:00:00+05:00')).toBe('2026-03-01T10:00:00.000Z')
    expect(parseUtcInstant('2026-03-01T05:00:00-05:00')).toBe('2026-03-01T10:00:00.000Z')
    expect(parseUtcInstant('2026-03-01T10:00:00Z')).toBe('2026-03-01T10:00:00.000Z')
    expect(parseUtcInstant('2026-03-01T10:00')).toBeUndefined()
    expect(parseUtcInstant('2026-03-01')).toBeUndefined()
    expect(parseUtcInstant('2026-13-45T10:00:00Z')).toBeUndefined()
    expect(parseUtcInstant('')).toBeNull()
  })
  test('validator: end after start, enabled needs a message, max 5, safe link only', () => {
    const v = (o: any) => validateAnnouncement({ ...base, ...o })
    expect(v({ startsAt: '2026-03-02T00:00:00Z', endsAt: '2026-03-01T00:00:00Z' }).ok).toBe(false)
    expect(v({ messages: [] }).ok).toBe(false)
    expect(v({ enabled: false, messages: [] }).ok).toBe(true)
    expect(v({ messages: Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, text: 'x' })) }).ok).toBe(false)
    expect(v({ messages: [{ id: 'a', text: 'x', href: 'javascript:alert(1)' }] }).ok).toBe(false)
    expect(v({ messages: [{ id: 'a', text: 'x', href: '/shop' }] }).ok).toBe(true)
    expect(v({ startsAt: '2026-03-01T10:00' }).ok).toBe(false)
    expect(validateAnnouncement(DEFAULT_ANNOUNCEMENT).ok).toBe(true)
  })
  test('shell helper: rotating messages only while active, localized when a translation is published', () => {
    const a = { ...DEFAULT_ANNOUNCEMENT, id: 'main', startsAt: '2026-03-01T00:00:00.000Z', endsAt: '2026-04-01T00:00:00.000Z' }
    expect(activeAnnouncementMessages(a, 'en', {}, new Date('2026-02-01T00:00:00Z'))).toEqual([])
    const live = activeAnnouncementMessages(a, 'es', { es: { 'msg.m2.text': 'Novedades' } }, new Date('2026-03-15T00:00:00Z'))
    expect(live.map(m => m.text)).toEqual([DEFAULT_ANNOUNCEMENT.messages[0].text, 'Novedades', DEFAULT_ANNOUNCEMENT.messages[2].text])
    expect(activeAnnouncementMessages(null, 'en', {}, new Date())).toEqual([])
  })
})

describe('translations: completeness per entity', () => {
  const SAMPLES: Array<[ContentKind, any, string[]]> = [
    ['policies', SEED_TERMS, ['title', 'heroTitle', 'body']],
    ['faq', SEED_FAQ, ['heroTitle', 'cat.products', 'q.gsm', 'a.gsm', 'footerTitle']],
    ['size-guides', SEED_SIZE_GUIDE_HOODIE, ['name', 'col.length', 'note.0', 'shopLink']],
    ['about', DEFAULT_ABOUT, ['heroTitle', 'lead', 'para.0', 'ctaLabel']],
    ['contact', DEFAULT_CONTACT, ['heroTitle', 'successTitle', 'successBody']],
    ['announcement', DEFAULT_ANNOUNCEMENT, ['msg.m1']],
    ['navigation', DEFAULT_NAVIGATION, ['link.d-shop-all', 'link.m-faq']],
    ['footer', DEFAULT_FOOTER, ['tag.0', 'group.shop', 'link.f-terms']],
    ['support-pages', DEFAULT_SIZE_GUIDE_PAGE, ['heroTitle', 'intro', 'tip', 'link.hoodies']],
  ]
  test.each(SAMPLES)('%s exposes its translatable fields', (kind, snap, expected) => {
    const f = translatableFields(kind, snap)
    for (const k of expected) expect(Object.keys(f)).toContain(k)
    expect(Object.values(f).every(v => v.trim() !== '')).toBe(true)
  })
  test('rich text is carried as JSON and can be localized back in', () => {
    const f = translatableFields('policies', SEED_TERMS)
    expect(f.body.startsWith('{"v":1')).toBe(true)
    const translated = { v: 1, blocks: [para('Hola')] }
    const out = localizeSnapshot('policies', SEED_TERMS, { title: 'Términos', body: JSON.stringify(translated) })
    expect(out.title).toBe('Términos'); expect(out.body).toEqual(translated)
    expect(SEED_TERMS.title).toBe('Terms of Service')                    // the source is never mutated
  })
  test('localizeSnapshot ignores values for fields that do not exist', () => {
    expect(localizeSnapshot('contact', DEFAULT_CONTACT, { bogus: 'x' })).toEqual(DEFAULT_CONTACT)
  })
  test('summarizeCompleteness: translated / stale / missing', () => {
    const src = { title: 'Terms', heroTitle: 'Hero', lead: 'Lead' }
    const rows = { es: [
      { field: 'title', value: 'Términos', status: 'published' as const, source_hash: sourceHash('Terms') },
      { field: 'heroTitle', value: 'Héroe', status: 'published' as const, source_hash: sourceHash('OLD hero') },
    ] }
    const [es, fr] = summarizeCompleteness(src, rows as any, ['en', 'es', 'fr'])
    expect(es).toMatchObject({ locale: 'es', total: 3, translated: 1, stale: 1, missing: 1, complete: false })
    expect(fr).toMatchObject({ translated: 0, missing: 3, complete: false })
  })
})

describe('variants never present a fallback as a translation', () => {
  const src = { title: 'Care', subtitle: 'Wash cold', slug: 'care', body: { v: 1 as const, blocks: [para('Body')] }, navEligible: false, seo: {} }
  const row = (locale: string, field: string, value: string, status: any = 'published', hash = sourceHash((translatableFields('pages', src) as any)[field])) =>
    ({ locale, field, value, status, source_hash: hash })
  test('only PUBLISHED rows of ENABLED locales produce a variant', () => {
    const v = buildVariants('pages', src, [row('es', 'title', 'Cuidado', 'draft'), row('fr', 'title', 'Soin', 'needs_review'), row('de', 'title', 'Pflege', 'published')], ['en', 'es', 'fr'])
    expect(Object.keys(v)).toEqual(['en'])
    expect(pickVariant(v, 'de').locale).toBe('en')
  })
  test('state: partial when some fields fall back, translated when all, stale when the source changed', () => {
    const fields = Object.keys(translatableFields('pages', src))
    const part = buildVariants('pages', src, [row('es', 'title', 'Cuidado')], ['en', 'es'])
    expect(part.es.state).toBe('partial'); expect(part.es.data.title).toBe('Cuidado'); expect(part.es.data.subtitle).toBe('Wash cold')
    const all = buildVariants('pages', src, fields.map(f => row('es', f, f === 'body' ? JSON.stringify({ v: 1, blocks: [para('Cuerpo')] }) : `ES ${f}`)), ['en', 'es'])
    expect(all.es.state).toBe('translated')
    const stale = buildVariants('pages', src, fields.map(f => row('es', f, f === 'body' ? JSON.stringify({ v: 1, blocks: [para('Cuerpo')] }) : `ES ${f}`, 'published', sourceHash('older source'))), ['en', 'es'])
    expect(stale.es.state).toBe('stale')
  })
  test('English is always present and untouched', () => {
    const v = buildVariants('pages', src, [row('es', 'title', 'Cuidado')], ['en', 'es'])
    expect(v.en.data).toBe(src); expect(v.en.state).toBe('translated')
  })
})

describe('shell label resolution', () => {
  const link = { id: 'd-about', label: 'About', href: '/about', i18nKey: 'about' as const, i18nEn: 'About' }
  const dict = { about: 'Acerca de' }
  test('English is always the stored label', () => { expect(resolveLinkLabel(link, 'en', { es: { 'link.d-about.label': 'X' } }, dict)).toBe('About') })
  test('published Admin translation > dictionary > English', () => {
    expect(resolveLinkLabel(link, 'es', { es: { 'link.d-about.label': 'Sobre KVRN' } }, dict)).toBe('Sobre KVRN')
    expect(resolveLinkLabel(link, 'es', {}, dict)).toBe('Acerca de')
    expect(resolveLinkLabel(link, 'es', {}, undefined)).toBe('About')
  })
  test('an edited English label stops using the old dictionary translation (never mistranslates)', () => {
    expect(resolveLinkLabel({ ...link, label: 'Our story' }, 'es', {}, dict)).toBe('Our story')
  })
  test('group headings, plain text fields and the copyright line', () => {
    const g = { id: 'shop', heading: 'Shop', i18nKey: 'shop' as const, i18nEn: 'Shop' }
    expect(resolveGroupHeading(g, 'fr', {}, { shop: 'Boutique' })).toBe('Boutique')
    expect(resolveText('copyrightSuffix', 'All rights reserved.', 'de', { de: { copyrightSuffix: 'Alle Rechte vorbehalten.' } })).toBe('Alle Rechte vorbehalten.')
    expect(copyrightLine({ copyrightHolder: 'KVRN', copyrightSuffix: '' }, 2026, 'en', {}, { allRightsReserved: 'Todos los derechos reservados.' })).toBe('© 2026 KVRN. Todos los derechos reservados.')
    expect(copyrightLine({ copyrightHolder: 'KVRN', copyrightSuffix: 'Mine.' }, 2026, 'en', {}, undefined)).toBe('© 2026 KVRN. Mine.')
  })
})

describe('site metadata and organization schema', () => {
  // The object app/layout.tsx used to hardcode (commit 4c48f29), verbatim.
  const OLD = {
    title: { default: 'KVRN — Heavyweight Oversized Hoodies & Sweatpants', template: '%s | KVRN' },
    description: 'KVRN heavyweight fleece. 400 GSM+ oversized hoodies and sweatpants. Double-layered hood. Concealed interior zippers. No drawstrings. Quiet luxury.',
    keywords: ['heavyweight hoodie', '400 gsm hoodie', '500 gsm hoodie', 'oversized hoodie', 'quiet luxury', 'premium sweatpants', 'french terry hoodie', 'cropped hoodie', 'luxury streetwear', 'KVRN'],
    authors: [{ name: 'KVRN' }], creator: 'KVRN',
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kvrn.shop'),
    openGraph: { type: 'website', locale: 'en_US', url: 'https://kvrn.shop', siteName: 'KVRN',
      title: 'KVRN — Heavyweight Oversized Hoodies & Sweatpants', description: 'Double-layered hood. Concealed zipper pockets. No drawstrings. 400–500 GSM fleece.' },
    twitter: { card: 'summary_large_image', title: 'KVRN — Heavyweight Oversized Fleece', description: '400–500 GSM. Quiet luxury.' },
    robots: { index: true, follow: true, googleBot: { index: true, follow: true } },
    icons: { icon: '/favicon.ico', apple: '/apple-touch-icon.png' },
    manifest: '/site.webmanifest',
  }
  const OLD_ORG = {
    '@context': 'https://schema.org', '@type': 'ClothingStore', name: 'KVRN', url: 'https://kvrn.shop',
    description: 'Premium heavyweight fleece. Oversized hoodies and sweatpants built for daily wear.', email: 'support@kvrn.shop',
    sameAs: ['https://instagram.com/thekvrn', 'https://tiktok.com/@thekvrn'],
    contactPoint: { '@type': 'ContactPoint', contactType: 'customer support', email: 'support@kvrn.shop', availableLanguage: 'English' },
  }
  test('with the defaults the metadata equals the previous hardcoded object', () => { expect(siteMetadata(DEFAULT_GLOBAL_SEO)).toEqual(OLD) })
  test('with the defaults the organization JSON-LD equals the previous object', () => { expect(orgSchema(DEFAULT_GLOBAL_SEO)).toEqual(OLD_ORG) })
  test('the JSON-LD string is identical to the previous one', () => { expect(jsonLd(orgSchema(DEFAULT_GLOBAL_SEO))).toBe(JSON.stringify(OLD_ORG)) })
  test('jsonLd cannot be broken out of its script tag', () => {
    const s = jsonLd({ d: '</script><script>alert(1)</script>' })
    expect(s).not.toContain('<'); expect(JSON.parse(s).d).toContain('</script>')
  })
  test('stored settings override defaults field by field; garbage falls back', () => {
    const g = mergeGlobalSeo({ description: 'Mine', titleTemplate: 'no placeholder', keywords: 'x', organization: { sameAs: ['http://x'], type: 'Bad' } })
    expect(g.description).toBe('Mine'); expect(g.titleTemplate).toBe('%s | KVRN'); expect(g.keywords).toEqual(DEFAULT_GLOBAL_SEO.keywords)
    expect(g.organization.sameAs).toEqual(DEFAULT_GLOBAL_SEO.organization.sameAs); expect(g.organization.type).toBe('ClothingStore')
    expect(mergeGlobalSeo(null)).toEqual({ ...DEFAULT_GLOBAL_SEO, shareImageId: undefined, shareImageUrl: undefined, translations: {} })
  })
  test('translated global SEO applies for that locale only', () => {
    const g = mergeGlobalSeo({ translations: { es: { description: 'Descripción' } } }, 'es')
    expect(g.description).toBe('Descripción')
    expect(mergeGlobalSeo({ translations: { es: { description: 'Descripción' } } }, 'en').description).toBe(DEFAULT_GLOBAL_SEO.description)
  })
  test('page override beats global beats coded; noindex honoured; no override keeps coded values', () => {
    const coded = { title: 'Terms — KVRN', description: 'coded', robots: { index: true, follow: false } }
    expect(pageMetadata(coded, {}, null)).toEqual({ title: 'Terms — KVRN', description: 'coded', robots: { index: true, follow: false } })
    expect(pageMetadata(coded, { title: 'Mine', noindex: true }, '/media/x').robots).toEqual({ index: false, follow: false })
    expect(pageMetadata(coded, { title: 'Mine' }, '/media/x').title).toBe('Mine')
    expect((pageMetadata(coded, {}, '/media/x').openGraph as any).images).toEqual([{ url: '/media/x' }])
  })
  test('global SEO validator: https org links, template placeholder, lengths', () => {
    expect(validateGlobalSeo(DEFAULT_GLOBAL_SEO).ok).toBe(true)
    expect(validateGlobalSeo({ ...DEFAULT_GLOBAL_SEO, titleTemplate: 'nope' }).ok).toBe(false)
    expect(validateGlobalSeo({ ...DEFAULT_GLOBAL_SEO, organization: { ...DEFAULT_GLOBAL_SEO.organization, sameAs: ['javascript:1'] } }).ok).toBe(false)
  })
})

describe('policies, pages, size guides, contact: validators', () => {
  const body = { v: 1, blocks: [para('x')] }
  test('policy URL scheme: legacy path for seeded slugs, /legal for the rest', () => {
    expect(policyPath('terms', 'terms')).toBe('/terms')
    expect(policyPath('shipping-returns', 'shipping-returns')).toBe('/support/shipping-returns')
    expect(policyPath('abc-123', 'warranty')).toBe('/legal/warranty')
    expect(policyPath('terms', 'terms-2027')).toBe('/legal/terms-2027')
  })
  test('policies and pages: slug rules and reserved words', () => {
    const p = (slug: string) => validatePolicy({ slug, title: 'T', style: 'legal', body, seo: {} }, { entityId: 'new' })
    expect(p('warranty').ok).toBe(true)
    for (const bad of ['terms', 'privacy', 'cookies', 'shipping-returns', 'size-guide', 'faq', 'track', 'Has Space', '../x', '', 'a'.repeat(81)]) expect(p(bad).ok).toBe(false)
    expect(validatePolicy({ slug: 'terms', title: 'T', style: 'legal', body, seo: {} }, { entityId: 'terms' }).ok).toBe(true)
    expect(validatePage({ slug: 'care', title: 'Care', body, navEligible: false, seo: {} }).ok).toBe(true)
    expect(validatePage({ slug: 'care', title: '', body, navEligible: false, seo: {} }).ok).toBe(false)
  })
  test('size guide: every row needs a label, columns bounded, shop link must be internal/https', () => {
    expect(validateSizeGuide(SEED_SIZE_GUIDE_HOODIE).ok).toBe(true)
    expect(validateSizeGuide({ ...SEED_SIZE_GUIDE_HOODIE, rows: [] }).ok).toBe(false)
    expect(validateSizeGuide({ ...SEED_SIZE_GUIDE_HOODIE, columns: [] }).ok).toBe(false)
    expect(validateSizeGuide({ ...SEED_SIZE_GUIDE_HOODIE, shopLink: { label: 'x', href: 'javascript:1' } }).ok).toBe(false)
    expect(validateSizeGuide({ ...SEED_SIZE_GUIDE_HOODIE, columns: Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, label: 'x' })) }).ok).toBe(false)
  })
  test('cm/in conversion only touches numbers', () => {
    expect(convertCell('62', 'cm', false)).toBe('62'); expect(convertCell('62', 'cm', true)).toBe('24.4"')
    expect(convertCell('70.5', 'cm', true)).toBe('27.8"'); expect(convertCell('24', 'in', false)).toBe('61')
    expect(convertCell('S-M', 'cm', true)).toBe('S-M'); expect(convertCell('', 'cm', true)).toBe('')
  })
  test('contact slots are text only; control and bidi characters are stripped', () => {
    const r = validateContact({ ...DEFAULT_CONTACT, intro: `Hello${fromChar(0, 0x202e)} there` })
    expect(r.ok).toBe(true)
    expect((r as any).value.intro).toBe('Hello there')
  })
  test('locales: unknown shapes fall back to the ten storefront languages, en first', () => {
    expect(parseEnabledLocales(null)[0]).toBe('en'); expect(parseEnabledLocales(null)).toHaveLength(10)
    expect(parseEnabledLocales(['es', 'fr'])).toEqual(['en', 'es', 'fr'])
    expect(parseEnabledLocales(['xx_bad', 'es'])).toEqual(['en', 'es'])
  })
  test('every content kind has a definition and policies are the only legal kind', () => {
    expect(Object.values(KINDS).filter(k => k.legal).map(k => k.kind)).toEqual(['policies'])
    expect(SEED_POLICIES.map(p => p.id)).toEqual(['terms', 'privacy', 'cookies', 'shipping-returns'])
  })
})

describe('source guards', () => {
  test('contact API and support inbox are untouched', () => {
    expect(sha(fs.readFileSync(path.join(ROOT, 'app/api/contact/route.ts')))).toBe('f87f861a6b03d39b38f48a542438dc2add1d8f5d3fec5f51e1d8edb1981929a8')
    expect(sha(fs.readFileSync(path.join(ROOT, 'lib/support-inbox.ts')))).toBe('5b4735463e9f23414bcebf8fd369e86197d9ba64dfab264c5963471e58c2492b')
  })
  test('the contact form logic (state, validation, submit) is byte-identical to the original', () => {
    const s = read('app/contact/ContactClient.tsx')
    const seg = s.slice(s.indexOf('  // One id per page view'), s.indexOf("  if (state === 'success') {"))
    expect(sha(seg)).toBe('104d629f3a8dd82fdcd40a03b4411473e39ad4d1a88cf87ac9084eba098b50a3')
    expect(s).toContain("fetch('/api/contact'")
    expect(s).toContain("const SUBJECTS = ['Order enquiry','Sizing question','Return request','Product question','Press','Other']")
    expect(read('app/contact/page.tsx')).not.toMatch(/fetch\(/)
  })
  test('no CMS content is ever rendered as raw HTML', () => {
    const files = ['components/content/render-richtext.ts', 'components/content/cms-views.tsx', 'components/content/LocaleSwitch.tsx',
      'components/content/SizeGuideClient.tsx', 'components/content/CollectionGrid.tsx', 'app/legal/[slug]/page.tsx', 'app/pages/[slug]/page.tsx',
      'app/collections/[slug]/page.tsx', 'components/layout/Footer.tsx', 'components/layout/Nav.tsx', 'components/ui/AnnouncementBar.tsx']
    for (const f of files) { expect(read(f)).not.toMatch(/dangerouslySetInnerHTML\s*=|\.innerHTML\s*=/) }
    const layout = read('app/layout.tsx')
    expect([...layout.matchAll(/dangerouslySetInnerHTML=\{\{ __html: ([^}]+) \}\}/g)].map(m => m[1])).toEqual(['jsonLd(orgSchema(seo))'])
  })
  test('every wrapped storefront page consults the flag before touching the CMS, and keeps its coded page', () => {
    const wrapped: Array<[string, RegExp]> = [
      ['app/terms/page.tsx', /OwnerPolicyFallback policy="terms"/], ['app/privacy/page.tsx', /OwnerPolicyFallback policy="privacy"/], ['app/cookies/page.tsx', /OwnerPolicyFallback policy="cookies"|CookiesFallback|Fallback/],
      ['app/support/shipping-returns/page.tsx', /LegacyShippingReturnsPage|OwnerPolicyFallback/], ['app/support/faq/page.tsx', /LegacyFAQPage/],
      ['app/about/page.tsx', /LegacyAboutPage/],
      ['app/collections/project-kvrn/page.tsx', /LegacyProjectKVRNPage/], ['app/support/size-guide/page.tsx', /LegacySizeGuide/], ['app/contact/page.tsx', /ContactClient/],
    ]
    for (const [f, legacy] of wrapped) {
      const s = read(f)
      expect(s).toMatch(legacy)
      expect(s).toMatch(/export const dynamic\s*=\s*'force-dynamic'/)
      // every loader call must be preceded (in its own function) by the flag check; the size-guide
      // page keeps its loader in a helper that is only ever called after the check.
      const body = s.replace(/async function load\(\) \{[\s\S]*?\n\}\n/, '')
      const calls = [...body.matchAll(/contentPublic\(\)\.|await load\(\)/g)].map(m => m.index!)
      expect(calls.length).toBeGreaterThan(0)
      for (const at of calls) {
        const before = body.slice(Math.max(0, at - 260), at)
        expect(before).toMatch(/cmsContentEnabled\(\)/)
      }
    }
  })
  test('legacy /legal/* aliases permanently redirect to the one canonical route and never render a second copy', () => {
    for (const [f, to] of [['app/legal/terms/page.tsx', '/terms'], ['app/legal/privacy/page.tsx', '/privacy']]) {
      const s = read(f)
      expect(s).toContain(`permanentRedirect('${to}')`)
      expect(s).not.toMatch(/contentPublic|OwnerPolicyFallback|PolicyView/)
    }
  })
  test('routes that exist only with the flag on 404 when it is off', () => {
    for (const f of ['app/legal/[slug]/page.tsx', 'app/pages/[slug]/page.tsx', 'app/collections/[slug]/page.tsx']) {
      const s = read(f)
      expect(s).toMatch(/if \(!cmsContentEnabled\(\)\) return \{ kind: 'none' as const \}/)
      expect(s).toMatch(/notFound\(\)/)
    }
  })
  test('the root layout keeps its provider tree and only passes shell data when the flag is on', () => {
    const s = read('app/layout.tsx')
    for (const p of ['CookiePrefsProvider', 'I18nProvider', 'HeaderProvider', 'CurrencyProvider', 'WishlistProvider', 'CartProvider', 'ToastProvider']) expect(s).toContain(`<${p}>`)
    expect(s).toMatch(/const shell\s+= cms \? await contentPublic\(\)\.getShell\(\) : null/)
  })
  test('sitemap reads published content only and goes through the product loader', () => {
    const s = read('app/sitemap.ts')
    expect(s).toContain("from '@/lib/product-public'")
    expect(s).toMatch(/if \(!cmsContentEnabled\(\)\) return coded/)
  })
})
