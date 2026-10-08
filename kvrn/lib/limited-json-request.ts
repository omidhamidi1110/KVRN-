// Read public JSON requests with a real byte cap, including chunked/no-length
// requests. A Content-Length check alone can be omitted by the caller.
// Dependency-free; intentionally does not log request bodies or personal data.
export type LimitedRequestError = { ok: false; status: 400 | 413; reason: 'invalid' | 'too_large' }
export type LimitedTextResult = { ok: true; value: string } | LimitedRequestError
export type LimitedJsonResult = { ok: true; value: unknown } | LimitedRequestError

export async function readLimitedText(request: Request, maxBytes: number): Promise<LimitedTextResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid JSON size limit')
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0) return { ok: false, status: 400, reason: 'invalid' }
    if (length > maxBytes) return { ok: false, status: 413, reason: 'too_large' }
  }
  if (!request.body) return { ok: false, status: 400, reason: 'invalid' }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false, status: 413, reason: 'too_large' }
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return { ok: true, value: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { ok: false, status: 400, reason: 'invalid' }
  } finally {
    reader.releaseLock()
  }
}

export async function readLimitedJson(request: Request, maxBytes: number): Promise<LimitedJsonResult> {
  const read = await readLimitedText(request, maxBytes)
  if (!read.ok) return read
  try { return { ok: true, value: JSON.parse(read.value) } }
  catch { return { ok: false, status: 400, reason: 'invalid' } }
}
