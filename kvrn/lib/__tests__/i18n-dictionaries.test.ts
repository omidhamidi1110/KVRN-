// Static dictionaries: every enabled locale must have a COMPLETE key set, for real.
// (The old makeFallback made five locales look complete while most strings were English.)
import fs from 'fs'
import path from 'path'
import { LOCALE_CODES, LOCALES, SOURCE_LOCALE, dirOf, isLocale, toStripeLocale, type Locale } from '../i18n/locales'
import {
  MESSAGES, MESSAGE_KEYS, LOCALE_REVIEW, EN, staticCompleteness, readyLocales, placeholdersOf, format, fillMessages,
} from '../i18n/messages'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

describe('locale registry', () => {
  test('exactly the ten required locales', () => {
    expect([...LOCALE_CODES].sort()).toEqual(['ar', 'de', 'en', 'es', 'fr', 'hi', 'ja', 'ko', 'pt', 'zh'])
    expect(SOURCE_LOCALE).toBe('en')
    expect(isLocale('xx')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
  })
  test('only Arabic is right-to-left', () => {
    expect(LOCALE_CODES.filter(l => dirOf(l) === 'rtl')).toEqual(['ar'])
  })
})

describe('every locale has a complete static key set', () => {
  test('there is a meaningful number of keys', () => {
    expect(MESSAGE_KEYS.length).toBeGreaterThan(300)
  })
  test.each([...LOCALE_CODES])('%s: every key present, non-empty, placeholder-faithful', (l) => {
    const c = staticCompleteness(l)
    expect(c.missing).toEqual([])
    expect(c.empty).toEqual([])
    expect(c.placeholderMismatch).toEqual([])
    expect(c.present).toBe(c.total)
    expect(c.complete).toBe(true)
  })
  test.each([...LOCALE_CODES])('%s: no extra keys beyond the English source', (l) => {
    expect(Object.keys(MESSAGES[l]).filter(k => !(k in EN))).toEqual([])
    expect(Object.keys(MESSAGES[l]).length).toBe(MESSAGE_KEYS.length)
  })
  test('all ten are ready to serve', () => {
    expect(readyLocales().sort()).toEqual([...LOCALE_CODES].sort())
  })
  test.each([...LOCALE_CODES].filter(l => l !== 'en'))('%s is a real translation, not English dressed up', (l) => {
    // Brand names, numbers and a few loanwords legitimately match English; a fallback copy would match almost everything.
    const same = MESSAGE_KEYS.filter(k => /[A-Za-z]{4}/.test(EN[k]) && MESSAGES[l][k] === EN[k])
    expect(same.length / MESSAGE_KEYS.length).toBeLessThan(0.1)
  })
  test('no stub markers, no makeFallback, anywhere in the dictionaries', () => {
    for (const l of LOCALE_CODES) {
      const src = read(`lib/i18n/messages/${l}.ts`)
      expect(src).not.toMatch(/TODO-STUB|makeFallback|\.\.\.en\b/)
    }
    expect(read('lib/i18n/messages/index.ts')).not.toMatch(/makeFallback\(/)
    expect(read('context/I18nContext.tsx')).not.toMatch(/makeFallback/)
  })
})

describe('completeness detector is not fooled', () => {
  test('a missing key, an empty value and a broken placeholder each fail the locale', () => {
    const base: Record<string, string> = { ...MESSAGES.de }
    delete base['cart.bagItems']
    base['common.close'] = '   '
    base['cart.removeItem'] = 'Entfernen'            // lost {name}
    const c = staticCompleteness('de', base)
    expect(c.complete).toBe(false)
    expect(c.missing).toEqual(['cart.bagItems'])
    expect(c.empty).toEqual(['common.close'])
    expect(c.placeholderMismatch).toEqual(['cart.removeItem'])
    expect(c.present).toBe(c.total - 2)
  })
  test('a locale padded with English values is still "complete" by key count, so the translation-ratio guard above exists', () => {
    expect(staticCompleteness('ja', { ...EN }).complete).toBe(true)
  })
})

describe('review status is honest', () => {
  test('English is the source; every other locale says AI-assisted and unreviewed', () => {
    expect(LOCALE_REVIEW.en.status).toBe('source')
    for (const l of LOCALE_CODES.filter(x => x !== 'en')) {
      expect(LOCALE_REVIEW[l].status).toBe('ai_assisted_unreviewed')
      expect(LOCALE_REVIEW[l].note).toMatch(/not reviewed/i)
    }
  })
  test('nothing claims professional review', () => {
    for (const l of LOCALE_CODES) {
      expect(JSON.stringify(LOCALE_REVIEW[l])).not.toMatch(/professionally_reviewed|native_reviewed/)
    }
  })
})

describe('agreed bundle keys exist in every locale', () => {
  const keys = ['bundle.completeTheSet', 'bundle.addSet', 'bundle.subtotal', 'bundle.discount', 'bundle.total', 'bundle.unavailable', 'bundle.viewSeparately', 'bundle.chooseSize']
  test.each([...LOCALE_CODES])('%s', (l) => {
    for (const k of keys) expect((MESSAGES[l] as any)[k]).toEqual(expect.any(String))
  })
})

describe('helpers', () => {
  test('format replaces known placeholders and leaves unknown ones visible', () => {
    expect(format('Hi {name}, {n} left', { name: 'A', n: 2 })).toBe('Hi A, 2 left')
    expect(format('Hi {name}', {})).toBe('Hi {name}')
    expect(format('no vars')).toBe('no vars')
  })
  test('placeholdersOf is order-insensitive', () => {
    expect(placeholdersOf('{b} and {a}')).toEqual(['{a}', '{b}'])
  })
  test('fillMessages never yields undefined', () => {
    const t = fillMessages({ shopAll: 'X' } as any)
    expect(t.shopAll).toBe('X')
    expect(t['cart.bagItems']).toBe(EN['cart.bagItems'])
    expect(fillMessages(undefined)).toBe(EN)
  })
  test('English dictionary values are the shipped wording (golden anchors)', () => {
    expect(EN.addToBag).toBe('Add to Bag')
    expect(EN.checkout).toBe('Checkout')
  })
})

describe('Stripe Checkout locale mapping (installed SDK 16.12 types)', () => {
  const sdk = fs.readFileSync(path.join(ROOT, 'node_modules/stripe/types/Checkout/SessionsResource.d.ts'), 'utf8')
  const typeBlock = (/type Locale =([\s\S]*?)\n\n/.exec(sdk) ?? [])[1] ?? ''
  const supported = new Set([...typeBlock.matchAll(/'([a-zA-Z-]+)'/g)].map(m => m[1]))
  test('the SDK type was found and lists auto and en', () => {
    expect(supported.has('auto')).toBe(true)
    expect(supported.has('en')).toBe(true)
  })
  test.each([...LOCALE_CODES])('%s maps to something Stripe accepts', (l) => {
    expect(supported.has(toStripeLocale(l as Locale))).toBe(true)
  })
  test('Arabic and Hindi are not in Stripe\'s list, so they use auto', () => {
    expect(toStripeLocale('ar')).toBe('auto')
    expect(toStripeLocale('hi')).toBe('auto')
    expect(supported.has('ar')).toBe(false)
    expect(supported.has('hi')).toBe(false)
  })
  test('the rest map to their own language', () => {
    expect(toStripeLocale('en')).toBe('en')
    expect(toStripeLocale('es')).toBe('es')
    expect(toStripeLocale('fr')).toBe('fr')
    expect(toStripeLocale('de')).toBe('de')
    expect(toStripeLocale('ja')).toBe('ja')
    expect(toStripeLocale('ko')).toBe('ko')
    expect(toStripeLocale('pt')).toMatch(/^pt/)
    expect(toStripeLocale('zh')).toMatch(/^zh/)
  })
  test('LOCALES metadata and registry agree', () => {
    for (const l of LOCALE_CODES) expect(LOCALES[l].code).toBe(l)
  })
})
