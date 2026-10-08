'use client'
// Block-based editor for the structured rich text model (lib/content-richtext.ts).
//
// Editors never see JSON or HTML. Text blocks use a tiny inline markup — **bold**, *italic*,
// [label](link) — with toolbar buttons. Blocks can be reordered and removed. What is saved is
// the validated model; the server re-validates everything on save and on publish.

import { useEffect, useMemo, useRef, useState, createElement, type ReactNode } from 'react'
import { AdminButton, AdminNotice, adminInputClass } from '@/components/admin/ui/AdminUI'
import { MediaField, cx, textareaClass } from './ui'
import { api } from './api'
import { renderRichText, type RichVariant } from '@/components/content/render-richtext'
import {
  inlineToMarkup, markupToInline, collectMediaIds, collectBlockRefs, emptyRichText, RICH_LIMITS,
  type RichText, type RichBlock, type Inline,
} from '@/lib/content-richtext'

export interface BlockChoice { id: string; name: string }
export interface RichTextEditorProps {
  value: RichText
  onChange: (v: RichText) => void
  /** Reusable blocks that may be inserted (published ones). Omit to disable the option. */
  blockChoices?: BlockChoice[]
  allowCookieControls?: boolean
  allowMedia?: boolean
  /** Compact = only paragraphs / lists / links (FAQ answers, short notes). */
  compact?: boolean
  label?: string
  variant?: RichVariant
}

// ── inline markup field ───────────────────────────────────────────────────────

/** Text state that survives the markup <-> model round trip without cursor jumps. */
function useMarkup(inline: Inline, onInline: (c: Inline) => void) {
  const [text, setText] = useState(() => inlineToMarkup(inline))
  useEffect(() => {
    if (JSON.stringify(markupToInline(text)) !== JSON.stringify(inline)) setText(inlineToMarkup(inline))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(inline)])
  return { text, set: (v: string) => { setText(v); onInline(markupToInline(v)) } }
}

function Toolbar({ taRef, apply }: { taRef: React.RefObject<HTMLTextAreaElement>; apply: (v: string) => void }) {
  const wrap = (open: string, close: string, link = false) => {
    const el = taRef.current; if (!el) return
    const { selectionStart: s, selectionEnd: e, value } = el
    const sel = value.slice(s, e) || (link ? 'link text' : 'text')
    const inner = link ? `[${sel}](https://)` : `${open}${sel}${close}`
    apply(value.slice(0, s) + inner + value.slice(e))
    requestAnimationFrame(() => { el.focus() })
  }
  return (
    <div className="mb-1 flex gap-1" role="toolbar" aria-label="Text formatting">
      <AdminButton size="sm" variant="ghost" aria-label="Bold" onClick={() => wrap('**', '**')}><b>B</b></AdminButton>
      <AdminButton size="sm" variant="ghost" aria-label="Italic" onClick={() => wrap('*', '*')}><i>I</i></AdminButton>
      <AdminButton size="sm" variant="ghost" aria-label="Link" onClick={() => wrap('', '', true)}>Link</AdminButton>
    </div>
  )
}

function InlineField({ inline, onInline, rows = 2, label, placeholder }: { inline: Inline; onInline: (c: Inline) => void; rows?: number; label: string; placeholder?: string }) {
  const m = useMarkup(inline, onInline)
  const ref = useRef<HTMLTextAreaElement>(null)
  return (
    <div>
      <Toolbar taRef={ref} apply={m.set} />
      <textarea ref={ref} aria-label={label} rows={rows} value={m.text} placeholder={placeholder} onChange={e => m.set(e.target.value)} className={textareaClass} />
    </div>
  )
}

/** One markup line per list item. */
function LinesField({ items, onItems, label, rows = 4 }: { items: Inline[]; onItems: (c: Inline[]) => void; label: string; rows?: number }) {
  const toText = (xs: Inline[]) => xs.map(inlineToMarkup).join('\n')
  const [text, setText] = useState(() => toText(items))
  useEffect(() => {
    const parsed = text.split('\n').filter(l => l.trim() !== '').map(markupToInline)
    if (JSON.stringify(parsed) !== JSON.stringify(items)) setText(toText(items))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(items)])
  return (
    <textarea aria-label={label} rows={rows} value={text} placeholder="One item per line" className={textareaClass}
      onChange={e => { setText(e.target.value); onItems(e.target.value.split('\n').filter(l => l.trim() !== '').map(markupToInline)) }} />
  )
}

/** Free text split by a separator; kept as raw text locally so typing a trailing separator works. */
function RawField<T>({ value, parse, print, onValue, label, rows = 4, placeholder }: {
  value: T; parse: (s: string) => T; print: (v: T) => string; onValue: (v: T) => void; label: string; rows?: number; placeholder?: string
}) {
  const [text, setText] = useState(() => print(value))
  useEffect(() => {
    if (JSON.stringify(parse(text)) !== JSON.stringify(value)) setText(print(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)])
  return <textarea aria-label={label} rows={rows} value={text} placeholder={placeholder} className={textareaClass}
    onChange={e => { setText(e.target.value); onValue(parse(e.target.value)) }} />
}

// ── per-block editors ─────────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = {
  h2: 'Section heading', h3: 'Sub-heading', p: 'Paragraph', ul: 'Bullet list', ol: 'Numbered list', hr: 'Divider',
  media: 'Image', callout: 'Callout', table: 'Table', cards: 'Cards', defs: 'Definitions', embed: 'Cookie controls', blockref: 'Reusable block',
}

function BlockBody({ b, set, choices }: { b: RichBlock; set: (b: RichBlock) => void; choices: BlockChoice[] }) {
  switch (b.t) {
    case 'h2': case 'h3': case 'p':
      return <InlineField inline={b.c} onInline={c => set({ ...b, c })} rows={b.t === 'p' ? 4 : 1} label={TYPE_LABEL[b.t]} />
    case 'ul': case 'ol':
      return <LinesField items={b.items} onItems={items => set({ ...b, items })} label={TYPE_LABEL[b.t]} />
    case 'hr':
      return <p className="text-[11px] text-[#8A8A85]">A thin line between sections.</p>
    case 'media':
      return (
        <div className="space-y-2">
          <MediaField label="Image" assetId={b.assetId || undefined} onChange={id => set({ ...b, assetId: id ?? '' })} />
          <input aria-label="Caption" placeholder="Caption (optional)" value={b.caption ?? ''} className={adminInputClass}
            onChange={e => set({ ...b, caption: e.target.value || undefined })} />
        </div>
      )
    case 'callout':
      return (
        <div className="space-y-2">
          <input aria-label="Callout title" placeholder="Title (optional)" value={b.title ?? ''} className={adminInputClass} onChange={e => set({ ...b, title: e.target.value || undefined })} />
          <RawField value={b.paras} label="Callout text" rows={3} placeholder="Blank line between paragraphs"
            parse={s => s.split(/\n{2,}/).filter(x => x.trim()).map(markupToInline)} print={v => v.map(inlineToMarkup).join('\n\n')} onValue={paras => set({ ...b, paras })} />
        </div>
      )
    case 'table':
      return (
        <div className="space-y-2">
          <input aria-label="Table description" placeholder="Short description for screen readers" value={b.label} className={adminInputClass} onChange={e => set({ ...b, label: e.target.value })} />
          <RawField value={{ h: b.headers, r: b.rows }} label="Table" rows={6}
            placeholder={'First line = column headings, separated by |\nThen one row per line: cell | cell | cell'}
            parse={s => {
              const lines = s.split('\n').filter(l => l.trim() !== '')
              const cut = (l: string) => l.split('|').map(x => x.trim())
              return { h: lines.length ? cut(lines[0]) : [], r: lines.slice(1).map(l => cut(l).map(markupToInline)) }
            }}
            print={v => [v.h.join(' | '), ...v.r.map(row => row.map(inlineToMarkup).join(' | '))].join('\n')}
            onValue={v => set({ ...b, headers: v.h, rows: v.r })} />
          <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={!!b.mono} onChange={e => set({ ...b, mono: e.target.checked || undefined })} className="accent-[#171717]" /> Monospace first column</label>
        </div>
      )
    case 'cards':
      return <RawField value={b.items} label="Cards" rows={4} placeholder="Label | Text — one card per line"
        parse={s => s.split('\n').filter(l => l.trim()).map(l => { const [a, ...r] = l.split('|'); return { label: a.trim(), text: r.join('|').trim() } })}
        print={v => v.map(c => `${c.label} | ${c.text}`).join('\n')} onValue={items => set({ ...b, items })} />
    case 'defs':
      return <RawField value={b.items} label="Definitions" rows={6} placeholder={'Term\nFirst line\nSecond line\n\nNext term\n…'}
        parse={s => s.split(/\n{2,}/).map(g => g.split('\n').map(x => x.trim()).filter(Boolean)).filter(g => g.length).map(g => ({ title: g[0], lines: g.slice(1) }))}
        print={v => v.map(d => [d.title, ...d.lines].join('\n')).join('\n\n')} onValue={items => set({ ...b, items })} />
    case 'embed':
      return <p className="text-[11px] text-[#8A8A85]">The visitor’s cookie preference controls appear here.</p>
    case 'blockref':
      return (
        <div>
          <select aria-label="Reusable block" value={b.blockId} onChange={e => set({ ...b, blockId: e.target.value })} className={adminInputClass}>
            <option value="">Choose a block…</option>
            {choices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            {b.blockId && !choices.some(c => c.id === b.blockId) && <option value={b.blockId}>(unavailable block)</option>}
          </select>
          <p className="mt-1 text-[11px] text-[#8A8A85]">Shows the block’s published text. Editing the block updates every page that uses it.</p>
        </div>
      )
  }
}

const NEW_BLOCK: Record<string, () => RichBlock> = {
  h2: () => ({ t: 'h2', c: [] }), h3: () => ({ t: 'h3', c: [] }), p: () => ({ t: 'p', c: [] }),
  ul: () => ({ t: 'ul', items: [[]] }), ol: () => ({ t: 'ol', items: [[]] }), hr: () => ({ t: 'hr' }),
  media: () => ({ t: 'media', assetId: '' }), callout: () => ({ t: 'callout', paras: [[]] }),
  table: () => ({ t: 'table', label: '', headers: ['', ''], rows: [[[], []]] }),
  cards: () => ({ t: 'cards', items: [{ label: '', text: '' }] }), defs: () => ({ t: 'defs', items: [{ title: '', lines: [''] }] }),
  embed: () => ({ t: 'embed', kind: 'cookie-controls' }), blockref: () => ({ t: 'blockref', blockId: '' }),
}

export function RichTextEditor({ value, onChange, blockChoices, allowCookieControls, allowMedia = true, compact, label = 'Content', variant = 'plain' }: RichTextEditorProps) {
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [add, setAdd] = useState('p')
  const doc = value ?? emptyRichText()
  const kinds = useMemo(() => {
    const k = compact ? ['p', 'ul', 'ol'] : ['h2', 'h3', 'p', 'ul', 'ol', 'hr', 'callout', 'table', 'cards', 'defs']
    if (allowMedia && !compact) k.push('media')
    if (blockChoices && !compact) k.push('blockref')
    if (allowCookieControls) k.push('embed')
    return k
  }, [compact, allowMedia, blockChoices, allowCookieControls])
  const setBlocks = (blocks: RichBlock[]) => onChange({ v: 1, blocks })
  const move = (i: number, d: number) => {
    const j = i + d; if (j < 0 || j >= doc.blocks.length) return
    const next = doc.blocks.slice(); const [x] = next.splice(i, 1); next.splice(j, 0, x); setBlocks(next)
  }
  return (
    <div className="space-y-2" aria-label={label}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-[#4A4A46]">{label}</span>
        <div className="flex gap-1" role="tablist" aria-label={`${label} view`}>
          {(['edit', 'preview'] as const).map(t => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={cx('rounded-[8px] px-2.5 py-1 text-[11px] font-medium', tab === t ? 'bg-[#171717] text-white' : 'text-[#4A4A46] hover:bg-black/[0.05]')}>
              {t === 'edit' ? 'Edit' : 'Preview'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'preview' ? <RichPreview doc={doc} variant={variant} /> : (
        <>
          {doc.blocks.length === 0 && <p className="rounded-[10px] border border-dashed border-black/[0.16] px-3 py-4 text-center text-[12px] text-[#8A8A85]">Nothing here yet. Add a block below.</p>}
          {doc.blocks.map((b, i) => (
            <div key={i} className="rounded-[12px] border border-black/[0.10] bg-white p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#8A8A85]">{TYPE_LABEL[b.t]}</span>
                <div className="flex gap-1">
                  <AdminButton size="sm" variant="ghost" aria-label="Move block up" disabled={i === 0} onClick={() => move(i, -1)}>Up</AdminButton>
                  <AdminButton size="sm" variant="ghost" aria-label="Move block down" disabled={i === doc.blocks.length - 1} onClick={() => move(i, 1)}>Down</AdminButton>
                  <AdminButton size="sm" variant="ghost" aria-label="Remove block" onClick={() => setBlocks(doc.blocks.filter((_, j) => j !== i))}>Remove</AdminButton>
                </div>
              </div>
              <BlockBody b={b} choices={blockChoices ?? []} set={nb => setBlocks(doc.blocks.map((x, j) => (j === i ? nb : x)))} />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Block type to add" value={add} onChange={e => setAdd(e.target.value)} className={cx(adminInputClass, '!w-[190px]')}>
              {kinds.map(k => <option key={k} value={k}>{TYPE_LABEL[k]}</option>)}
            </select>
            <AdminButton size="sm" disabled={doc.blocks.length >= RICH_LIMITS.blocks} onClick={() => setBlocks([...doc.blocks, NEW_BLOCK[add]()])}>Add block</AdminButton>
            {!compact && <span className="text-[11px] text-[#8A8A85]">Section headings start a new section on the page.</span>}
          </div>
        </>
      )}
    </div>
  )
}

// ── preview ───────────────────────────────────────────────────────────────────

export function RichPreview({ doc, variant = 'plain' }: { doc: RichText; variant?: RichVariant }) {
  const mediaIds = collectMediaIds(doc).filter(Boolean), blockIds = collectBlockRefs(doc).filter(Boolean)
  const key = mediaIds.join(',') + '|' + blockIds.join(',')
  const [ctx, setCtx] = useState<{ media: any; blocks: any }>({ media: {}, blocks: {} })
  const [missing, setMissing] = useState<string[]>([])
  useEffect(() => {
    let live = true
    if (!mediaIds.length && !blockIds.length) { setCtx({ media: {}, blocks: {} }); setMissing([]); return }
    api('GET', `/api/admin/content/preview-context?media=${mediaIds.join(',')}&blocks=${blockIds.join(',')}`).then(r => {
      if (!live || !r.ok) return
      setCtx(r.data)
      setMissing([...mediaIds.filter(id => !r.data.media[id]), ...blockIds.filter(id => !r.data.blocks[id])])
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const placeholder = createElement('div', { className: 'rounded-[10px] border border-dashed border-black/[0.2] p-3 text-[12px] text-[#8A8A85]' }, 'Cookie preference controls appear here.')
  const node: ReactNode = renderRichText(doc, { variant, media: ctx.media, blocks: ctx.blocks, embeds: { 'cookie-controls': placeholder } })
  return (
    <div className="rounded-[12px] border border-black/[0.10] bg-[#F9F8F6] p-4">
      {missing.length > 0 && <AdminNotice tone="warning" className="mb-3">Some images or reusable blocks are missing, archived or not published yet. They will be left out of the live page.</AdminNotice>}
      {node ?? <p className="text-[12px] text-[#8A8A85]">Nothing to preview yet.</p>}
    </div>
  )
}
