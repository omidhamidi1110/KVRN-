// lib/i18n/messages/index.ts — the static dictionaries, their completeness, and lookup helpers.
// PURE (client and server).
//
// COMPLETENESS IS REAL
//   Every locale object is typed `Messages`, so a missing key is a compile error; a test also
//   enumerates every key of every locale and fails on a missing, empty or placeholder-mismatched
//   value. A locale is READY only when `staticCompleteness(locale).complete` is true. There is no
//   "fill the gaps with English" constructor any more (the old `makeFallback` made 5 locales look
//   complete while most strings were English).
//
// REVIEW STATUS (honest metadata)
//   English is the source. Every other dictionary was produced by AI-assisted translation and has
//   NOT been reviewed by a native speaker or a professional translator. `LOCALE_REVIEW` says so,
//   and the Admin screen shows it. Nothing here claims professional review.

import { LOCALE_CODES, SOURCE_LOCALE, type Locale } from '../locales'
import { en } from './en'
import { es } from './es'
import { fr } from './fr'
import { ar } from './ar'
import { zh } from './zh'
import { hi } from './hi'
import { pt } from './pt'
import { de } from './de'
import { ja } from './ja'
import { ko } from './ko'

export type MessageKey = keyof typeof en
export type Messages = { readonly [K in MessageKey]: string }

export const EN: Messages = en
export const MESSAGES: Readonly<Record<Locale, Messages>> = { en, es, fr, ar, zh, hi, pt, de, ja, ko }
export const MESSAGE_KEYS = Object.keys(en) as MessageKey[]

export type ReviewStatus = 'source' | 'ai_assisted_unreviewed' | 'native_reviewed' | 'professionally_reviewed'

export interface LocaleReview {
  status: ReviewStatus
  note: string
}

const AI_NOTE = 'AI-assisted translation. Not reviewed by a native speaker or professional translator.'

export const LOCALE_REVIEW: Readonly<Record<Locale, LocaleReview>> = {
  en: { status: 'source', note: 'Source language.' },
  es: { status: 'ai_assisted_unreviewed', note: AI_NOTE },
  fr: { status: 'ai_assisted_unreviewed', note: AI_NOTE },
  ar: { status: 'ai_assisted_unreviewed', note: AI_NOTE },
  zh: { status: 'ai_assisted_unreviewed', note: AI_NOTE },
  hi: { status: 'ai_assisted_unreviewed', note: AI_NOTE },
  pt: { status: 'ai_assisted_unreviewed', note: AI_NOTE },
  de: { status: 'ai_assisted_unreviewed', note: AI_NOTE },
  ja: { status: 'ai_assisted_unreviewed', note: AI_NOTE },
  ko: { status: 'ai_assisted_unreviewed', note: AI_NOTE },
}

const PLACEHOLDER_RE = /\{[A-Za-z0-9]+\}/g
/** The `{name}` placeholders in a string, sorted — what a translation must preserve. */
export const placeholdersOf = (s: string): string[] => (s.match(PLACEHOLDER_RE) ?? []).slice().sort()

export interface StaticCompleteness {
  locale: Locale
  total: number
  present: number
  /** Keys with no entry at all. */
  missing: string[]
  /** Keys whose value is empty or whitespace. */
  empty: string[]
  /** Keys whose `{placeholders}` differ from English (a broken template). */
  placeholderMismatch: string[]
  complete: boolean
}

/** Per-locale static completeness. `dict` is injectable so the check itself can be tested. */
export function staticCompleteness(locale: Locale, dict: Record<string, unknown> = MESSAGES[locale]): StaticCompleteness {
  const missing: string[] = [], empty: string[] = [], bad: string[] = []
  let present = 0
  for (const k of MESSAGE_KEYS) {
    const v = (dict as Record<string, unknown>)[k]
    if (v === undefined) { missing.push(k); continue }
    if (typeof v !== 'string' || v.trim() === '') { empty.push(k); continue }
    present++
    if (locale !== SOURCE_LOCALE && placeholdersOf(v).join('|') !== placeholdersOf(en[k]).join('|')) bad.push(k)
  }
  return {
    locale, total: MESSAGE_KEYS.length, present, missing, empty, placeholderMismatch: bad,
    complete: missing.length === 0 && empty.length === 0 && bad.length === 0,
  }
}

/** Locales whose dictionary is complete — the only ones the storefront may serve. */
let readyCache: Locale[] | null = null
export function readyLocales(): Locale[] {
  // The dictionaries are static for the life of the bundle, so the check runs once.
  readyCache ??= LOCALE_CODES.filter(l => staticCompleteness(l).complete)
  return readyCache.slice()
}

/** Replace `{name}` placeholders. Unknown placeholders are left visible rather than dropped. */
export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(PLACEHOLDER_RE, m => {
    const k = m.slice(1, -1)
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  })
}

const filled = new WeakMap<object, Messages>()

/**
 * A `t` object that can never return `undefined`: any key missing from `t` falls back to English.
 * The storefront's real dictionaries are complete, so this only matters where a caller supplies a
 * partial `t` (tests, previews). Cached per input object.
 */
export function fillMessages(t: Partial<Messages> | undefined | null): Messages {
  if (!t) return EN
  if (t === EN) return EN
  const hit = filled.get(t)
  if (hit) return hit
  const out = Object.assign(Object.create(EN), t) as Messages
  filled.set(t, out)
  return out
}
