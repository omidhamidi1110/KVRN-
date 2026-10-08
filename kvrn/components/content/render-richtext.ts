// components/content/render-richtext.ts — server-safe renderer for the structured rich text model.
//
// Written with React.createElement (no JSX) so it is unit-testable with react-dom/server.
// SAFETY: every string reaches the DOM as a React text child or an attribute value, so it is
// always escaped. There is no dangerouslySetInnerHTML anywhere in this file (a guard test
// enforces that). Link hrefs are re-validated at render time (defence in depth: a row that
// bypassed the editor still cannot emit javascript:/data: URLs).

import { createElement as h, Fragment, type ReactNode } from 'react'
import type { Inline, InlineNode, RichBlock, RichText } from '@/lib/content-richtext'
import { checkRichTextUrl, isInternalHref, slugify } from '@/lib/content-urls'

export type RichVariant = 'legal' | 'support' | 'plain' | 'faq'

export interface RenderMedia { url: string; alt: string; width?: number | null; height?: number | null }

export interface RenderCtx {
  variant?: RichVariant
  /** assetId → resolved media (URL resolved server-side from media_assets) */
  media?: Record<string, RenderMedia | undefined>
  /** blockId → reusable block content (already resolved for the locale) */
  blocks?: Record<string, RichText | undefined>
  /** Allowed embeds, supplied by the page (client components cannot be imported here). */
  embeds?: Partial<Record<'cookie-controls', ReactNode>>
  /** Internal: depth of reusable-block expansion (a block can never expand another block). */
  _depth?: number
  /** Internal: heading anchors already used on this page (keeps ids unique). */
  _ids?: Set<string>
}

interface Styles {
  wrap: string; section: string; h2: string; h3: string; body: string; stack: string
  link: string; ul: string; ol: string; li: string; bullet: boolean; rule: string
  callout: string; calloutTitle: string; calloutText: string
  th: string; td: string; tdMono: string; tr: string; trHead: string
  card: string; cardLabel: string; cardText: string; cardsWrap: string
  defsWrap: string; def: string; defTitle: string; defLine: string; defLast: string
  caption: string; strong: string
}

const LEGAL: Styles = {
  wrap: 'space-y-10 text-[14px] text-kvrn-muted leading-relaxed',
  section: '',
  h2: 'text-[15px] font-light text-kvrn-text mb-3',
  h3: 'text-[13px] font-light text-kvrn-text mb-2',
  body: '', stack: 'space-y-3',
  link: 'text-kvrn-text underline underline-offset-2',
  ul: 'space-y-2', ol: 'space-y-2 list-decimal pl-5', li: '', bullet: false,
  rule: 'rule',
  callout: 'border border-kvrn-border bg-[#F3F0EB] p-5 text-[13px]', calloutTitle: 'text-kvrn-text font-light mb-1', calloutText: 'text-kvrn-muted',
  th: 'text-left py-2 font-light label-11', td: 'py-2.5', tdMono: 'py-2.5 font-mono text-[12px] text-kvrn-text',
  tr: 'divide-y divide-kvrn-border', trHead: 'border-b border-kvrn-border',
  card: 'border border-kvrn-border p-4', cardLabel: 'text-[11px] tracking-[0.08em] uppercase text-kvrn-subtle mb-1', cardText: 'text-[14px] font-light text-kvrn-text', cardsWrap: 'grid grid-cols-1 sm:grid-cols-2 gap-4 py-2',
  defsWrap: 'space-y-4', def: 'border-l-2 border-kvrn-border pl-4 space-y-1', defTitle: 'text-[13px] font-light text-kvrn-text', defLine: '', defLast: 'text-[12px] text-kvrn-subtle',
  caption: 'mt-2 text-[12px] text-kvrn-subtle', strong: 'font-light text-kvrn-text',
}

const SUPPORT: Styles = {
  wrap: 'text-[14px] text-[#6B6B6B] leading-relaxed',
  section: 'mb-14',
  h2: 'text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-6',
  h3: 'text-[13px] font-light text-[#1A1A1A] mb-2',
  body: '', stack: 'space-y-4',
  link: 'text-[#1A1A1A] underline underline-offset-2',
  ul: 'space-y-1.5 text-[13px]', ol: 'space-y-1.5 text-[13px] list-decimal pl-5', li: 'flex items-start gap-2.5', bullet: true,
  rule: 'h-px bg-[#E8E5E0] mb-14',
  callout: 'border border-[#E8E5E0] bg-[#F3F0EB] p-5 text-[13px]', calloutTitle: 'text-[#1A1A1A] font-light mb-1', calloutText: 'text-[#6B6B6B]',
  th: 'text-left py-2 font-light text-[11px] tracking-[0.08em] uppercase text-[#9B9B9B]', td: 'py-2.5', tdMono: 'py-2.5 font-mono text-[12px] text-[#1A1A1A]',
  tr: 'divide-y divide-[#E8E5E0]', trHead: 'border-b border-[#E8E5E0]',
  card: 'border border-[#E8E5E0] p-4', cardLabel: 'text-[11px] tracking-[0.08em] uppercase text-[#9B9B9B] mb-1', cardText: 'text-[14px] font-light text-[#1A1A1A]', cardsWrap: 'grid grid-cols-1 sm:grid-cols-2 gap-4 py-4',
  defsWrap: 'space-y-4', def: 'border-l-2 border-[#E8E5E0] pl-4 space-y-1', defTitle: 'text-[13px] font-light text-[#1A1A1A]', defLine: '', defLast: 'text-[12px] text-[#9B9B9B]',
  caption: 'mt-2 text-[12px] text-[#9B9B9B]', strong: 'font-light text-[#1A1A1A]',
}

const PLAIN: Styles = {
  ...SUPPORT, wrap: 'text-[14px] text-[#6B6B6B] leading-relaxed space-y-4', section: '', rule: 'h-px bg-[#E8E5E0] my-8',
  h2: 'text-[16px] font-light text-[#1A1A1A] mb-3', h3: 'text-[14px] font-light text-[#1A1A1A] mb-2',
}

const FAQ: Styles = {
  ...SUPPORT, wrap: 'text-[13px] text-[#6B6B6B] leading-relaxed space-y-3', section: '', stack: 'space-y-3',
}

const styleFor = (v: RichVariant | undefined): Styles =>
  v === 'support' ? SUPPORT : v === 'plain' ? PLAIN : v === 'faq' ? FAQ : LEGAL

// ── Inline ────────────────────────────────────────────────────────────────────

function renderInlineNode(n: InlineNode, key: number, st: Styles): ReactNode {
  let node: ReactNode = n.text
  if (n.t === 'link') {
    const chk = checkRichTextUrl(n.href)
    if (!chk.ok) {
      node = n.text                                   // unsafe link: render text only, never a link
    } else {
      const external = !isInternalHref(chk.value!) && !chk.value!.toLowerCase().startsWith('mailto:')
      node = h('a', {
        href: chk.value,
        className: st.link,
        ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
      }, n.text)
    }
  }
  if (n.b) node = h('strong', { className: st.strong }, node)
  if (n.i) node = h('em', null, node)
  return h(Fragment, { key }, node)
}

export function renderInline(c: Inline, st: Styles = LEGAL): ReactNode[] {
  return c.map((n, i) => renderInlineNode(n, i, st))
}

// ── Blocks ────────────────────────────────────────────────────────────────────

function renderBlock(b: RichBlock, key: string, st: Styles, ctx: RenderCtx): ReactNode {
  switch (b.t) {
    case 'h2': return h('h2', { key, className: st.h2 }, renderInline(b.c, st))
    case 'h3': return h('h3', { key, className: st.h3 }, renderInline(b.c, st))
    case 'p': return h('p', { key }, renderInline(b.c, st))
    case 'ul': case 'ol': {
      const items = b.items.map((it, i) => {
        if (b.t === 'ul' && st.bullet) {
          return h('li', { key: i, className: st.li },
            h('span', { className: 'mt-2 w-1 h-1 rounded-full bg-[#9B9B9B] flex-shrink-0', 'aria-hidden': 'true' }),
            h('span', null, renderInline(it, st)))
        }
        return h('li', { key: i, className: st.li || undefined }, renderInline(it, st))
      })
      return h(b.t, { key, className: b.t === 'ol' ? st.ol : st.ul }, items)
    }
    case 'hr': return h('div', { key, className: st.rule, role: 'presentation' })
    case 'media': {
      const m = ctx.media?.[b.assetId]
      if (!m) return null                              // missing/archived asset: omit, never a broken image
      return h('figure', { key },
        // eslint-disable-next-line @next/next/no-img-element
        h('img', { src: m.url, alt: m.alt, loading: 'lazy', className: 'w-full h-auto',
                   ...(m.width && m.height ? { width: m.width, height: m.height } : {}) }),
        b.caption ? h('figcaption', { className: st.caption }, b.caption) : null)
    }
    case 'callout':
      return h('div', { key, className: st.callout },
        b.title ? h('p', { className: st.calloutTitle }, b.title) : null,
        ...b.paras.map((p, i) => h('p', { key: i, className: st.calloutText }, renderInline(p, st))))
    case 'table': {
      const hasHead = b.headers.some(x => x.trim() !== '')
      return h('div', { key, className: 'overflow-x-auto' },
        h('table', { className: 'w-full text-[13px]', 'aria-label': b.label || undefined },
          hasHead ? h('thead', null, h('tr', { className: st.trHead },
            ...b.headers.map((x, i) => h('th', { key: i, scope: 'col', className: st.th }, x)))) : null,
          h('tbody', { className: st.tr.includes('divide') ? st.tr : undefined },
            ...b.rows.map((r, ri) => h('tr', { key: ri },
              ...r.map((cell, ci) => h('td', { key: ci, className: b.mono && ci === 0 ? st.tdMono : st.td }, renderInline(cell, st))))))))
    }
    case 'cards':
      return h('div', { key, className: st.cardsWrap },
        ...b.items.map((it, i) => h('div', { key: i, className: st.card },
          h('p', { className: st.cardLabel }, it.label),
          h('p', { className: st.cardText }, it.text))))
    case 'defs':
      return h('div', { key, className: st.defsWrap },
        ...b.items.map((it, i) => h('div', { key: i, className: st.def },
          h('p', { className: st.defTitle }, it.title),
          ...it.lines.map((l, li) => h('p', { key: li, className: li === it.lines.length - 1 && it.lines.length > 1 ? st.defLast : st.defLine }, l)))))
    case 'embed': {
      const e = ctx.embeds?.[b.kind]
      return e ? h(Fragment, { key }, e) : null
    }
    case 'blockref': {
      if ((ctx._depth ?? 0) >= 1) return null          // reusable blocks never nest
      const doc = ctx.blocks?.[b.blockId]
      if (!doc) return null                            // missing/archived block: omit
      return h(Fragment, { key }, renderRichBlocks(doc, { ...ctx, _depth: (ctx._depth ?? 0) + 1, _ids: ctx._ids }))
    }
    default: return null
  }
}

/**
 * Group blocks into sections the way the coded legal pages are laid out: an h2 starts a
 * section; an hr closes it and renders the divider between sections.
 */
function renderRichBlocks(doc: RichText, ctx: RenderCtx): ReactNode[] {
  const st = styleFor(ctx.variant)
  const out: ReactNode[] = []
  let section: ReactNode[] = []
  let heading: ReactNode | null = null
  let anchor: string | null = null
  let sectionKey = 0
  const ids = ctx._ids ?? new Set<string>()
  const closeSection = () => {
    if (heading === null && section.length === 0) return
    const k = `s${sectionKey++}`
    out.push(h('section', { key: k, className: st.section || undefined, ...(anchor ? { id: anchor, 'aria-labelledby': `${anchor}-h` } : {}) },
      heading,
      section.length ? h('div', { className: st.stack }, ...section) : null))
    heading = null; anchor = null; section = []
  }
  doc.blocks.forEach((b, i) => {
    const key = `b${i}`
    if (b.t === 'hr') { closeSection(); out.push(renderBlock(b, key, st, ctx)); return }
    if (b.t === 'h2') {
      closeSection()
      // Anchor from the heading text (so /support/shipping-returns#returns keeps working).
      const base = slugify(b.c.map(n => n.text).join('')) || `section-${sectionKey + 1}`
      let id = base, n = 2
      while (ids.has(id)) id = `${base}-${n++}`
      ids.add(id); anchor = id
      heading = h('h2', { key, id: `${id}-h`, className: st.h2 }, renderInline(b.c, st))
      return
    }
    const node = renderBlock(b, key, st, ctx)
    if (node !== null) section.push(node)
  })
  closeSection()
  return out
}

/** Render a RichText document inside the variant's wrapper. */
export function renderRichText(doc: RichText | null | undefined, ctx: RenderCtx = {}): ReactNode {
  if (!doc || doc.blocks.length === 0) return null
  const st = styleFor(ctx.variant)
  return h('div', { className: st.wrap }, ...renderRichBlocks(doc, { ...ctx, _ids: ctx._ids ?? new Set<string>() }))
}
