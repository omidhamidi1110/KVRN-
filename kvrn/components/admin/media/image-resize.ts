// Browser-only: generate responsive WebP renditions BEFORE upload (the Worker never decodes
// images). Returns [] for formats where renditions make no sense (GIF) or if the browser
// cannot encode WebP — the original is still uploaded and displayed as-is.

export const RENDITION_WIDTHS = [480, 960, 1600] as const

async function toWebp(bitmap: ImageBitmap, width: number): Promise<Blob | null> {
  const h = Math.round(bitmap.height * (width / bitmap.width))
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0, width, h)
  return await new Promise<Blob | null>(res => canvas.toBlob(b => res(b && b.type === 'image/webp' ? b : null), 'image/webp', 0.84))
}

/** Renditions strictly narrower than the original, never upscaled. */
export async function makeRenditions(file: File): Promise<File[]> {
  if (file.type === 'image/gif' || typeof createImageBitmap !== 'function') return []
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(file) } catch { return [] }
  try {
    const out: File[] = []
    for (const w of RENDITION_WIDTHS) {
      if (w >= bitmap.width) continue
      const blob = await toWebp(bitmap, w)
      if (blob) out.push(new File([blob], `w${w}.webp`, { type: 'image/webp' }))
    }
    return out
  } finally { bitmap.close?.() }
}

export interface UploadOptions { altText?: string; title?: string; tags?: string[] }

export async function uploadImage(file: File, opts: UploadOptions = {}): Promise<{ ok: true; asset: any; reused: boolean } | { ok: false; error: string }> {
  const form = new FormData()
  form.append('file', file)
  for (const v of await makeRenditions(file)) form.append('variants', v)
  if (opts.altText) form.append('altText', opts.altText)
  if (opts.title) form.append('title', opts.title)
  if (opts.tags?.length) form.append('tags', opts.tags.join(','))
  try {
    const r = await fetch('/api/admin/media', { method: 'POST', body: form })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: j.error ?? 'Upload failed.' }
    return { ok: true, asset: j.data, reused: !!j.meta?.reused }
  } catch { return { ok: false, error: 'Upload failed.' } }
}
