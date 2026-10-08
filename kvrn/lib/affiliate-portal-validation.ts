// lib/affiliate-portal-validation.ts — pure server-side validation for the limited self-service profile edits.
// An affiliate may change ONLY: display name, website, social profile links. Country, login email and every
// status / readiness / commercial field are NOT editable here.

export const SOCIAL_PLATFORMS = [
  'instagram', 'tiktok', 'youtube', 'x', 'facebook', 'twitch', 'pinterest', 'snapchat', 'linkedin', 'threads', 'bluesky', 'other',
] as const
export type SocialPlatform = typeof SOCIAL_PLATFORMS[number]

export const MAX_SOCIAL_LINKS = 8

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** https only, no credentials, no fragment, host must look like a domain. Returns the canonical string. */
export function normalizeHttpsUrl(raw: unknown, maxLen = 300): Result<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a valid link.' }
  const v = raw.trim()
  if (!v || v.length > maxLen) return { ok: false, error: 'Enter a valid link.' }
  if (/[\u0000-\u001F\u007F\s]/.test(v)) return { ok: false, error: 'Enter a valid link.' }
  let u: URL
  try { u = new URL(v) } catch { return { ok: false, error: 'Enter a full link starting with https://.' } }
  if (u.protocol !== 'https:') return { ok: false, error: 'Links must start with https://.' }
  if (u.username || u.password) return { ok: false, error: 'Links cannot contain credentials.' }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return { ok: false, error: 'Enter a valid link.' }
  u.hash = ''
  return { ok: true, value: u.toString() }
}

export function validateDisplayName(raw: unknown): Result<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a name.' }
  const v = raw.replace(/\s+/g, ' ').trim()
  if (v.length < 1 || v.length > 80) return { ok: false, error: 'Name must be 1–80 characters.' }
  if (/[\u0000-\u001F\u007F<>]/.test(v)) return { ok: false, error: 'Name contains characters that are not allowed.' }
  return { ok: true, value: v }
}

export function validateSocialLinks(raw: unknown): Result<Array<{ platform: SocialPlatform; url: string }>> {
  if (!Array.isArray(raw)) return { ok: false, error: 'Social links must be a list.' }
  if (raw.length > MAX_SOCIAL_LINKS) return { ok: false, error: `You can list up to ${MAX_SOCIAL_LINKS} profiles.` }
  const out: Array<{ platform: SocialPlatform; url: string }> = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'Each social link needs a platform and link.' }
    const platform = String((item as any).platform ?? '').toLowerCase()
    if (!(SOCIAL_PLATFORMS as readonly string[]).includes(platform)) return { ok: false, error: 'Choose a supported platform.' }
    const u = normalizeHttpsUrl((item as any).url)
    if (!u.ok) return u
    const key = u.value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ platform: platform as SocialPlatform, url: u.value })
  }
  return { ok: true, value: out }
}

export interface ProfilePatch {
  displayName?: string
  website?: string | null
  socialLinks?: Array<{ platform: SocialPlatform; url: string }>
}

/** Unknown keys are rejected (not ignored) so a client cannot smuggle a status or id field through. */
export function validateProfilePatch(body: unknown): Result<ProfilePatch> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Invalid request.' }
  const allowed = new Set(['displayName', 'website', 'socialLinks'])
  for (const k of Object.keys(body)) if (!allowed.has(k)) return { ok: false, error: 'That field cannot be changed here.' }
  const b = body as Record<string, unknown>
  const patch: ProfilePatch = {}
  if ('displayName' in b) {
    const r = validateDisplayName(b.displayName); if (!r.ok) return r
    patch.displayName = r.value
  }
  if ('website' in b) {
    if (b.website === null || b.website === '') patch.website = null
    else { const r = normalizeHttpsUrl(b.website, 200); if (!r.ok) return r; patch.website = r.value }
  }
  if ('socialLinks' in b) {
    const r = validateSocialLinks(b.socialLinks); if (!r.ok) return r
    patch.socialLinks = r.value
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'Nothing to update.' }
  return { ok: true, value: patch }
}

/** a***@example.com — enough for the affiliate to recognise their login, never the full address. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email || !email.includes('@')) return null
  const [l, d] = email.split('@')
  return `${l.slice(0, 1)}***@${d}`
}
