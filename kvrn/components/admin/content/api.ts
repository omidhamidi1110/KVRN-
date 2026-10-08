// Client helpers for /api/admin/content/**.

export const BASE = '/api/admin/content'

export interface Invalidation { ok: boolean; error?: string; id?: string | null; paths?: string[]; tags?: string[] }
export interface ApiResult<T = any> {
  ok: boolean
  status: number
  data?: T
  invalidation?: Invalidation | null
  error?: string
  code?: string
  details?: unknown
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const r = await fetch(url.startsWith('/') ? url : `${BASE}/${url}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j.success === false) {
      return { ok: false, status: r.status, error: j.error ?? 'Something went wrong. Nothing was changed.', code: j.code, details: j.details }
    }
    return { ok: true, status: r.status, data: j.data, invalidation: j.invalidation ?? null }
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the server. Check your connection and try again.', code: 'network' }
  }
}

/** The field-level messages the server returned for a rejected save ("path: message"). */
export function detailList(r: ApiResult): string[] {
  return Array.isArray(r.details) ? r.details.filter((d): d is string => typeof d === 'string') : []
}

export function newId(prefix = 'i'): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `${prefix}${rnd}`
}

export const KIND_PATH = {
  policies: 'policies', 'size-guides': 'size-guides', blocks: 'blocks', faq: 'faq', pages: 'pages', about: 'about', contact: 'contact',
  'support-pages': 'support-pages', announcement: 'announcement', navigation: 'navigation', footer: 'footer',
} as const
export type Kind = keyof typeof KIND_PATH

export const SINGLETON: Partial<Record<Kind, string>> = {
  faq: 'main', about: 'main', contact: 'main', announcement: 'main', navigation: 'main', footer: 'main', 'support-pages': 'size-guide',
}
