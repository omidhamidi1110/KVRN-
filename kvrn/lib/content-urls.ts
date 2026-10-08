// lib/content-urls.ts — URL / slug validators shared by every content editor.
//
// Policy: CMS content may only link to
//   * an internal absolute path  ("/shop", "/support/faq#returns")
//   * an https:// external URL    (no credentials)
//   * mailto:                     (rich text and footer/contact slots only, never navigation)
// Everything else — javascript:, data:, vbscript:, file:, protocol-relative "//host", relative
// paths, whitespace/control characters, backslashes — is refused. Refusal (an error), not
// silent rewriting, so an editor can never believe a hostile link was saved.

const MAX_URL = 2000
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f-\u009f\u2028\u2029\u200b-\u200f\ufeff]/
const INTERNAL_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/
const EMAIL_RE = /^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+$/

export type UrlKind = 'internal' | 'external' | 'mailto'

export interface UrlCheck { ok: boolean; kind?: UrlKind; value?: string; error?: string }

export interface UrlOptions {
  /** Allow mailto: (rich text, footer, contact). Navigation/announcement links do not. */
  allowMailto?: boolean
  /** Allow https:// external destinations (default true). */
  allowExternal?: boolean
}

/** Validate and normalise (trim only) a destination URL. */
export function checkUrl(raw: unknown, opts: UrlOptions = {}): UrlCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a link.' }
  const v = raw.trim()
  if (!v) return { ok: false, error: 'Enter a link.' }
  if (v.length > MAX_URL) return { ok: false, error: 'That link is too long.' }
  if (CONTROL_OR_SPACE.test(v)) return { ok: false, error: 'Links cannot contain spaces or hidden characters.' }
  if (v.includes('\\')) return { ok: false, error: 'Links cannot contain backslashes.' }

  if (v.startsWith('/')) {
    if (v.startsWith('//')) return { ok: false, error: 'Use a full https:// link or a path starting with a single "/".' }
    if (!INTERNAL_RE.test(v)) return { ok: false, error: 'That path has characters that are not allowed.' }
    // no dot-segments in the PATH part
    const pathOnly = v.split(/[?#]/)[0]
    if (pathOnly.split('/').some(seg => seg === '..' || seg === '.')) return { ok: false, error: 'Links cannot contain "." or ".." segments.' }
    return { ok: true, kind: 'internal', value: v }
  }

  const lower = v.toLowerCase()
  if (lower.startsWith('https://')) {
    if (opts.allowExternal === false) return { ok: false, error: 'Only links within the store are allowed here.' }
    let u: URL
    try { u = new URL(v) } catch { return { ok: false, error: 'That is not a valid link.' } }
    if (u.protocol !== 'https:') return { ok: false, error: 'Only https:// links are allowed.' }
    if (u.username || u.password) return { ok: false, error: 'Links cannot contain a username or password.' }
    if (!u.hostname || !/^[A-Za-z0-9.-]+$/.test(u.hostname) || !u.hostname.includes('.')) {
      return { ok: false, error: 'That is not a valid link.' }
    }
    return { ok: true, kind: 'external', value: v }
  }

  if (lower.startsWith('mailto:')) {
    if (!opts.allowMailto) return { ok: false, error: 'Email links are not allowed here.' }
    const addr = v.slice(7).split('?')[0]
    if (!EMAIL_RE.test(addr)) return { ok: false, error: 'That email address is not valid.' }
    return { ok: true, kind: 'mailto', value: v }
  }

  return { ok: false, error: 'Links must start with "/" or "https://".' }
}

export const checkRichTextUrl = (v: unknown) => checkUrl(v, { allowMailto: true, allowExternal: true })
export const checkNavUrl      = (v: unknown) => checkUrl(v, { allowMailto: false, allowExternal: true })
export const checkFooterUrl   = (v: unknown) => checkUrl(v, { allowMailto: true, allowExternal: true })

/** True for internal paths — used for rel/target decisions in renderers. */
export const isInternalHref = (h: string) => h.startsWith('/') && !h.startsWith('//')

/** Path part only (no query/hash), lower-cased, without a trailing slash (root stays "/"). */
export function normalizeInternalPath(href: string): string {
  const p = href.split(/[?#]/)[0].toLowerCase()
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}

// ── Slugs ─────────────────────────────────────────────────────────────────────

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const MAX_SLUG = 80

export function slugify(input: string): string {
  return String(input ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG).replace(/-+$/g, '')
}

export function checkSlug(raw: unknown, reserved: ReadonlySet<string> = new Set()): { ok: boolean; value?: string; error?: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a URL name.' }
  const v = raw.trim().toLowerCase()
  if (!v) return { ok: false, error: 'Enter a URL name.' }
  if (v.length > MAX_SLUG) return { ok: false, error: 'The URL name is too long.' }
  if (!SLUG_RE.test(v)) return { ok: false, error: 'Use lowercase letters, numbers and single hyphens.' }
  if (reserved.has(v)) return { ok: false, error: 'That URL name is reserved.' }
  return { ok: true, value: v }
}
