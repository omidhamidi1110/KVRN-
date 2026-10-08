// lib/affiliate-program-docs.ts — PURE markdown-lite parser for affiliate documents.
// Output is a typed block list that React renders as TEXT NODES. No HTML is ever injected, so a
// document body can never run script or add markup. Supported: "# " / "## " / "### " headings,
// paragraphs, "- " bullet lists, and **bold** inside text.

export type DocInline = { text: string; bold: boolean }
export type DocBlock =
  | { type: 'heading'; level: 1 | 2 | 3; inline: DocInline[] }
  | { type: 'paragraph'; inline: DocInline[] }
  | { type: 'list'; items: DocInline[][] }

export function parseInline(s: string): DocInline[] {
  // Odd-indexed pieces between ** markers are bold. An unmatched trailing ** is kept as literal text.
  const parts = s.split('**')
  const matched = parts.length % 2 === 1 ? parts.length : parts.length - 1
  const out: DocInline[] = []
  for (let i = 0; i < parts.length; i++) {
    if (i >= matched) { const tail = parts.slice(i).join('**'); if (tail) out.push({ text: '**' + tail, bold: false }); break }
    if (parts[i]) out.push({ text: parts[i], bold: i % 2 === 1 })
  }
  return out
}

export function parseDocument(body: string): DocBlock[] {
  const blocks: DocBlock[] = []
  let para: string[] = []
  let list: DocInline[][] | null = null
  const flushPara = () => { if (para.length) { blocks.push({ type: 'paragraph', inline: parseInline(para.join(' ')) }); para = [] } }
  const flushList = () => { if (list) { blocks.push({ type: 'list', items: list }); list = null } }
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const h = /^(#{1,3})\s+(.+)$/.exec(line)
    if (h) { flushPara(); flushList(); blocks.push({ type: 'heading', level: h[1].length as 1 | 2 | 3, inline: parseInline(h[2]) }); continue }
    const li = /^\s*-\s+(.+)$/.exec(line)
    if (li) { flushPara(); (list ??= []).push(parseInline(li[1])); continue }
    if (!line.trim()) { flushPara(); flushList(); continue }
    flushList(); para.push(line.trim())
  }
  flushPara(); flushList()
  return blocks
}

/** Plain text of a document (used by tests and previews). */
export function documentPlainText(body: string): string {
  return parseDocument(body).map(b =>
    b.type === 'list' ? b.items.map(i => i.map(x => x.text).join('')).join('\n') : b.inline.map(x => x.text).join('')).join('\n')
}

// ── URL slugs for the public document pages ─────────────────────────────────

const SLUG_TYPES = ['program_terms', 'disclosure_policy', 'privacy_notice', 'brand_rules', 'ugc_license'] as const
export type DocSlugType = typeof SLUG_TYPES[number]

export const docSlug = (t: string) => t.replace(/_/g, '-')
export function docTypeFromSlug(slug: unknown): DocSlugType | null {
  if (typeof slug !== 'string') return null
  const t = slug.replace(/-/g, '_')
  return (SLUG_TYPES as readonly string[]).includes(t) ? (t as DocSlugType) : null
}
export const documentHref = (docType: string, version?: string) =>
  `/affiliates/documents/${docSlug(docType)}${version ? `?version=${encodeURIComponent(version)}` : ''}`
