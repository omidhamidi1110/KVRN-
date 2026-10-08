// lib/affiliate-admin-client.ts — tiny fetch helper + formatters shared by the two affiliate Admin tabs.
// Browser-side; no secrets. The Admin session is the Cloudflare Access cookie the browser already holds.
export interface AdminApiResult<T = any> { ok: boolean; status: number; data: T | null; error: string | null }

export async function adminApi<T = any>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<AdminApiResult<T>> {
  try {
    const res = await fetch(path, {
      method: init.method ?? 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    let data: any = null
    try { data = await res.json() } catch { /* non-JSON */ }
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : (data?.error ?? 'Something went wrong.') }
  } catch {
    return { ok: false, status: 0, data: null, error: 'Network problem. Try again.' }
  }
}

/** Unknown money is "—", never $0.00. */
export function usd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—'
  const s = cents < 0 ? '-' : ''
  const a = Math.abs(Math.trunc(cents))
  return `${s}$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`
}
export const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—')
export const idemKey = () => `adm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
