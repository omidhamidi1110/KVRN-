// Tiny fetch helper for the affiliate Admin screens. Never throws; always returns a result object.
export interface ApiResult<T = any> { ok: boolean; status: number; data: T; error: string | null }

export async function adminApi<T = any>(url: string, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
      headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, data: data as T, error: res.ok ? null : ((data as any)?.error ?? 'Request failed.') }
  } catch {
    return { ok: false, status: 0, data: {} as T, error: 'Network error. Check your connection and try again.' }
  }
}
