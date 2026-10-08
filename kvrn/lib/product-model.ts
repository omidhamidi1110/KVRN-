// lib/product-model.ts — the Product Editor snapshot: types, sanitising parser, small pure helpers.
//
// The snapshot is the PRESENTATION + INTENT record stored (immutably, per version) in
// content_versions (entity_type='product'). Commerce truth stays in products/product_variants:
// `commerce` here is the intent applied to those tables at publish time, never a second source
// of truth (the storefront always reads price from products.price_cents).
//
// Pure + client-safe: no database, no Node-only imports. The SQL twin of the rules lives in
// db/migrations/028_product_catalog_cms.sql (catalog_product_blockers); the parser here only
// rejects malformed/over-long INPUT so a draft can be stored safely — it never decides whether
// a product may go live.
import { parseBundleInput, type BundleConfig } from './bundle-model'

export const SNAPSHOT_SCHEMA = 1
export const GALLERY_SIZE = 5

export const LIMITS = {
  name: 120, eyebrow: 60, shortDescription: 300, description: 4000, fitNote: 300, founderNote: 300,
  detailLine: 200, detailLines: 12, featureTitle: 80, featureText: 300, features: 12,
  specLabel: 60, specValue: 200, specs: 24, shippingLine: 300, shippingLines: 8,
  slug: 80, productType: 40, alt: 500, colors: 24, variants: 300, size: 20, sku: 60,
  seoTitle: 200, seoDescription: 500, url: 500, ogTitle: 200, ogDescription: 500, body: 8000, note: 200,
} as const

/** Guidance thresholds: warn, never truncate (spec: "warn rather than silently truncate"). */
export const GUIDANCE = {
  name: 60, eyebrow: 40, founderNote: 120, fitNote: 140, detailLine: 70, seoTitle: 70, seoDescription: 170,
} as const

export interface Focal { x: number; y: number }
export type ImageRef = { kind: 'media'; assetId: string } | { kind: 'static'; src: string }
export interface FocalPair { mobile: Focal | null; desktop: Focal | null }
export interface ImageSlot { ref: ImageRef | null; alt: string; focal: FocalPair }
export interface ColorMedia { hero: ImageSlot; gallery: ImageSlot[] }
export interface ColorDef { key: string; code: string; name: string; hex: string; media: ColorMedia | null }
export interface VariantDef { id: string | null; sku: string; colorCode: string; size: string; sizeSort: number; active: boolean }
export interface ShippingDims { weightLb: number | null; lengthIn: number | null; widthIn: number | null; heightIn: number | null }
export interface FeatureDef { title: string; description: string }
export interface SpecDef { label: string; value: string }

export type DefaultOrOverride = 'global' | 'override'
export interface SnapshotSections {
  description: boolean; details: boolean; shippingReturns: boolean; sizeGuideLink: boolean; stickyAddToBag: boolean
}

export interface ProductSnapshot {
  schema: number
  slug: string
  name: string
  eyebrow: string | null
  productType: string
  presentation: 'standard'
  founderNote: string | null
  shortDescription: string
  constructionDetails: string[]
  description: string
  fitNote: string | null
  features: FeatureDef[]
  specs: SpecDef[]
  shippingReturns: { mode: DefaultOrOverride; lines: string[] }
  sizeGuide: { mode: 'global' | 'library' | 'override'; entityId: string | null; body: string | null }
  sections: SnapshotSections
  media: { hero: ImageSlot | null; gallery: ImageSlot[] }
  colors: ColorDef[]
  commerce: {
    priceCents: number | null
    shipping: ShippingDims
    originCountry: string | null
    hsCode: string | null
    variants: VariantDef[]
  }
  shop: { listed: boolean; sortPosition: number }
  completeTheSet: { enabled: boolean; pairedProductId: string | null }
  /** Bundle / Complete the Set definition (lib/bundle-model.ts). null = no bundle configured. */
  bundle: BundleConfig | null
  seo: {
    title: string; description: string; canonicalUrl: string | null
    ogTitle: string | null; ogDescription: string | null; ogImage: ImageRef | null
  }
}

// ── small validators (shared by parser, API and UI) ───────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const isValidSlug = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= LIMITS.slug && SLUG_RE.test(v)

/** Sensible URL slug from a product name: lowercase, ASCII, hyphen-separated, max 80. */
export function slugify(input: string): string {
  const s = (input ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.slug).replace(/-+$/g, '')
  return s
}

const STATIC_SRC_RE = /^\/images\/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/
export const isStaticImageSrc = (v: unknown): v is string => typeof v === 'string' && STATIC_SRC_RE.test(v) && !v.includes('..')

const HS_RE = /^[0-9]{4}[.]?[0-9]{2}([.]?[0-9]{2}){0,2}$/
export type FieldCheck = { ok: true; value: string | null } | { ok: false; error: string }

/** Country of origin: optional; ISO-3166 alpha-2 (US, VN…). Never invented, never defaulted. */
export function validateCountryCode(raw: unknown): FieldCheck {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  const v = String(raw).trim().toUpperCase()
  if (v === '') return { ok: true, value: null }
  return /^[A-Z]{2}$/.test(v) ? { ok: true, value: v } : { ok: false, error: 'Use a 2-letter country code, e.g. US.' }
}

/** HS / tariff code: optional; 6–10 digits, dots optional (6110.20, 6110.20.20, 611020). */
export function validateHsCode(raw: unknown): FieldCheck {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  const v = String(raw).trim()
  if (v === '') return { ok: true, value: null }
  return HS_RE.test(v) ? { ok: true, value: v } : { ok: false, error: 'HS code needs 6–10 digits, dots optional (e.g. 6110.20).' }
}

export const HEX_RE = /^#[0-9A-Fa-f]{6}$/
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX_RE.test(v)

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
export function parseFocal(v: unknown): Focal | null {
  if (!v || typeof v !== 'object') return null
  const { x, y } = v as Record<string, unknown>
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null
  // Round to 3 decimals: enough precision for a crop, keeps snapshots tidy.
  return { x: Math.round(clamp01(x) * 1000) / 1000, y: Math.round(clamp01(y) * 1000) / 1000 }
}

// ── empty / default snapshot ──────────────────────────────────────────────────

export function emptySlot(): ImageSlot { return { ref: null, alt: '', focal: { mobile: null, desktop: null } } }

export function emptySnapshot(init: Partial<Pick<ProductSnapshot, 'name' | 'slug' | 'productType'>> = {}): ProductSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    slug: init.slug ?? '',
    name: init.name ?? '',
    eyebrow: null,
    productType: init.productType ?? '',
    presentation: 'standard',
    founderNote: null,
    shortDescription: '',
    constructionDetails: [],
    description: '',
    fitNote: null,
    features: [],
    specs: [],
    shippingReturns: { mode: 'global', lines: [] },
    sizeGuide: { mode: 'global', entityId: null, body: null },
    sections: { description: true, details: true, shippingReturns: true, sizeGuideLink: true, stickyAddToBag: true },
    media: { hero: null, gallery: [] },
    colors: [],
    commerce: {
      priceCents: null,
      shipping: { weightLb: null, lengthIn: null, widthIn: null, heightIn: null },
      originCountry: null, hsCode: null, variants: [],
    },
    shop: { listed: true, sortPosition: 0 },
    completeTheSet: { enabled: false, pairedProductId: null },
    bundle: null,
    seo: { title: '', description: '', canonicalUrl: null, ogTitle: null, ogDescription: null, ogImage: null },
  }
}

// ── input parser: coerce untrusted JSON into a well-formed snapshot or list errors ─

export type ParseResult = { ok: true; snapshot: ProductSnapshot } | { ok: false; errors: string[] }

type Ctx = { errors: string[] }
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function str(ctx: Ctx, v: unknown, path: string, max: number, fallback = ''): string {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'string') { ctx.errors.push(`${path} must be text.`); return fallback }
  const t = v.replace(/\r\n/g, '\n').trim()
  if (t.length > max) { ctx.errors.push(`${path} is longer than ${max} characters.`); return t.slice(0, max) }
  return t
}
const strOrNull = (ctx: Ctx, v: unknown, path: string, max: number): string | null => {
  const s = str(ctx, v, path, max, '')
  return s === '' ? null : s
}
function bool(ctx: Ctx, v: unknown, path: string, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'boolean') { ctx.errors.push(`${path} must be true or false.`); return fallback }
  return v
}
function int(ctx: Ctx, v: unknown, path: string, min: number, max: number, fallback: number | null): number | null {
  if (v === undefined || v === null || v === '') return fallback
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    ctx.errors.push(`${path} must be a whole number between ${min} and ${max}.`); return fallback
  }
  return v
}
function num(ctx: Ctx, v: unknown, path: string, min: number, max: number): number | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    ctx.errors.push(`${path} must be a number between ${min} and ${max}.`); return null
  }
  return v
}
function arr(ctx: Ctx, v: unknown, path: string, max: number): unknown[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) { ctx.errors.push(`${path} must be a list.`); return [] }
  if (v.length > max) { ctx.errors.push(`${path} has more than ${max} items.`); return v.slice(0, max) }
  return v
}

function parseRef(ctx: Ctx, v: unknown, path: string): ImageRef | null {
  if (v === undefined || v === null) return null
  if (!isObj(v)) { ctx.errors.push(`${path} is not a valid image reference.`); return null }
  if (v.kind === 'media') {
    if (!isUuid(v.assetId)) { ctx.errors.push(`${path} has an invalid media id.`); return null }
    return { kind: 'media', assetId: v.assetId.toLowerCase() }
  }
  if (v.kind === 'static') {
    if (!isStaticImageSrc(v.src)) { ctx.errors.push(`${path} has an invalid image path.`); return null }
    return { kind: 'static', src: v.src }
  }
  ctx.errors.push(`${path} is not a valid image reference.`)
  return null
}

function parseSlot(ctx: Ctx, v: unknown, path: string): ImageSlot {
  if (v === undefined || v === null) return emptySlot()
  if (!isObj(v)) { ctx.errors.push(`${path} is not a valid image slot.`); return emptySlot() }
  const f = isObj(v.focal) ? v.focal : {}
  const slot: ImageSlot = {
    ref: parseRef(ctx, v.ref, `${path}.ref`),
    alt: str(ctx, v.alt, `${path}.alt`, LIMITS.alt),
    focal: { mobile: parseFocal(f.mobile), desktop: parseFocal(f.desktop) },
  }
  for (const d of ['mobile', 'desktop'] as const) {
    if (f[d] !== undefined && f[d] !== null && slot.focal[d] === null) ctx.errors.push(`${path}.focal.${d} is not a valid point.`)
  }
  return slot
}

export function parseSnapshotInput(raw: unknown): ParseResult {
  const ctx: Ctx = { errors: [] }
  if (!isObj(raw)) return { ok: false, errors: ['The product data is not valid.'] }
  const base = emptySnapshot()
  const o = raw

  const slugRaw = str(ctx, o.slug, 'slug', LIMITS.slug).toLowerCase()
  const s: ProductSnapshot = {
    ...base,
    slug: slugRaw,
    name: str(ctx, o.name, 'name', LIMITS.name),
    eyebrow: strOrNull(ctx, o.eyebrow, 'eyebrow', LIMITS.eyebrow),
    productType: str(ctx, o.productType, 'productType', LIMITS.productType).toLowerCase(),
    founderNote: strOrNull(ctx, o.founderNote, 'founderNote', LIMITS.founderNote),
    shortDescription: str(ctx, o.shortDescription, 'shortDescription', LIMITS.shortDescription),
    description: str(ctx, o.description, 'description', LIMITS.description),
    fitNote: strOrNull(ctx, o.fitNote, 'fitNote', LIMITS.fitNote),
  }
  if (slugRaw && !isValidSlug(slugRaw)) ctx.errors.push('slug can use lowercase letters, numbers and hyphens only.')
  if (s.productType && !SLUG_RE.test(s.productType)) ctx.errors.push('productType can use lowercase letters, numbers and hyphens only.')

  s.constructionDetails = arr(ctx, o.constructionDetails, 'constructionDetails', LIMITS.detailLines)
    .map((x, i) => str(ctx, x, `constructionDetails.${i + 1}`, LIMITS.detailLine)).filter(Boolean)
  s.features = arr(ctx, o.features, 'features', LIMITS.features).map((x, i) => {
    const f = isObj(x) ? x : {}
    return { title: str(ctx, f.title, `features.${i + 1}.title`, LIMITS.featureTitle), description: str(ctx, f.description, `features.${i + 1}.description`, LIMITS.featureText) }
  }).filter(f => f.title || f.description)
  s.specs = arr(ctx, o.specs, 'specs', LIMITS.specs).map((x, i) => {
    const f = isObj(x) ? x : {}
    return { label: str(ctx, f.label, `specs.${i + 1}.label`, LIMITS.specLabel), value: str(ctx, f.value, `specs.${i + 1}.value`, LIMITS.specValue) }
  }).filter(f => f.label || f.value)

  const sr = isObj(o.shippingReturns) ? o.shippingReturns : {}
  s.shippingReturns = {
    mode: sr.mode === 'override' ? 'override' : 'global',
    lines: arr(ctx, sr.lines, 'shippingReturns.lines', LIMITS.shippingLines).map((x, i) => str(ctx, x, `shippingReturns.lines.${i + 1}`, LIMITS.shippingLine)).filter(Boolean),
  }
  const sg = isObj(o.sizeGuide) ? o.sizeGuide : {}
  s.sizeGuide = {
    mode: sg.mode === 'override' ? 'override' : sg.mode === 'library' ? 'library' : 'global',
    entityId: sg.entityId === null || sg.entityId === undefined || sg.entityId === '' ? null : (typeof sg.entityId === 'string' && sg.entityId.length <= 100 ? sg.entityId : (ctx.errors.push('sizeGuide.entityId is not valid.'), null)),
    body: strOrNull(ctx, sg.body, 'sizeGuide.body', LIMITS.body),
  }
  const se = isObj(o.sections) ? o.sections : {}
  s.sections = {
    description: bool(ctx, se.description, 'sections.description', true),
    details: bool(ctx, se.details, 'sections.details', true),
    shippingReturns: bool(ctx, se.shippingReturns, 'sections.shippingReturns', true),
    sizeGuideLink: bool(ctx, se.sizeGuideLink, 'sections.sizeGuideLink', true),
    stickyAddToBag: bool(ctx, se.stickyAddToBag, 'sections.stickyAddToBag', true),
  }

  const m = isObj(o.media) ? o.media : {}
  s.media = {
    hero: m.hero === null || m.hero === undefined ? null : parseSlot(ctx, m.hero, 'media.hero'),
    gallery: arr(ctx, m.gallery, 'media.gallery', GALLERY_SIZE).map((x, i) => parseSlot(ctx, x, `media.gallery.${i + 1}`)),
  }

  s.colors = arr(ctx, o.colors, 'colors', LIMITS.colors).map((x, i) => {
    const c = isObj(x) ? x : {}
    const cm = isObj(c.media) ? c.media : null
    return {
      key: str(ctx, c.key, `colors.${i + 1}.key`, 40).toLowerCase(),
      code: str(ctx, c.code, `colors.${i + 1}.code`, 6).toUpperCase(),
      name: str(ctx, c.name, `colors.${i + 1}.name`, 40),
      hex: str(ctx, c.hex, `colors.${i + 1}.hex`, 7),
      media: cm ? {
        hero: parseSlot(ctx, cm.hero, `colors.${i + 1}.media.hero`),
        gallery: arr(ctx, cm.gallery, `colors.${i + 1}.media.gallery`, GALLERY_SIZE).map((g, j) => parseSlot(ctx, g, `colors.${i + 1}.media.gallery.${j + 1}`)),
      } : null,
    }
  })

  const c = isObj(o.commerce) ? o.commerce : {}
  const sh = isObj(c.shipping) ? c.shipping : {}
  const origin = validateCountryCode(c.originCountry)
  const hs = validateHsCode(c.hsCode)
  if (!origin.ok) ctx.errors.push(`commerce.originCountry: ${origin.error}`)
  if (!hs.ok) ctx.errors.push(`commerce.hsCode: ${hs.error}`)
  s.commerce = {
    priceCents: int(ctx, c.priceCents, 'commerce.priceCents', 1, 1_000_000, null),
    shipping: {
      weightLb: num(ctx, sh.weightLb, 'commerce.shipping.weightLb', 0.01, 150),
      lengthIn: num(ctx, sh.lengthIn, 'commerce.shipping.lengthIn', 0.1, 120),
      widthIn: num(ctx, sh.widthIn, 'commerce.shipping.widthIn', 0.1, 120),
      heightIn: num(ctx, sh.heightIn, 'commerce.shipping.heightIn', 0.1, 120),
    },
    originCountry: origin.ok ? origin.value : null,
    hsCode: hs.ok ? hs.value : null,
    variants: arr(ctx, c.variants, 'commerce.variants', LIMITS.variants).map((x, i) => {
      const v = isObj(x) ? x : {}
      return {
        id: v.id === null || v.id === undefined || v.id === '' ? null : (isUuid(v.id) ? v.id.toLowerCase() : (ctx.errors.push(`commerce.variants.${i + 1}.id is not valid.`), null)),
        sku: str(ctx, v.sku, `commerce.variants.${i + 1}.sku`, LIMITS.sku).toUpperCase(),
        colorCode: str(ctx, v.colorCode, `commerce.variants.${i + 1}.colorCode`, 6).toUpperCase(),
        size: str(ctx, v.size, `commerce.variants.${i + 1}.size`, LIMITS.size),
        sizeSort: int(ctx, v.sizeSort, `commerce.variants.${i + 1}.sizeSort`, 0, 999, 0) ?? 0,
        active: bool(ctx, v.active, `commerce.variants.${i + 1}.active`, true),
      }
    }),
  }

  const sp = isObj(o.shop) ? o.shop : {}
  s.shop = { listed: bool(ctx, sp.listed, 'shop.listed', true), sortPosition: int(ctx, sp.sortPosition, 'shop.sortPosition', -9999, 9999, 0) ?? 0 }

  const ct = isObj(o.completeTheSet) ? o.completeTheSet : {}
  const pair = ct.pairedProductId === null || ct.pairedProductId === undefined || ct.pairedProductId === '' ? null
    : (isUuid(ct.pairedProductId) ? ct.pairedProductId.toLowerCase() : (ctx.errors.push('completeTheSet.pairedProductId is not valid.'), null))
  s.completeTheSet = { enabled: bool(ctx, ct.enabled, 'completeTheSet.enabled', false), pairedProductId: pair }

  // Bundle / Complete the Set (lib/bundle-model.ts): sanitised here; whether it may go live is decided
  // by bundle_blockers() in the database at publish.
  const bp = parseBundleInput(o.bundle)
  if (bp.ok) s.bundle = bp.bundle
  else ctx.errors.push(...bp.errors)

  const seo = isObj(o.seo) ? o.seo : {}
  const canon = strOrNull(ctx, seo.canonicalUrl, 'seo.canonicalUrl', LIMITS.url)
  if (canon && !/^https:\/\/[^\s]+$/.test(canon)) ctx.errors.push('seo.canonicalUrl must be a full https:// URL.')
  s.seo = {
    title: str(ctx, seo.title, 'seo.title', LIMITS.seoTitle),
    description: str(ctx, seo.description, 'seo.description', LIMITS.seoDescription),
    canonicalUrl: canon,
    ogTitle: strOrNull(ctx, seo.ogTitle, 'seo.ogTitle', LIMITS.ogTitle),
    ogDescription: strOrNull(ctx, seo.ogDescription, 'seo.ogDescription', LIMITS.ogDescription),
    ogImage: parseRef(ctx, seo.ogImage, 'seo.ogImage'),
  }

  return ctx.errors.length ? { ok: false, errors: [...new Set(ctx.errors)] } : { ok: true, snapshot: s }
}

// ── derived helpers ───────────────────────────────────────────────────────────

/** Customer-facing colour selector: only when there are two or more colours. */
export const colorSelectorVisible = (colors: ReadonlyArray<unknown>) => colors.length > 1

/** Image `type` is positional (kept for the coded template's front/back lookups). */
export function imageTypeAt(index: number): 'front' | 'back' | 'detail' {
  return index === 0 ? 'front' : index === 1 ? 'back' : 'detail'
}

export interface MediaUsageRef { slot: string; assetId: string }

/** Media assets a snapshot references, as usage slots (twin of catalog_media_refs in SQL). */
export function snapshotMediaRefs(s: ProductSnapshot): MediaUsageRef[] {
  const out: MediaUsageRef[] = []
  const push = (slot: string, ref: ImageRef | null | undefined) => {
    if (ref && ref.kind === 'media' && isUuid(ref.assetId)) out.push({ slot, assetId: ref.assetId.toLowerCase() })
  }
  push('hero', s.media.hero?.ref)
  s.media.gallery.forEach((g, i) => push(`gallery-${i + 1}`, g.ref))
  s.colors.forEach((c, ci) => {
    if (!c.media) return
    push(`colors-${ci + 1}-media-hero`, c.media.hero.ref)
    c.media.gallery.forEach((g, j) => push(`colors-${ci + 1}-media-gallery-${j + 1}`, g.ref))
  })
  push('seo-og', s.seo.ogImage)
  return out
}

/** Every distinct media asset id in a snapshot (for URL resolution). */
export const snapshotAssetIds = (s: ProductSnapshot): string[] => [...new Set(snapshotMediaRefs(s).map(r => r.assetId))]

export interface Guidance { field: string; message: string }

/** Instant, client-side length guidance. The server returns the same kind of warning. */
export function contentGuidance(s: ProductSnapshot): Guidance[] {
  const g: Guidance[] = []
  if (s.name.length > GUIDANCE.name) g.push({ field: 'name', message: `Names over ${GUIDANCE.name} characters may wrap awkwardly. Check the preview.` })
  if ((s.eyebrow ?? '').length > GUIDANCE.eyebrow) g.push({ field: 'eyebrow', message: 'Eyebrow is long. Check the preview.' })
  if ((s.founderNote ?? '').length > GUIDANCE.founderNote) g.push({ field: 'founderNote', message: 'Pricing message is long. Check the preview.' })
  if ((s.fitNote ?? '').length > GUIDANCE.fitNote) g.push({ field: 'fitNote', message: 'Fit note is long. Check the preview.' })
  s.constructionDetails.slice(0, 3).forEach((l, i) => {
    if (l.length > GUIDANCE.detailLine) g.push({ field: `constructionDetails.${i + 1}`, message: `Detail line ${i + 1} appears in the hero. Over ${GUIDANCE.detailLine} characters may wrap.` })
  })
  if (s.seo.title.length > GUIDANCE.seoTitle) g.push({ field: 'seo.title', message: `Search titles over ${GUIDANCE.seoTitle} characters may be cut off.` })
  if (s.seo.description.length > GUIDANCE.seoDescription) g.push({ field: 'seo.description', message: `Search descriptions over ${GUIDANCE.seoDescription} characters may be cut off.` })
  return g
}

/**
 * Snapshot for a DUPLICATE: copies presentation, section configuration and media REFERENCES
 * (never binaries) under a new identity. Does NOT copy: SKUs / variant ids (every variant must
 * get a new SKU before publish), pairing, schedule, inventory, costs, orders. Starts as a draft.
 */
export function snapshotForDuplicate(src: ProductSnapshot, init: { name: string; slug: string }): ProductSnapshot {
  const copy: ProductSnapshot = JSON.parse(JSON.stringify(src))
  copy.name = init.name
  copy.slug = init.slug
  copy.commerce.variants = copy.commerce.variants.map(v => ({ ...v, id: null, sku: '' }))
  copy.completeTheSet = { enabled: false, pairedProductId: null }
  // A bundle definition is never copied: one product, one definition (a copy would create a second,
  // conflicting definition of the same set). Re-create it on the new product if wanted.
  copy.bundle = null
  copy.seo = { ...copy.seo, canonicalUrl: null }
  return copy
}

export const PRODUCT_TRANSLATABLE_FIELDS = [
  'name', 'eyebrow', 'founderNote', 'shortDescription', 'description', 'fitNote', 'seo.title', 'seo.description',
] as const

/** Source-language text per translatable field (for lib/translations resolve/completeness). */
export function translatableSource(s: ProductSnapshot): Record<string, string> {
  return {
    name: s.name, eyebrow: s.eyebrow ?? '', founderNote: s.founderNote ?? '', shortDescription: s.shortDescription,
    description: s.description, fitNote: s.fitNote ?? '', 'seo.title': s.seo.title, 'seo.description': s.seo.description,
  }
}
