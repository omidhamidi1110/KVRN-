// lib/affiliate-application-input.ts — PURE input rules for the public affiliate application.
// Safe to import from client components (no server imports). The database re-checks the
// non-negotiable rules (18+, consents, country, document versions); this module gives clear
// field errors and canonicalises emails and social profile URLs.

export const SOCIAL_PLATFORMS = [
  'instagram', 'tiktok', 'youtube', 'x', 'facebook', 'twitch', 'pinterest', 'snapchat', 'linkedin', 'threads', 'bluesky', 'other',
] as const
export type SocialPlatform = typeof SOCIAL_PLATFORMS[number]

export interface SocialLink {
  platform: SocialPlatform
  /** Canonical https URL (no query/fragment/trailing slash). Only https is ever stored. */
  url: string
  handle: string
  /** `platform:handle` — the duplicate-detection key. */
  key: string
}

export const LIMITS = {
  name: 100, email: 254, state: 80, website: 300, category: 80, heardAbout: 200,
  longText: 2000, minLongText: 20, maxSocials: 5, maxAudience: 2_000_000_000,
} as const

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/

const HOSTS: Array<{ platform: SocialPlatform; hosts: string[]; canonical: string }> = [
  { platform: 'instagram', hosts: ['instagram.com', 'instagr.am'], canonical: 'instagram.com' },
  { platform: 'tiktok', hosts: ['tiktok.com'], canonical: 'tiktok.com' },
  { platform: 'youtube', hosts: ['youtube.com', 'youtu.be'], canonical: 'youtube.com' },
  { platform: 'x', hosts: ['x.com', 'twitter.com'], canonical: 'x.com' },
  { platform: 'facebook', hosts: ['facebook.com', 'fb.com'], canonical: 'facebook.com' },
  { platform: 'twitch', hosts: ['twitch.tv'], canonical: 'twitch.tv' },
  { platform: 'pinterest', hosts: ['pinterest.com'], canonical: 'pinterest.com' },
  { platform: 'snapchat', hosts: ['snapchat.com'], canonical: 'snapchat.com' },
  { platform: 'linkedin', hosts: ['linkedin.com'], canonical: 'linkedin.com' },
  { platform: 'threads', hosts: ['threads.net', 'threads.com'], canonical: 'threads.net' },
  { platform: 'bluesky', hosts: ['bsky.app'], canonical: 'bsky.app' },
]

/** Strip control characters and collapse whitespace. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max)
}

export function normalizeEmail(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

/** Mirrors the SQL affiliate_email_dedupe_key(): strips +tags and Gmail dots. */
export function emailDedupeKey(v: unknown): string {
  const e = normalizeEmail(v)
  const at = e.indexOf('@')
  if (at < 0) return e
  let local = e.slice(0, at).split('+')[0]
  let domain = e.slice(at + 1)
  if (domain === 'gmail.com' || domain === 'googlemail.com') { local = local.replace(/\./g, ''); domain = 'gmail.com' }
  return `${local}@${domain}`
}

export function isEmailShape(v: string): boolean {
  return v.length <= LIMITS.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
}

function stripHost(h: string): string {
  return h.toLowerCase().replace(/^(www|m|mobile|web)\./, '')
}

/** A public https URL on a real hostname (no credentials, no IP literal, no localhost). */
export function parsePublicHttpsUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (!s || s.length > 500) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) return null // javascript:, data:, mailto: ...
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  let u: URL
  try { u = new URL(s) } catch { return null }
  if (u.username || u.password) return null
  const host = u.hostname.toLowerCase()
  if (!host.includes('.') || host === 'localhost' || /^[0-9.]+$/.test(host) || host.includes(':') || host.endsWith('.local') || host.endsWith('.internal')) return null
  if (!/^[a-z0-9.-]+$/.test(host)) return null
  return u
}

function firstSegment(path: string[]): string | null {
  const reserved = new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'watch', 'shorts', 'hashtag', 'share', 'intent', 'i', 'home', 'search', 'login'])
  for (const raw of path) {
    const seg = raw.replace(/^@/, '').toLowerCase()
    if (seg && !reserved.has(seg)) return seg
    if (reserved.has(seg)) return null
  }
  return null
}

/**
 * Canonicalise a social profile URL. Returns null when it is not a usable profile link.
 * Unknown hosts are accepted as platform 'other' (keyed by host+path) so a personal site or
 * link-in-bio page still works but is never mistaken for a known platform.
 */
export function canonicalizeSocialUrl(raw: unknown): SocialLink | null {
  const u = parsePublicHttpsUrl(raw)
  if (!u) return null
  const host = stripHost(u.hostname)
  const segs = u.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s))
  const known = HOSTS.find(h => h.hosts.includes(host))
  if (!known) {
    const path = segs.join('/').toLowerCase()
    const handle = (host + (path ? `/${path}` : '')).slice(0, 120)
    return { platform: 'other', url: `https://${host}${path ? `/${path}` : ''}`, handle, key: `other:${handle}` }
  }
  let handle: string | null = null
  let urlPath = ''
  switch (known.platform) {
    case 'youtube':
      if (host === 'youtu.be') return null
      if (segs[0]?.startsWith('@')) { handle = segs[0].slice(1).toLowerCase(); urlPath = `/@${handle}` }
      else if (['c', 'channel', 'user'].includes(segs[0]) && segs[1]) { handle = `${segs[0]}/${segs[1]}`.toLowerCase(); urlPath = `/${segs[0]}/${segs[1]}` }
      break
    case 'tiktok':
      if (segs[0]?.startsWith('@')) { handle = segs[0].slice(1).toLowerCase(); urlPath = `/@${handle}` }
      break
    case 'linkedin':
      if (['in', 'company'].includes(segs[0]) && segs[1]) { handle = `${segs[0]}/${segs[1]}`.toLowerCase(); urlPath = `/${segs[0]}/${segs[1]}` }
      break
    case 'snapchat':
      if (segs[0] === 'add' && segs[1]) { handle = segs[1].toLowerCase(); urlPath = `/add/${handle}` }
      break
    case 'threads':
      if (segs[0]?.startsWith('@')) { handle = segs[0].slice(1).toLowerCase(); urlPath = `/@${handle}` }
      break
    case 'bluesky':
      if (segs[0] === 'profile' && segs[1]) { handle = segs[1].toLowerCase(); urlPath = `/profile/${handle}` }
      break
    default: {
      handle = firstSegment(segs)
      if (handle) urlPath = `/${handle}`
    }
  }
  if (!handle || !/^[a-z0-9._/-]{1,80}$/.test(handle)) return null
  return { platform: known.platform, url: `https://${known.canonical}${urlPath}`, handle, key: `${known.platform}:${handle}` }
}

export interface ApplicationInput {
  idempotencyKey?: string
  applicantName: string
  displayName?: string
  email: string
  country: string
  stateRegion?: string
  socialUrls: string[]
  website?: string
  audienceSize?: number | string | null
  contentCategory?: string
  motivation: string
  promotionPlan: string
  preferredCode?: string
  heardAbout?: string
  applicantNotes?: string
  ageAttested: boolean
  termsAccepted: boolean
  disclosureAccepted: boolean
  privacyAccepted: boolean
  accuracyConfirmed: boolean
  esignConsent: boolean
  termsVersion: string
  disclosureVersion: string
  privacyVersion: string
}

export interface CleanApplication {
  idempotencyKey: string | null
  applicantName: string; displayName: string | null; email: string
  country: string; stateRegion: string | null
  socialLinks: SocialLink[]; website: string | null
  audienceSize: number | null; contentCategory: string | null
  motivation: string; promotionPlan: string; preferredCode: string | null
  heardAbout: string | null; applicantNotes: string | null
  termsVersion: string; disclosureVersion: string; privacyVersion: string
}

export type FieldErrors = Record<string, string>
export type ValidationResult =
  | { ok: true; value: CleanApplication }
  | { ok: false; errors: FieldErrors }

/** Countries that need a state/province. */
const STATE_REQUIRED = new Set(['US', 'CA'])

export function validateApplicationInput(
  input: Partial<ApplicationInput> | null | undefined,
  allowedCountries: readonly string[] = ['US'],
): ValidationResult {
  const i = (input ?? {}) as Partial<ApplicationInput>
  const e: FieldErrors = {}

  const applicantName = cleanText(i.applicantName, LIMITS.name)
  if (applicantName.length < 2) e.applicantName = 'Enter your full name.'
  const displayName = cleanText(i.displayName, LIMITS.name) || null

  const email = normalizeEmail(i.email)
  if (!isEmailShape(email)) e.email = 'Enter a valid email address.'

  const country = cleanText(i.country, 2).toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) e.country = 'Select your country.'
  else if (!allowedCountries.map(c => c.toUpperCase()).includes(country)) e.country = 'The program is not open in this country yet.'
  const stateRegion = cleanText(i.stateRegion, LIMITS.state) || null
  if (STATE_REQUIRED.has(country) && !stateRegion) e.stateRegion = 'Enter your state or province.'

  const socials: SocialLink[] = []
  const rawUrls = Array.isArray(i.socialUrls) ? i.socialUrls.filter(u => typeof u === 'string' && u.trim()) : []
  if (rawUrls.length === 0) e.socialUrls = 'Add at least one social profile link.'
  else if (rawUrls.length > LIMITS.maxSocials) e.socialUrls = `Add at most ${LIMITS.maxSocials} links.`
  else {
    for (const u of rawUrls) {
      const c = canonicalizeSocialUrl(u)
      if (!c) { e.socialUrls = 'Use a direct link to your profile, like https://instagram.com/yourname.'; break }
      if (!socials.some(s => s.key === c.key)) socials.push(c)
    }
  }

  let website: string | null = null
  const rawSite = cleanText(i.website, LIMITS.website)
  if (rawSite) {
    const u = parsePublicHttpsUrl(rawSite)
    if (!u) e.website = 'Enter a valid website address.'
    else website = `https://${stripHost(u.hostname)}${u.pathname === '/' ? '' : u.pathname}`
  }

  let audienceSize: number | null = null
  if (i.audienceSize !== undefined && i.audienceSize !== null && String(i.audienceSize).trim() !== '') {
    const n = Number(String(i.audienceSize).replace(/[, ]/g, ''))
    if (!Number.isInteger(n) || n < 0 || n > LIMITS.maxAudience) e.audienceSize = 'Enter a whole number.'
    else audienceSize = n
  }

  const motivation = cleanText(i.motivation, LIMITS.longText)
  if (motivation.length < LIMITS.minLongText) e.motivation = 'Tell us a little more (a sentence or two).'
  const promotionPlan = cleanText(i.promotionPlan, LIMITS.longText)
  if (promotionPlan.length < LIMITS.minLongText) e.promotionPlan = 'Tell us a little more (a sentence or two).'

  let preferredCode: string | null = null
  const rawCode = cleanText(i.preferredCode, 40).toUpperCase()
  if (rawCode) {
    if (!CODE_RE.test(rawCode)) e.preferredCode = 'Use 2–32 letters, numbers, hyphens or underscores.'
    else preferredCode = rawCode
  }

  // Each acceptance is required and separate. Nothing is ever pre-checked or implied.
  if (i.ageAttested !== true) e.ageAttested = 'You must confirm you are 18 or older.'
  if (i.termsAccepted !== true) e.termsAccepted = 'Accept the Affiliate Program Terms to continue.'
  if (i.disclosureAccepted !== true) e.disclosureAccepted = 'Accept the Disclosure Policy to continue.'
  if (i.privacyAccepted !== true) e.privacyAccepted = 'Acknowledge the Privacy Notice to continue.'
  if (i.accuracyConfirmed !== true) e.accuracyConfirmed = 'Confirm your information is accurate.'
  if (i.esignConsent !== true) e.esignConsent = 'Agree to use electronic signatures to continue.'

  const ver = (v: unknown) => (typeof v === 'string' && /^v[0-9]{1,6}$/.test(v) ? v : '')
  const termsVersion = ver(i.termsVersion), disclosureVersion = ver(i.disclosureVersion), privacyVersion = ver(i.privacyVersion)
  if (!termsVersion || !disclosureVersion || !privacyVersion) e.documents = 'Reload the page and review the documents again.'

  if (Object.keys(e).length) return { ok: false, errors: e }
  const key = typeof i.idempotencyKey === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(i.idempotencyKey) ? i.idempotencyKey : null
  return {
    ok: true,
    value: {
      idempotencyKey: key, applicantName, displayName, email, country, stateRegion,
      socialLinks: socials, website, audienceSize,
      contentCategory: cleanText(i.contentCategory, LIMITS.category) || null,
      motivation, promotionPlan, preferredCode,
      heardAbout: cleanText(i.heardAbout, LIMITS.heardAbout) || null,
      applicantNotes: cleanText(i.applicantNotes, LIMITS.longText) || null,
      termsVersion, disclosureVersion, privacyVersion,
    },
  }
}

/** Only https links are ever rendered as clickable in Admin. */
export function safeExternalHref(url: unknown): string | null {
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null
  } catch { return null }
}
