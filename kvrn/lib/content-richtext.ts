// lib/content-richtext.ts — the constrained, structured "rich text" model for Admin-managed
// public content (policies, pages, FAQ answers, size-guide copy, reusable blocks ...).
//
// DESIGN RULES
//   * Content is JSON, never HTML. There is NO node that carries raw HTML, script, style or
//     arbitrary attributes. Text is always rendered through React text nodes (escaped).
//   * The validator REJECTS unknown node types and unsafe URLs (javascript:, data:, vbscript:,
//     protocol-relative "//", relative paths ...). Known nodes are REBUILT from whitelisted
//     fields, so any extra keys an attacker adds are dropped.
//   * Size caps (blocks, nesting is flat by construction, text length, list/table sizes) bound
//     what one editor can store.
//   * Editors never type JSON. Inline text uses a tiny markup — **bold**, *italic*,
//     [label](link) — parsed by `markupToInline` and printed by `inlineToMarkup`.

import { checkRichTextUrl } from './content-urls'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TextNode { t: 'text'; text: string; b?: true; i?: true }
export interface LinkNode { t: 'link'; href: string; text: string; b?: true; i?: true }
export type InlineNode = TextNode | LinkNode
export type Inline = InlineNode[]

export type RichBlock =
  | { t: 'h2' | 'h3'; c: Inline }
  | { t: 'p'; c: Inline }
  | { t: 'ul' | 'ol'; items: Inline[] }
  | { t: 'hr' }
  | { t: 'media'; assetId: string; caption?: string }
  | { t: 'callout'; title?: string; paras: Inline[] }
  | { t: 'table'; label: string; headers: string[]; rows: Inline[][]; mono?: true }
  | { t: 'cards'; items: Array<{ label: string; text: string }> }
  | { t: 'defs'; items: Array<{ title: string; lines: string[] }> }
  | { t: 'embed'; kind: EmbedKind }
  | { t: 'blockref'; blockId: string }

export type EmbedKind = 'cookie-controls'
export const EMBED_KINDS: readonly EmbedKind[] = ['cookie-controls']

export interface RichText { v: 1; blocks: RichBlock[] }

export const RICH_LIMITS = {
  blocks: 200,
  inlineNodes: 60,
  textNode: 5_000,
  listItems: 80,
  tableRows: 80,
  tableCols: 8,
  cells: 600,
  cards: 12,
  defs: 60,
  defLines: 6,
  line: 1_000,
  totalChars: 120_000,
} as const

export const emptyRichText = (): RichText => ({ v: 1, blocks: [] })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Strip control chars except tab/newline; strip bidi override characters (spoofing).
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g

export const cleanText = (s: string) => s.replace(BAD_CHARS, '').normalize('NFC')

// ── Validation ────────────────────────────────────────────────────────────────

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] }

class Ctx {
  errors: string[] = []
  chars = 0
  err(path: string, msg: string) { if (this.errors.length < 25) this.errors.push(`${path}: ${msg}`) }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function str(c: Ctx, path: string, v: unknown, max: number, opts: { allowEmpty?: boolean } = {}): string | null {
  if (typeof v !== 'string') { c.err(path, 'must be text'); return null }
  const s = cleanText(v)
  if (s.length > max) { c.err(path, `is too long (max ${max})`); return null }
  if (!opts.allowEmpty && s.trim() === '') { c.err(path, 'cannot be empty'); return null }
  c.chars += s.length
  return s
}

function inlineNodes(c: Ctx, path: string, v: unknown): Inline {
  if (!Array.isArray(v)) { c.err(path, 'must be a list of text'); return [] }
  if (v.length > RICH_LIMITS.inlineNodes) { c.err(path, 'has too many parts'); return [] }
  const out: Inline = []
  v.forEach((n, i) => {
    const p = `${path}[${i}]`
    if (!isObj(n)) { c.err(p, 'invalid text part'); return }
    if (n.t === 'text') {
      const text = str(c, `${p}.text`, n.text, RICH_LIMITS.textNode, { allowEmpty: true })
      if (text === null) return
      const node: TextNode = { t: 'text', text }
      if (n.b === true) node.b = true
      if (n.i === true) node.i = true
      out.push(node)
    } else if (n.t === 'link') {
      const text = str(c, `${p}.text`, n.text, RICH_LIMITS.line)
      const chk = checkRichTextUrl(n.href)
      if (!chk.ok) c.err(`${p}.href`, chk.error ?? 'invalid link')
      if (text === null || !chk.ok) return
      const node: LinkNode = { t: 'link', href: chk.value!, text }
      if (n.b === true) node.b = true
      if (n.i === true) node.i = true
      out.push(node)
    } else {
      c.err(p, `unknown text type "${String(n.t).slice(0, 20)}"`)
    }
  })
  return out
}

function inlineList(c: Ctx, path: string, v: unknown, max: number): Inline[] {
  if (!Array.isArray(v)) { c.err(path, 'must be a list'); return [] }
  if (v.length > max) { c.err(path, `has too many items (max ${max})`); return [] }
  return v.map((x, i) => inlineNodes(c, `${path}[${i}]`, x))
}

function validateBlock(c: Ctx, path: string, b: unknown): RichBlock | null {
  if (!isObj(b)) { c.err(path, 'invalid block'); return null }
  switch (b.t) {
    case 'h2': case 'h3': {
      const content = inlineNodes(c, `${path}.c`, b.c)
      return { t: b.t, c: content }
    }
    case 'p': return { t: 'p', c: inlineNodes(c, `${path}.c`, b.c) }
    case 'ul': case 'ol':
      return { t: b.t, items: inlineList(c, `${path}.items`, b.items, RICH_LIMITS.listItems) }
    case 'hr': return { t: 'hr' }
    case 'media': {
      if (typeof b.assetId !== 'string' || !UUID_RE.test(b.assetId)) { c.err(`${path}.assetId`, 'choose an image from the library'); return null }
      const out: RichBlock = { t: 'media', assetId: b.assetId.toLowerCase() }
      if (b.caption !== undefined && b.caption !== null && b.caption !== '') {
        const cap = str(c, `${path}.caption`, b.caption, 300, { allowEmpty: true })
        if (cap) out.caption = cap
      }
      return out
    }
    case 'callout': {
      const paras = inlineList(c, `${path}.paras`, b.paras, 10)
      const out: RichBlock = { t: 'callout', paras }
      if (b.title !== undefined && b.title !== null && b.title !== '') {
        const title = str(c, `${path}.title`, b.title, 200, { allowEmpty: true })
        if (title) out.title = title
      }
      return out
    }
    case 'table': {
      const label = str(c, `${path}.label`, b.label ?? '', 200, { allowEmpty: true }) ?? ''
      if (!Array.isArray(b.headers) || b.headers.length > RICH_LIMITS.tableCols) { c.err(`${path}.headers`, 'invalid table columns'); return null }
      const headers = b.headers.map((h, i) => str(c, `${path}.headers[${i}]`, h, 120, { allowEmpty: true }) ?? '')
      if (!Array.isArray(b.rows) || b.rows.length > RICH_LIMITS.tableRows) { c.err(`${path}.rows`, 'invalid table rows'); return null }
      let cells = 0
      const rows: Inline[][] = []
      b.rows.forEach((r, ri) => {
        if (!Array.isArray(r) || r.length > RICH_LIMITS.tableCols) { c.err(`${path}.rows[${ri}]`, 'invalid row'); return }
        cells += r.length
        rows.push(r.map((cell, ci) => inlineNodes(c, `${path}.rows[${ri}][${ci}]`, cell)))
      })
      if (cells > RICH_LIMITS.cells) c.err(`${path}.rows`, 'table is too large')
      const out: RichBlock = { t: 'table', label, headers, rows }
      if (b.mono === true) out.mono = true
      return out
    }
    case 'cards': {
      if (!Array.isArray(b.items) || b.items.length > RICH_LIMITS.cards) { c.err(`${path}.items`, 'too many cards'); return null }
      const items = b.items.map((it, i) => {
        const o = isObj(it) ? it : {}
        return {
          label: str(c, `${path}.items[${i}].label`, o.label, 120, { allowEmpty: true }) ?? '',
          text: str(c, `${path}.items[${i}].text`, o.text, 300, { allowEmpty: true }) ?? '',
        }
      })
      return { t: 'cards', items }
    }
    case 'defs': {
      if (!Array.isArray(b.items) || b.items.length > RICH_LIMITS.defs) { c.err(`${path}.items`, 'too many rows'); return null }
      const items = b.items.map((it, i) => {
        const o = isObj(it) ? it : {}
        const title = str(c, `${path}.items[${i}].title`, o.title, 300, { allowEmpty: true }) ?? ''
        const linesRaw = Array.isArray(o.lines) ? o.lines : []
        if (linesRaw.length > RICH_LIMITS.defLines) c.err(`${path}.items[${i}].lines`, 'too many lines')
        const lines = linesRaw.slice(0, RICH_LIMITS.defLines).map((l, li) =>
          str(c, `${path}.items[${i}].lines[${li}]`, l, RICH_LIMITS.line, { allowEmpty: true }) ?? '')
        return { title, lines }
      })
      return { t: 'defs', items }
    }
    case 'embed': {
      if (!EMBED_KINDS.includes(b.kind as EmbedKind)) { c.err(`${path}.kind`, 'unknown embed'); return null }
      return { t: 'embed', kind: b.kind as EmbedKind }
    }
    case 'blockref': {
      if (typeof b.blockId !== 'string' || !UUID_RE.test(b.blockId)) { c.err(`${path}.blockId`, 'choose a content block'); return null }
      return { t: 'blockref', blockId: b.blockId.toLowerCase() }
    }
    default:
      c.err(path, `unknown block type "${String(b.t).slice(0, 20)}"`)
      return null
  }
}

export interface RichValidateOptions {
  /** Disallow nested reusable-block references (a reusable block cannot embed another). */
  allowBlockRefs?: boolean
  /** Disallow media blocks (e.g. short reusable text). */
  allowMedia?: boolean
}

/** Validate untrusted JSON into a RichText. Never throws. */
export function validateRichText(input: unknown, opts: RichValidateOptions = {}): Validation<RichText> {
  const c = new Ctx()
  if (!isObj(input) || input.v !== 1 || !Array.isArray(input.blocks)) {
    return { ok: false, errors: ['content: not a valid rich text document'] }
  }
  if (input.blocks.length > RICH_LIMITS.blocks) return { ok: false, errors: [`content: too many blocks (max ${RICH_LIMITS.blocks})`] }
  const blocks: RichBlock[] = []
  input.blocks.forEach((b, i) => {
    const vb = validateBlock(c, `block ${i + 1}`, b)
    if (!vb) return
    if (vb.t === 'blockref' && opts.allowBlockRefs === false) { c.err(`block ${i + 1}`, 'reusable blocks cannot be used here'); return }
    if (vb.t === 'media' && opts.allowMedia === false) { c.err(`block ${i + 1}`, 'images cannot be used here'); return }
    blocks.push(vb)
  })
  if (c.chars > RICH_LIMITS.totalChars) c.err('content', 'is too long')
  if (c.errors.length) return { ok: false, errors: c.errors }
  return { ok: true, value: { v: 1, blocks } }
}

// ── Introspection ─────────────────────────────────────────────────────────────

export function collectMediaIds(doc: RichText | null | undefined): string[] {
  const ids = new Set<string>()
  for (const b of doc?.blocks ?? []) if (b.t === 'media') ids.add(b.assetId)
  return [...ids]
}

export function collectBlockRefs(doc: RichText | null | undefined): string[] {
  const ids = new Set<string>()
  for (const b of doc?.blocks ?? []) if (b.t === 'blockref') ids.add(b.blockId)
  return [...ids]
}

export const inlineToPlain = (c: Inline): string => c.map(n => n.text).join('')

/** Plain text of a document (search, SEO description fallback, equivalence tests). */
export function richTextToPlain(doc: RichText | null | undefined): string {
  const lines: string[] = []
  for (const b of doc?.blocks ?? []) {
    switch (b.t) {
      case 'h2': case 'h3': case 'p': lines.push(inlineToPlain(b.c)); break
      case 'ul': case 'ol': b.items.forEach(i => lines.push(inlineToPlain(i))); break
      case 'callout': if (b.title) lines.push(b.title); b.paras.forEach(p => lines.push(inlineToPlain(p))); break
      case 'table': lines.push(...b.headers.filter(Boolean)); b.rows.forEach(r => lines.push(r.map(inlineToPlain).join(' | '))); break
      case 'cards': b.items.forEach(i => lines.push(`${i.label} ${i.text}`.trim())); break
      case 'defs': b.items.forEach(i => lines.push([i.title, ...i.lines].filter(Boolean).join(' '))); break
      case 'media': if (b.caption) lines.push(b.caption); break
      default: break
    }
  }
  return lines.filter(Boolean).join('\n')
}

export const isRichTextEmpty = (doc: RichText | null | undefined) => richTextToPlain(doc).trim() === '' && !(doc?.blocks ?? []).some(b => b.t === 'media' || b.t === 'blockref' || b.t === 'embed')

// ── Inline markup (what editors type) ────────────────────────────────────────

const ESC_CHARS = new Set(['\\', '*', '[', ']'])
const escText = (s: string) => s.replace(/[\\*[\]]/g, m => '\\' + m)

function wrapStyle(inner: string, n: { b?: true; i?: true }): string {
  if (!inner) return ''
  if (n.b && n.i) return `***${inner}***`
  if (n.b) return `**${inner}**`
  if (n.i) return `*${inner}*`
  return inner
}

export function inlineToMarkup(c: Inline): string {
  return c.map(n => {
    if (n.t === 'text') return wrapStyle(escText(n.text), n)
    const href = n.href.replace(/\)/g, '%29').replace(/\(/g, '%28')
    return wrapStyle(`[${escText(n.text)}](${href})`, n)
  }).join('')
}

/** Parse editor markup into inline nodes. Lenient (unmatched markers just toggle style); never throws. */
export function markupToInline(src: string): Inline {
  const s = String(src ?? '')
  const out: Inline = []
  let b = false, i = false, buf = ''
  const flush = () => {
    if (!buf) return
    const node: TextNode = { t: 'text', text: buf }
    if (b) node.b = true
    if (i) node.i = true
    const last = out[out.length - 1]
    if (last && last.t === 'text' && !!last.b === !!node.b && !!last.i === !!node.i) last.text += buf
    else out.push(node)
    buf = ''
  }
  let p = 0
  while (p < s.length) {
    const ch = s[p]
    if (ch === '\\' && p + 1 < s.length && ESC_CHARS.has(s[p + 1])) { buf += s[p + 1]; p += 2; continue }
    if (ch === '*') {
      flush()
      if (s.startsWith('***', p)) { b = !b; i = !i; p += 3 }
      else if (s.startsWith('**', p)) { b = !b; p += 2 }
      else { i = !i; p += 1 }
      continue
    }
    if (ch === '[') {
      // find the closing ] (respecting escapes) followed immediately by ( ... )
      let q = p + 1, label = ''
      let closed = false
      while (q < s.length) {
        if (s[q] === '\\' && q + 1 < s.length) { label += s[q] + s[q + 1]; q += 2; continue }
        if (s[q] === ']') { closed = true; break }
        label += s[q]; q++
      }
      if (closed && s[q + 1] === '(') {
        const end = s.indexOf(')', q + 2)
        if (end > q + 1) {
          const href = s.slice(q + 2, end).replace(/%29/g, ')').replace(/%28/g, '(')
          flush()
          // The label is plain text; unescape it.
          const text = label.replace(/\\([\\*[\]])/g, '$1')
          const node: LinkNode = { t: 'link', href, text }
          if (b) node.b = true
          if (i) node.i = true
          out.push(node)
          p = end + 1
          continue
        }
      }
    }
    buf += ch; p++
  }
  flush()
  return out
}

/** Paragraph helper for seeds/tests: markup → paragraph block. */
export const para = (markup: string): RichBlock => ({ t: 'p', c: markupToInline(markup) })
export const heading = (markup: string, level: 'h2' | 'h3' = 'h2'): RichBlock => ({ t: level, c: markupToInline(markup) })
export const bullets = (items: string[], ordered = false): RichBlock => ({ t: ordered ? 'ol' : 'ul', items: items.map(markupToInline) })
export const rule = (): RichBlock => ({ t: 'hr' })

/** Block-level reordering helper used by the editor and tests. */
export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const a = arr.slice()
  if (from < 0 || from >= a.length || to < 0 || to >= a.length || from === to) return a
  const [x] = a.splice(from, 1)
  a.splice(to, 0, x)
  return a
}
