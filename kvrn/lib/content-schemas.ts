// lib/content-schemas.ts — snapshot shapes, validators and translatable-field slots for every
// Admin-managed content kind. PURE (no DB, no React): importable from services, routes, tests
// and the Admin UI.
//
// A "snapshot" is the JSON stored in content_versions.snapshot. Every validator REBUILDS the
// snapshot from whitelisted fields (unknown keys are dropped) and returns precise errors.

import {
  validateRichText, collectMediaIds, collectBlockRefs, emptyRichText, richTextToPlain, isRichTextEmpty,
  type RichText,
} from './content-richtext'
import { checkNavUrl, checkFooterUrl, checkSlug, normalizeInternalPath } from './content-urls'

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] }

// ── Kinds ─────────────────────────────────────────────────────────────────────

export type ContentKind =
  | 'policies' | 'size-guides' | 'blocks' | 'faq' | 'pages' | 'about' | 'contact'
  | 'support-pages' | 'announcement' | 'navigation' | 'footer'

export interface KindDef {
  kind: ContentKind
  /** content_entities.entity_type */
  type: string
  label: string
  /** Fixed entity ids for singletons (faq/main, about/main ...). Empty = many entities. */
  singleton?: string
  /** Snapshots carry a public `slug` (policy, page). */
  sluggable: boolean
  /** Legal/policy content: translations are only ever published by a deliberate per-locale action. */
  legal: boolean
}

export const KINDS: Record<ContentKind, KindDef> = {
  'policies':      { kind: 'policies',      type: 'policy',       label: 'Policy',        sluggable: true,  legal: true },
  'size-guides':   { kind: 'size-guides',   type: 'size_guide',   label: 'Size guide',    sluggable: false, legal: false },
  'blocks':        { kind: 'blocks',        type: 'content_block',label: 'Content block', sluggable: false, legal: false },
  'faq':           { kind: 'faq',           type: 'faq',          label: 'FAQ',           sluggable: false, legal: false, singleton: 'main' },
  'pages':         { kind: 'pages',         type: 'page',         label: 'Page',          sluggable: true,  legal: false },
  'about':         { kind: 'about',         type: 'about',        label: 'About',         sluggable: false, legal: false, singleton: 'main' },
  'contact':       { kind: 'contact',       type: 'contact',      label: 'Contact',       sluggable: false, legal: false, singleton: 'main' },
  'support-pages': { kind: 'support-pages', type: 'support_page', label: 'Support page',  sluggable: false, legal: false },
  'announcement':  { kind: 'announcement',  type: 'announcement', label: 'Announcement',  sluggable: false, legal: false, singleton: 'main' },
  'navigation':    { kind: 'navigation',    type: 'navigation',   label: 'Navigation',    sluggable: false, legal: false, singleton: 'main' },
  'footer':        { kind: 'footer',        type: 'footer',       label: 'Footer',        sluggable: false, legal: false, singleton: 'main' },
}

export const isContentKind = (k: unknown): k is ContentKind => typeof k === 'string' && Object.prototype.hasOwnProperty.call(KINDS, k)
export const kindForType = (type: string): ContentKind | null =>
  (Object.values(KINDS).find(k => k.type === type)?.kind) ?? null

// ── Shared primitives ─────────────────────────────────────────────────────────

class Ec {
  errors: string[] = []
  err(path: string, msg: string) { if (this.errors.length < 30) this.errors.push(`${path}: ${msg}`) }
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i
// eslint-disable-next-line no-control-regex
const BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g
const clean = (s: string) => s.replace(BAD, '').normalize('NFC')

function text(ec: Ec, path: string, v: unknown, max: number, o: { required?: boolean; multiline?: boolean } = {}): string {
  if (v === undefined || v === null) { if (o.required) ec.err(path, 'is required'); return '' }
  if (typeof v !== 'string') { ec.err(path, 'must be text'); return '' }
  let s = clean(v)
  if (!o.multiline) s = s.replace(/[\r\n]+/g, ' ')
  s = s.trim()
  if (s.length > max) { ec.err(path, `is too long (max ${max})`); return s.slice(0, max) }
  if (o.required && !s) ec.err(path, 'is required')
  return s
}
function bool(v: unknown, dflt = false): boolean { return typeof v === 'boolean' ? v : dflt }
function uuidOpt(ec: Ec, path: string, v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || !UUID_RE.test(v)) { ec.err(path, 'choose an image from the library'); return undefined }
  return v.toLowerCase()
}
function idOf(ec: Ec, path: string, v: unknown, seen: Set<string>): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) { ec.err(path, 'has an invalid id'); return '' }
  const k = v.toLowerCase()
  if (seen.has(k)) { ec.err(path, 'has a duplicate id'); return '' }
  seen.add(k)
  return v
}
function list<T>(ec: Ec, path: string, v: unknown, max: number, each: (x: unknown, i: number) => T | null, min = 0): T[] {
  if (v === undefined || v === null) { if (min > 0) ec.err(path, `needs at least ${min}`); return [] }
  if (!Array.isArray(v)) { ec.err(path, 'must be a list'); return [] }
  if (v.length > max) { ec.err(path, `has too many items (max ${max})`); return [] }
  if (v.length < min) ec.err(path, `needs at least ${min}`)
  const out: T[] = []
  v.forEach((x, i) => { const r = each(x, i); if (r !== null) out.push(r) })
  return out
}
function rich(ec: Ec, path: string, v: unknown, o: { allowBlockRefs?: boolean; allowMedia?: boolean; required?: boolean } = {}): RichText {
  if (v === undefined || v === null) { if (o.required) ec.err(path, 'is required'); return emptyRichText() }
  const r = validateRichText(v, { allowBlockRefs: o.allowBlockRefs, allowMedia: o.allowMedia })
  if (!r.ok) { r.errors.forEach(e => ec.err(path, e)); return emptyRichText() }
  if (o.required && isRichTextEmpty(r.value)) ec.err(path, 'is required')
  return r.value
}
const done = <T>(ec: Ec, value: T): Validation<T> => ec.errors.length ? { ok: false, errors: ec.errors } : { ok: true, value }

// ── SEO block (per policy / page / about / contact / FAQ ...) ────────────────

export interface SeoFields { title?: string; description?: string; shareTitle?: string; shareImageId?: string; noindex?: boolean }

export function validateSeo(ec: Ec, path: string, v: unknown): SeoFields {
  const o = isObj(v) ? v : {}
  const out: SeoFields = {}
  const title = text(ec, `${path}.title`, o.title, 120); if (title) out.title = title
  const description = text(ec, `${path}.description`, o.description, 320); if (description) out.description = description
  const shareTitle = text(ec, `${path}.shareTitle`, o.shareTitle, 120); if (shareTitle) out.shareTitle = shareTitle
  const img = uuidOpt(ec, `${path}.shareImageId`, o.shareImageId); if (img) out.shareImageId = img
  if (o.noindex === true) out.noindex = true
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// POLICY
// ═══════════════════════════════════════════════════════════════════════════

export type PolicyStyle = 'legal' | 'support'

export interface PolicySnapshot {
  slug: string
  title: string
  heroTitle?: string
  heroBreadcrumb?: string
  /** 'YYYY-MM-DD' — shown as "Last updated". Null/absent = not shown. */
  effectiveDate?: string | null
  lastUpdatedLabel?: string
  style: PolicyStyle
  body: RichText
  seo: SeoFields
}

/** Seeded policies keep their existing public URL (and an alias under /legal for terms/privacy). */
export const LEGACY_POLICY_PATHS: Record<string, { slug: string; path: string }> = {
  'terms':            { slug: 'terms',            path: '/terms' },
  'privacy':          { slug: 'privacy',          path: '/privacy' },
  'cookies':          { slug: 'cookies',          path: '/cookies' },
  'shipping-returns': { slug: 'shipping-returns', path: '/support/shipping-returns' },
  'messaging-terms':   { slug: 'messaging-terms',   path: '/messaging-terms' },
  'messaging-privacy': { slug: 'messaging-privacy', path: '/messaging-privacy' },
}
export const RESERVED_POLICY_SLUGS: ReadonlySet<string> = new Set(['terms', 'privacy', 'cookies', 'shipping-returns', 'size-guide', 'faq', 'track', 'messaging-terms', 'messaging-privacy'])

/** Public path of a policy: its legacy URL while it keeps the legacy slug, else /legal/<slug>. */
export function policyPath(entityId: string, slug: string): string {
  const legacy = LEGACY_POLICY_PATHS[entityId]
  return legacy && legacy.slug === slug ? legacy.path : `/legal/${slug}`
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
export function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export function validatePolicy(input: unknown, ctx: { entityId?: string } = {}): Validation<PolicySnapshot> {
  const ec = new Ec(); const o = isObj(input) ? input : {}
  if (!isObj(input)) ec.err('policy', 'is not valid')
  const own = ctx.entityId ? LEGACY_POLICY_PATHS[ctx.entityId]?.slug : undefined
  const reserved = own ? new Set([...RESERVED_POLICY_SLUGS].filter(s => s !== own)) : RESERVED_POLICY_SLUGS
  const sl = checkSlug(o.slug, reserved); if (!sl.ok) ec.err('slug', sl.error!)
  const title = text(ec, 'title', o.title, 140, { required: true })
  const out: PolicySnapshot = {
    slug: sl.value ?? '', title,
    style: o.style === 'support' ? 'support' : 'legal',
    body: rich(ec, 'body', o.body, { allowBlockRefs: true, required: true }),
    seo: validateSeo(ec, 'seo', o.seo),
  }
  const hero = text(ec, 'heroTitle', o.heroTitle, 140); if (hero) out.heroTitle = hero
  const crumb = text(ec, 'heroBreadcrumb', o.heroBreadcrumb, 80); if (crumb) out.heroBreadcrumb = crumb
  const lbl = text(ec, 'lastUpdatedLabel', o.lastUpdatedLabel, 60); if (lbl) out.lastUpdatedLabel = lbl
  if (o.effectiveDate !== undefined && o.effectiveDate !== null && o.effectiveDate !== '') {
    if (typeof o.effectiveDate !== 'string' || !isRealDate(o.effectiveDate)) ec.err('effectiveDate', 'must be a real date')
    else out.effectiveDate = o.effectiveDate
  }
  return done(ec, out)
}

// ═══════════════════════════════════════════════════════════════════════════
// SIZE GUIDE
// ═══════════════════════════════════════════════════════════════════════════

export interface SizeGuideColumn { id: string; label: string }
export interface SizeGuideRow { id: string; label: string; values: Record<string, string> }
export interface SizeGuideSnapshot {
  name: string
  garment: string
  shopLink?: { label: string; href: string }
  unit: 'cm' | 'in'
  rowHeader: string
  columns: SizeGuideColumn[]
  rows: SizeGuideRow[]
  notes: string[]
  fit: RichText
  imageAssetId?: string
  imageAlt?: string
  showOnGuidePage: boolean
  order: number
}

export function validateSizeGuide(input: unknown): Validation<SizeGuideSnapshot> {
  const ec = new Ec(); const o = isObj(input) ? input : {}
  if (!isObj(input)) ec.err('size guide', 'is not valid')
  const colIds = new Set<string>(); const rowIds = new Set<string>()
  const columns = list<SizeGuideColumn>(ec, 'columns', o.columns, 10, (c, i) => {
    const x = isObj(c) ? c : {}
    return { id: idOf(ec, `columns[${i}]`, x.id, colIds), label: text(ec, `columns[${i}].label`, x.label, 60, { required: true }) }
  }, 1)
  const rows = list<SizeGuideRow>(ec, 'rows', o.rows, 40, (r, i) => {
    const x = isObj(r) ? r : {}
    const vals = isObj(x.values) ? x.values : {}
    const values: Record<string, string> = {}
    for (const c of columns) {
      const raw = vals[c.id]
      values[c.id] = text(ec, `rows[${i}].values.${c.id}`, raw === undefined || raw === null ? '' : String(raw), 30)
    }
    return { id: idOf(ec, `rows[${i}]`, x.id, rowIds), label: text(ec, `rows[${i}].label`, x.label, 30, { required: true }), values }
  }, 1)
  const out: SizeGuideSnapshot = {
    name: text(ec, 'name', o.name, 100, { required: true }),
    garment: text(ec, 'garment', o.garment, 60),
    unit: o.unit === 'in' ? 'in' : 'cm',
    rowHeader: text(ec, 'rowHeader', o.rowHeader ?? 'Size', 40) || 'Size',
    columns, rows,
    notes: list<string>(ec, 'notes', o.notes, 12, (n, i) => text(ec, `notes[${i}]`, n, 300) || null),
    fit: rich(ec, 'fit', o.fit, { allowBlockRefs: false }),
    showOnGuidePage: bool(o.showOnGuidePage, true),
    order: Number.isInteger(o.order) ? Math.min(Math.max(o.order as number, 0), 9999) : 0,
  }
  if (isObj(o.shopLink) && (o.shopLink.label || o.shopLink.href)) {
    const label = text(ec, 'shopLink.label', o.shopLink.label, 80, { required: true })
    const chk = checkNavUrl(o.shopLink.href)
    if (!chk.ok) ec.err('shopLink.href', chk.error!)
    else out.shopLink = { label, href: chk.value! }
  }
  const img = uuidOpt(ec, 'imageAssetId', o.imageAssetId); if (img) out.imageAssetId = img
  const alt = text(ec, 'imageAlt', o.imageAlt, 200); if (alt) out.imageAlt = alt
  if (out.imageAssetId && !out.imageAlt) { /* alt falls back to the library alt text; not an error */ }
  return done(ec, out)
}

// ═══════════════════════════════════════════════════════════════════════════
// REUSABLE CONTENT BLOCK
// ═══════════════════════════════════════════════════════════════════════════

export const BLOCK_CATEGORIES = ['care', 'fabric', 'fit', 'construction', 'warranty', 'product-note', 'other'] as const
export type BlockCategory = typeof BLOCK_CATEGORIES[number]
export interface ContentBlockSnapshot { name: string; category: BlockCategory; content: RichText }

export function validateContentBlock(input: unknown): Validation<ContentBlockSnapshot> {
  const ec = new Ec(); const o = isObj(input) ? input : {}
  if (!isObj(input)) ec.err('block', 'is not valid')
  const category = BLOCK_CATEGORIES.includes(o.category as BlockCategory) ? (o.category as BlockCategory) : 'other'
  return done(ec, {
    name: text(ec, 'name', o.name, 100, { required: true }),
    category,
    // A reusable block is short informational text: no nesting, no layout.
    content: rich(ec, 'content', o.content, { allowBlockRefs: false, required: true }),
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// FAQ (one list entity: atomic ordering + versioning)
// ═══════════════════════════════════════════════════════════════════════════

export interface FaqItem { id: string; question: string; answer: RichText; active: boolean }
export interface FaqCategory { id: string; heading: string; active: boolean; items: FaqItem[] }
export interface FaqSnapshot {
  heroTitle: string
  categories: FaqCategory[]
  footerTitle: string
  footerBody: RichText
  seo: SeoFields
}

export function validateFaq(input: unknown): Validation<FaqSnapshot> {
  const ec = new Ec(); const o = isObj(input) ? input : {}
  if (!isObj(input)) ec.err('FAQ', 'is not valid')
  const catIds = new Set<string>(); const itemIds = new Set<string>()
  let total = 0
  const categories = list<FaqCategory>(ec, 'categories', o.categories, 20, (c, i) => {
    const x = isObj(c) ? c : {}
    const items = list<FaqItem>(ec, `categories[${i}].items`, x.items, 60, (it, j) => {
      const y = isObj(it) ? it : {}
      total++
      return {
        id: idOf(ec, `categories[${i}].items[${j}]`, y.id, itemIds),
        question: text(ec, `categories[${i}].items[${j}].question`, y.question, 240, { required: true }),
        answer: rich(ec, `categories[${i}].items[${j}].answer`, y.answer, { allowBlockRefs: true, required: true }),
        active: bool(y.active, true),
      }
    })
    return { id: idOf(ec, `categories[${i}]`, x.id, catIds), heading: text(ec, `categories[${i}].heading`, x.heading, 80, { required: true }), active: bool(x.active, true), items }
  })
  if (total > 300) ec.err('categories', 'has too many questions')
  return done(ec, {
    heroTitle: text(ec, 'heroTitle', o.heroTitle ?? 'FAQ', 100) || 'FAQ',
    categories,
    footerTitle: text(ec, 'footerTitle', o.footerTitle, 120),
    footerBody: rich(ec, 'footerBody', o.footerBody, { allowBlockRefs: false, allowMedia: false }),
    seo: validateSeo(ec, 'seo', o.seo),
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// GENERIC PAGE
// ═══════════════════════════════════════════════════════════════════════════

export interface PageSnapshot {
  slug: string
  title: string
  subtitle?: string
  body: RichText
  navEligible: boolean
  seo: SeoFields
}

export function validatePage(input: unknown): Validation<PageSnapshot> {
  const ec = new Ec(); const o = isObj(input) ? input : {}
  if (!isObj(input)) ec.err('page', 'is not valid')
  const sl = checkSlug(o.slug); if (!sl.ok) ec.err('slug', sl.error!)
  const out: PageSnapshot = {
    slug: sl.value ?? '',
    title: text(ec, 'title', o.title, 140, { required: true }),
    body: rich(ec, 'body', o.body, { allowBlockRefs: true, required: true }),
    navEligible: bool(o.navEligible, false),
    seo: validateSeo(ec, 'seo', o.seo),
  }
  const sub = text(ec, 'subtitle', o.subtitle, 240); if (sub) out.subtitle = sub
  return done(ec, out)
}

// ═══════════════════════════════════════════════════════════════════════════
// ABOUT / CONTACT / SUPPORT PAGE slots (inside the coded templates)
// ═══════════════════════════════════════════════════════════════════════════

export interface AboutSnapshot {
  heroTitle: string
  brandEyebrow: string
  lead: string
  brandParagraphs: string[]
  approachEyebrow: string
  approach: Array<{ id: string; title: string; description: string }>
  ctaLabel: string
  ctaHref: string
  imageAssetId?: string
  imageAlt?: string
  seo: SeoFields
}

export function validateAbout(input: unknown): Validation<AboutSnapshot> {
  const ec = new Ec(); const o = isObj(input) ? input : {}
  if (!isObj(input)) ec.err('About', 'is not valid')
  const ids = new Set<string>()
  const cta = checkNavUrl(o.ctaHref ?? '/shop'); if (!cta.ok) ec.err('ctaHref', cta.error!)
  const out: AboutSnapshot = {
    heroTitle: text(ec, 'heroTitle', o.heroTitle, 100, { required: true }),
    brandEyebrow: text(ec, 'brandEyebrow', o.brandEyebrow, 60),
    lead: text(ec, 'lead', o.lead, 400, { multiline: true }),
    brandParagraphs: list<string>(ec, 'brandParagraphs', o.brandParagraphs, 8, (p, i) => text(ec, `brandParagraphs[${i}]`, p, 1200, { multiline: true }) || null),
    approachEyebrow: text(ec, 'approachEyebrow', o.approachEyebrow, 60),
    approach: list(ec, 'approach', o.approach, 10, (a, i) => {
      const x = isObj(a) ? a : {}
      return {
        id: idOf(ec, `approach[${i}]`, x.id, ids),
        title: text(ec, `approach[${i}].title`, x.title, 80, { required: true }),
        description: text(ec, `approach[${i}].description`, x.description, 400, { multiline: true }),
      }
    }),
    ctaLabel: text(ec, 'ctaLabel', o.ctaLabel, 60),
    ctaHref: cta.value ?? '/shop',
    seo: validateSeo(ec, 'seo', o.seo),
  }
  const img = uuidOpt(ec, 'imageAssetId', o.imageAssetId); if (img) out.imageAssetId = img
  const alt = text(ec, 'imageAlt', o.imageAlt, 200); if (alt) out.imageAlt = alt
  return done(ec, out)
}

export interface ContactSnapshot {
  heroTitle: string
  intro: string
  successTitle: string
  successBody: string
  supportHours: string
  helpNote: string
  seo: SeoFields
}

export function validateContact(input: unknown): Validation<ContactSnapshot> {
  const ec = new Ec(); const o = isObj(input) ? input : {}
  if (!isObj(input)) ec.err('Contact', 'is not valid')
  return done(ec, {
    heroTitle: text(ec, 'heroTitle', o.heroTitle, 100, { required: true }),
    intro: text(ec, 'intro', o.intro, 600, { multiline: true }),
    successTitle: text(ec, 'successTitle', o.successTitle, 100, { required: true }),
    successBody: text(ec, 'successBody', o.successBody, 400, { multiline: true }),
    supportHours: text(ec, 'supportHours', o.supportHours, 300, { multiline: true }),
    helpNote: text(ec, 'helpNote', o.helpNote, 400, { multiline: true }),
    seo: validateSeo(ec, 'seo', o.seo),
  })
}

export interface SupportPageSnapshot {
  heroTitle: string
  intro: string
  tip: RichText
  links: Array<{ id: string; label: string; href: string }>
  seo: SeoFields
}

export function validateSupportPage(input: unknown): Validation<SupportPageSnapshot> {
  const ec = new Ec(); const o = isObj(input) ? input : {}
  if (!isObj(input)) ec.err('support page', 'is not valid')
  const ids = new Set<string>()
  return done(ec, {
    heroTitle: text(ec, 'heroTitle', o.heroTitle, 100, { required: true }),
    intro: text(ec, 'intro', o.intro, 800, { multiline: true }),
    tip: rich(ec, 'tip', o.tip, { allowBlockRefs: false, allowMedia: false }),
    links: list(ec, 'links', o.links, 6, (l, i) => {
      const x = isObj(l) ? l : {}
      const chk = checkNavUrl(x.href); if (!chk.ok) ec.err(`links[${i}].href`, chk.error!)
      return { id: idOf(ec, `links[${i}]`, x.id, ids), label: text(ec, `links[${i}].label`, x.label, 80, { required: true }), href: chk.value ?? '' }
    }),
    seo: validateSeo(ec, 'seo', o.seo),
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// ANNOUNCEMENT
// ═══════════════════════════════════════════════════════════════════════════

export interface AnnouncementMessage { id: string; text: string; href?: string }
export interface AnnouncementSnapshot {
  enabled: boolean
  messages: AnnouncementMessage[]
  /** ISO-8601 UTC instants. */
  startsAt: string | null
  endsAt: string | null
}

export function parseUtcInstant(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string') return undefined
  // Must carry an explicit zone (Z or ±hh:mm): a bare local time is ambiguous and refused.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

export function validateAnnouncement(input: unknown): Validation<AnnouncementSnapshot> {
  const ec = new Ec(); const o = isObj(input) ? input : {}
  if (!isObj(input)) ec.err('announcement', 'is not valid')
  const ids = new Set<string>()
  const messages = list<AnnouncementMessage>(ec, 'messages', o.messages, 5, (m, i) => {
    const x = isObj(m) ? m : {}
    const msg: AnnouncementMessage = {
      id: idOf(ec, `messages[${i}]`, x.id, ids),
      text: text(ec, `messages[${i}].text`, x.text, 140, { required: true }),
    }
    if (x.href !== undefined && x.href !== null && String(x.href).trim() !== '') {
      const chk = checkNavUrl(x.href)
      if (!chk.ok) ec.err(`messages[${i}].href`, chk.error!)
      else msg.href = chk.value
    }
    return msg
  })
  const enabled = bool(o.enabled, false)
  if (enabled && messages.length === 0) ec.err('messages', 'add at least one message or turn the announcement off')
  const startsAt = parseUtcInstant(o.startsAt)
  const endsAt = parseUtcInstant(o.endsAt)
  if (startsAt === undefined) ec.err('startsAt', 'must be a date and time with a time zone')
  if (endsAt === undefined) ec.err('endsAt', 'must be a date and time with a time zone')
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) ec.err('endsAt', 'must be after the start')
  return done(ec, { enabled, messages, startsAt: startsAt ?? null, endsAt: endsAt ?? null })
}

/** Is the announcement showing at `now`? (UTC instants; pure so it is unit-testable.) */
export function isAnnouncementActive(a: Pick<AnnouncementSnapshot, 'enabled' | 'messages' | 'startsAt' | 'endsAt'>, now: Date): boolean {
  if (!a.enabled || a.messages.length === 0) return false
  const t = now.getTime()
  if (a.startsAt && t < Date.parse(a.startsAt)) return false
  if (a.endsAt && t >= Date.parse(a.endsAt)) return false
  return true
}

// ═══════════════════════════════════════════════════════════════════════════
// NAVIGATION + FOOTER
// ═══════════════════════════════════════════════════════════════════════════

/** Keys of the storefront dictionary (context/I18nContext.tsx) a seeded link may keep using. */
export const I18N_KEYS = [
  'shopAll', 'hoodies', 'sweatpants', 'trackOrder', 'about', 'contact', 'sizeGuide', 'faq', 'shippingReturns',
  'shop', 'support', 'legal', 'privacy', 'terms', 'cookies', 'allRightsReserved',
] as const
export type I18nKey = typeof I18N_KEYS[number]

export interface NavLink { id: string; label: string; href: string; i18nKey?: I18nKey; i18nEn?: string; newTab?: boolean }
export interface NavigationSnapshot { desktop: NavLink[]; mobile: NavLink[] }

/** Links that must always be reachable (matched on the URL path, so labels can change). */
export const REQUIRED_NAV_PATHS = ['/shop', '/contact'] as const
export const REQUIRED_FOOTER_PATHS = ['/shop', '/support/shipping-returns', '/contact', '/privacy', '/terms', '/cookies'] as const

function navLink(ec: Ec, path: string, l: unknown, seen: Set<string>, check: typeof checkNavUrl): NavLink | null {
  const x = isObj(l) ? l : {}
  const chk = check(x.href)
  if (!chk.ok) ec.err(`${path}.href`, chk.error!)
  const out: NavLink = {
    id: idOf(ec, path, x.id, seen),
    label: text(ec, `${path}.label`, x.label, 60, { required: true }),
    href: chk.value ?? '',
  }
  if (typeof x.i18nKey === 'string' && (I18N_KEYS as readonly string[]).includes(x.i18nKey)) {
    out.i18nKey = x.i18nKey as I18nKey
    const en = text(ec, `${path}.i18nEn`, x.i18nEn, 60); if (en) out.i18nEn = en
  }
  if (x.newTab === true) out.newTab = true
  return chk.ok ? out : null
}

export function missingRequiredPaths(links: Array<{ href: string }>, required: readonly string[]): string[] {
  // A filtered link (/shop?type=hoodies) is not the plain page, so only query-less links count.
  const have = new Set(links.filter(l => !/[?#]/.test(l.href)).map(l => normalizeInternalPath(l.href)))
  return required.filter(r => !have.has(r))
}

export function validateNavigation(input: unknown): Validation<NavigationSnapshot> {
  const ec = new Ec(); const o = isObj(input) ? input : {}
  if (!isObj(input)) ec.err('navigation', 'is not valid')
  const seen = new Set<string>()
  const desktop = list(ec, 'desktop', o.desktop, 12, (l, i) => navLink(ec, `desktop[${i}]`, l, seen, checkNavUrl), 1)
  const mobile = list(ec, 'mobile', o.mobile, 20, (l, i) => navLink(ec, `mobile[${i}]`, l, seen, checkNavUrl), 1)
  for (const [name, links] of [['desktop', desktop], ['mobile', mobile]] as const) {
    const miss = missingRequiredPaths(links, REQUIRED_NAV_PATHS)
    if (miss.length) ec.err(name, `must keep required links: ${miss.join(', ')}`)
  }
  return done(ec, { desktop, mobile })
}

export interface FooterGroup { id: string; heading: string; i18nKey?: I18nKey; i18nEn?: string; links: NavLink[] }
export interface FooterSocial { id: string; platform: 'instagram' | 'tiktok' | 'other'; label: string; href: string }
export interface FooterSnapshot {
  brandName: string
  taglines: string[]
  groups: FooterGroup[]
  social: FooterSocial[]
  copyrightHolder: string
  /** Empty = the storefront's translated "All rights reserved." */
  copyrightSuffix: string
}

export function validateFooter(input: unknown): Validation<FooterSnapshot> {
  const ec = new Ec(); const o = isObj(input) ? input : {}
  if (!isObj(input)) ec.err('footer', 'is not valid')
  const gIds = new Set<string>(); const lIds = new Set<string>(); const sIds = new Set<string>()
  const groups = list<FooterGroup>(ec, 'groups', o.groups, 6, (g, i) => {
    const x = isObj(g) ? g : {}
    const grp: FooterGroup = {
      id: idOf(ec, `groups[${i}]`, x.id, gIds),
      heading: text(ec, `groups[${i}].heading`, x.heading, 60, { required: true }),
      links: list(ec, `groups[${i}].links`, x.links, 12, (l, j) => navLink(ec, `groups[${i}].links[${j}]`, l, lIds, checkFooterUrl)),
    }
    if (typeof x.i18nKey === 'string' && (I18N_KEYS as readonly string[]).includes(x.i18nKey)) {
      grp.i18nKey = x.i18nKey as I18nKey
      const en = text(ec, `groups[${i}].i18nEn`, x.i18nEn, 60); if (en) grp.i18nEn = en
    }
    return grp
  }, 1)
  const social = list<FooterSocial>(ec, 'social', o.social, 8, (s, i) => {
    const x = isObj(s) ? s : {}
    const chk = checkNavUrl(x.href)
    if (!chk.ok) ec.err(`social[${i}].href`, chk.error!)
    else if (chk.kind !== 'external') ec.err(`social[${i}].href`, 'must be a full https:// link')
    return {
      id: idOf(ec, `social[${i}]`, x.id, sIds),
      platform: x.platform === 'instagram' || x.platform === 'tiktok' ? x.platform : 'other',
      label: text(ec, `social[${i}].label`, x.label, 60, { required: true }),
      href: chk.value ?? '',
    }
  })
  const all = groups.flatMap(g => g.links)
  const miss = missingRequiredPaths(all, REQUIRED_FOOTER_PATHS)
  if (miss.length) ec.err('groups', `must keep required links: ${miss.join(', ')}`)
  return done(ec, {
    brandName: text(ec, 'brandName', o.brandName, 60, { required: true }),
    taglines: list<string>(ec, 'taglines', o.taglines, 4, (t, i) => text(ec, `taglines[${i}]`, t, 80) || null),
    groups, social,
    copyrightHolder: text(ec, 'copyrightHolder', o.copyrightHolder, 80, { required: true }),
    copyrightSuffix: text(ec, 'copyrightSuffix', o.copyrightSuffix, 200),
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL SEO (site_settings key `seo.global`)
// ═══════════════════════════════════════════════════════════════════════════

export interface GlobalSeo {
  siteName: string
  titleDefault: string
  titleTemplate: string
  description: string
  keywords: string[]
  ogTitle: string
  ogDescription: string
  twitterTitle: string
  twitterDescription: string
  shareImageId?: string
  /** Server-resolved from shareImageId at save time so readers of the raw setting get a usable URL. */
  shareImageUrl?: string
  organization: {
    type: 'ClothingStore' | 'Organization' | 'Store'
    name: string
    url: string
    description: string
    email: string
    sameAs: string[]
    contactType: string
    availableLanguage: string
  }
  /** Per-locale overrides of the text defaults. */
  translations: Record<string, Partial<Pick<GlobalSeo, 'titleDefault' | 'description' | 'ogTitle' | 'ogDescription' | 'twitterTitle' | 'twitterDescription'>>>
}

export const GLOBAL_SEO_KEY = 'seo.global'
const SEO_TEXT_KEYS = ['titleDefault', 'description', 'ogTitle', 'ogDescription', 'twitterTitle', 'twitterDescription'] as const

export function validateGlobalSeo(input: unknown): Validation<GlobalSeo> {
  const ec = new Ec(); const o = isObj(input) ? input : {}
  if (!isObj(input)) ec.err('SEO', 'is not valid')
  const org = isObj(o.organization) ? o.organization : {}
  const orgUrl = checkNavUrl(org.url); if (!orgUrl.ok || orgUrl.kind !== 'external') ec.err('organization.url', 'must be a full https:// link')
  const email = text(ec, 'organization.email', org.email, 120)
  if (email && !/^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+$/.test(email)) ec.err('organization.email', 'is not a valid email address')
  const sameAs = list<string>(ec, 'organization.sameAs', org.sameAs, 10, (u, i) => {
    const c = checkNavUrl(u)
    if (!c.ok || c.kind !== 'external') { ec.err(`organization.sameAs[${i}]`, 'must be a full https:// link'); return null }
    return c.value!
  })
  const tpl = text(ec, 'titleTemplate', o.titleTemplate ?? '%s', 120) || '%s'
  if (!tpl.includes('%s')) ec.err('titleTemplate', 'must contain %s where the page title goes')
  const translations: GlobalSeo['translations'] = {}
  if (isObj(o.translations)) {
    for (const [loc, v] of Object.entries(o.translations)) {
      if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(loc) || !isObj(v)) { ec.err(`translations.${loc}`, 'is not valid'); continue }
      const t: Record<string, string> = {}
      for (const k of SEO_TEXT_KEYS) { const s = text(ec, `translations.${loc}.${k}`, v[k], 320); if (s) t[k] = s }
      if (Object.keys(t).length) translations[loc] = t
    }
  }
  const out: GlobalSeo = {
    siteName: text(ec, 'siteName', o.siteName, 80, { required: true }),
    titleDefault: text(ec, 'titleDefault', o.titleDefault, 120, { required: true }),
    titleTemplate: tpl,
    description: text(ec, 'description', o.description, 320, { required: true }),
    keywords: list<string>(ec, 'keywords', o.keywords, 30, (k, i) => text(ec, `keywords[${i}]`, k, 60) || null),
    ogTitle: text(ec, 'ogTitle', o.ogTitle, 120),
    ogDescription: text(ec, 'ogDescription', o.ogDescription, 320),
    twitterTitle: text(ec, 'twitterTitle', o.twitterTitle, 120),
    twitterDescription: text(ec, 'twitterDescription', o.twitterDescription, 320),
    organization: {
      type: org.type === 'Organization' || org.type === 'Store' ? org.type : 'ClothingStore',
      name: text(ec, 'organization.name', org.name, 80, { required: true }),
      url: orgUrl.value ?? '',
      description: text(ec, 'organization.description', org.description, 320),
      email, sameAs,
      contactType: text(ec, 'organization.contactType', org.contactType ?? 'customer support', 60) || 'customer support',
      availableLanguage: text(ec, 'organization.availableLanguage', org.availableLanguage ?? 'English', 60) || 'English',
    },
    translations,
  }
  const img = uuidOpt(ec, 'shareImageId', o.shareImageId); if (img) out.shareImageId = img
  if (typeof o.shareImageUrl === 'string' && /^\/media\/[0-9a-f]{2}\/[0-9a-f]{64}\/original\.(?:webp|jpg|png|avif|gif)$/.test(o.shareImageUrl)) out.shareImageUrl = o.shareImageUrl
  return done(ec, out)
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPATCH
// ═══════════════════════════════════════════════════════════════════════════

export type AnySnapshot =
  | PolicySnapshot | SizeGuideSnapshot | ContentBlockSnapshot | FaqSnapshot | PageSnapshot | AboutSnapshot
  | ContactSnapshot | SupportPageSnapshot | AnnouncementSnapshot | NavigationSnapshot | FooterSnapshot

export function validateSnapshot(kind: ContentKind, input: unknown, ctx: { entityId?: string } = {}): Validation<AnySnapshot> {
  switch (kind) {
    case 'policies':      return validatePolicy(input, ctx)
    case 'size-guides':   return validateSizeGuide(input)
    case 'blocks':        return validateContentBlock(input)
    case 'faq':           return validateFaq(input)
    case 'pages':         return validatePage(input)
    case 'about':         return validateAbout(input)
    case 'contact':       return validateContact(input)
    case 'support-pages': return validateSupportPage(input)
    case 'announcement':  return validateAnnouncement(input)
    case 'navigation':    return validateNavigation(input)
    case 'footer':        return validateFooter(input)
  }
}

/** Human title for lists/search. */
export function snapshotTitle(kind: ContentKind, s: any): string {
  switch (kind) {
    case 'policies': case 'pages': return s?.title ?? ''
    case 'size-guides': case 'blocks': return s?.name ?? ''
    case 'faq': return s?.heroTitle ?? 'FAQ'
    case 'about': return s?.heroTitle ?? 'About'
    case 'contact': return s?.heroTitle ?? 'Contact'
    case 'support-pages': return s?.heroTitle ?? 'Support page'
    case 'announcement': return 'Announcement bar'
    case 'navigation': return 'Navigation'
    case 'footer': return 'Footer'
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// REFERENCES (media + reusable blocks) — kept truthful in media_usages / usages tables
// ═══════════════════════════════════════════════════════════════════════════

export function mediaRefs(kind: ContentKind, s: any): Array<{ slot: string; assetId: string }> {
  const refs: Array<{ slot: string; assetId: string }> = []
  const add = (slot: string, id?: string) => { if (id) refs.push({ slot, assetId: id }) }
  const addRich = (slot: string, doc?: RichText) => collectMediaIds(doc).forEach((id, i) => add(`${slot}.${i}`, id))
  if (!s) return refs
  if (s.seo?.shareImageId) add('seo.share', s.seo.shareImageId)
  switch (kind) {
    case 'policies': case 'pages': addRich('body', s.body); break
    case 'size-guides': add('image', s.imageAssetId); break
    case 'blocks': addRich('content', s.content); break
    case 'faq':
      for (const c of s.categories ?? []) for (const it of c.items ?? []) addRich(`answer.${it.id}`, it.answer)
      break
    case 'about': add('image', s.imageAssetId); break
    default: break
  }
  return refs
}

export function blockRefs(kind: ContentKind, s: any): string[] {
  if (!s) return []
  const ids = new Set<string>()
  const add = (doc?: RichText) => collectBlockRefs(doc).forEach(i => ids.add(i))
  if (kind === 'policies' || kind === 'pages') add(s.body)
  if (kind === 'faq') for (const c of s.categories ?? []) for (const it of c.items ?? []) add(it.answer)
  return [...ids]
}

// ═══════════════════════════════════════════════════════════════════════════
// TRANSLATABLE SLOTS — one definition used for completeness AND for localizing a snapshot
// ═══════════════════════════════════════════════════════════════════════════

export interface Slot { field: string; get(): string; set(v: string): void; rich?: boolean; ref?: boolean }

function strSlot(obj: any, key: string, field = key): Slot {
  return { field, get: () => (typeof obj?.[key] === 'string' ? obj[key] : ''), set: v => { obj[key] = v } }
}
function richSlot(obj: any, key: string, field = key): Slot {
  return {
    field, rich: true,
    get: () => (isRichTextEmpty(obj?.[key]) ? '' : JSON.stringify(obj[key])),
    set: v => {
      try {
        const r = validateRichText(JSON.parse(v), { allowBlockRefs: true })
        if (r.ok) obj[key] = r.value
      } catch { /* invalid translation JSON: keep the source */ }
    },
  }
}

/** Slots over a (cloned) snapshot object. Rich-text slots serialise to / from JSON text. */
export function slotsOf(kind: ContentKind, snap: any): Slot[] {
  if (!snap) return []
  const s: Slot[] = []
  const seo = (o: any) => { if (o.seo) { s.push(strSlot(o.seo, 'title', 'seoTitle'), strSlot(o.seo, 'description', 'seoDescription'), strSlot(o.seo, 'shareTitle', 'seoShareTitle')) } }
  switch (kind) {
    case 'policies':
      s.push(strSlot(snap, 'title'), strSlot(snap, 'heroTitle'), strSlot(snap, 'heroBreadcrumb'), strSlot(snap, 'lastUpdatedLabel'), richSlot(snap, 'body'))
      seo(snap); break
    case 'pages':
      s.push(strSlot(snap, 'title'), strSlot(snap, 'subtitle'), richSlot(snap, 'body')); seo(snap); break
    case 'size-guides':
      s.push(strSlot(snap, 'name'), strSlot(snap, 'garment'), strSlot(snap, 'rowHeader'), richSlot(snap, 'fit'), strSlot(snap, 'imageAlt'))
      if (snap.shopLink) s.push(strSlot(snap.shopLink, 'label', 'shopLink'))
      ;(snap.columns ?? []).forEach((c: any) => s.push(strSlot(c, 'label', `col.${c.id}`)))
      ;(snap.notes ?? []).forEach((_: string, i: number) => s.push(strSlot(snap.notes, String(i), `note.${i}`)))
      break
    case 'blocks':
      s.push(strSlot(snap, 'name'), richSlot(snap, 'content')); break
    case 'faq':
      s.push(strSlot(snap, 'heroTitle'), strSlot(snap, 'footerTitle'), richSlot(snap, 'footerBody'))
      for (const c of snap.categories ?? []) {
        s.push(strSlot(c, 'heading', `cat.${c.id}`))
        for (const it of c.items ?? []) { s.push(strSlot(it, 'question', `q.${it.id}`), richSlot(it, 'answer', `a.${it.id}`)) }
      }
      seo(snap); break
    case 'about':
      s.push(strSlot(snap, 'heroTitle'), strSlot(snap, 'brandEyebrow'), strSlot(snap, 'lead'), strSlot(snap, 'approachEyebrow'),
        strSlot(snap, 'ctaLabel'), strSlot(snap, 'imageAlt'))
      ;(snap.brandParagraphs ?? []).forEach((_: string, i: number) => s.push(strSlot(snap.brandParagraphs, String(i), `para.${i}`)))
      for (const a of snap.approach ?? []) s.push(strSlot(a, 'title', `ap.${a.id}.title`), strSlot(a, 'description', `ap.${a.id}.desc`))
      seo(snap); break
    case 'contact':
      s.push(strSlot(snap, 'heroTitle'), strSlot(snap, 'intro'), strSlot(snap, 'successTitle'), strSlot(snap, 'successBody'),
        strSlot(snap, 'supportHours'), strSlot(snap, 'helpNote')); seo(snap); break
    case 'support-pages':
      s.push(strSlot(snap, 'heroTitle'), strSlot(snap, 'intro'), richSlot(snap, 'tip'))
      for (const l of snap.links ?? []) s.push(strSlot(l, 'label', `link.${l.id}`))
      seo(snap); break
    case 'announcement':
      for (const m of snap.messages ?? []) s.push(strSlot(m, 'text', `msg.${m.id}`))
      break
    case 'navigation':
      for (const l of [...(snap.desktop ?? []), ...(snap.mobile ?? [])]) s.push(strSlot(l, 'label', `link.${l.id}`))
      break
    case 'footer':
      s.push(strSlot(snap, 'copyrightSuffix'))
      ;(snap.taglines ?? []).forEach((_: string, i: number) => s.push(strSlot(snap.taglines, String(i), `tag.${i}`)))
      for (const g of snap.groups ?? []) {
        s.push(strSlot(g, 'heading', `group.${g.id}`))
        for (const l of g.links ?? []) s.push(strSlot(l, 'label', `link.${l.id}`))
      }
      for (const so of snap.social ?? []) s.push(strSlot(so, 'label', `social.${so.id}`))
      break
  }
  return s
}

/** Source-language text per translatable field (empty fields omitted). */
export function translatableFields(kind: ContentKind, snapshot: unknown): Record<string, string> {
  const clone = snapshot ? JSON.parse(JSON.stringify(snapshot)) : null
  const out: Record<string, string> = {}
  for (const sl of slotsOf(kind, clone)) {
    const v = sl.get()
    if (v && v.trim()) out[sl.field] = v
  }
  return out
}

/** A copy of the snapshot with translated field values applied (only the values given). */
export function localizeSnapshot<T>(kind: ContentKind, snapshot: T, values: Record<string, string>): T {
  const clone = JSON.parse(JSON.stringify(snapshot))
  for (const sl of slotsOf(kind, clone)) {
    const v = values[sl.field]
    if (typeof v === 'string' && v.trim()) sl.set(v)
  }
  return clone
}

/** Plain text of a field value for display in the Admin translation panel. */
export function previewFieldValue(v: string): string {
  if (v.startsWith('{"v":1')) {
    try { return richTextToPlain(JSON.parse(v)).slice(0, 200) } catch { /* fallthrough */ }
  }
  return v.slice(0, 200)
}
