'use client'
// Renders a program document as React text nodes via the safe markdown-lite parser. No raw-HTML sinks.
import { useEffect, useState } from 'react'
import { parseMarkdownLite, portalFetch, type Inline } from '@/lib/affiliate-portal-ui'

function Inlines({ items }: { items: Inline[] }) {
  return <>{items.map((i, k) => i.t === 'bold' ? <strong key={k}>{i.v}</strong>
    : i.t === 'link' ? <a key={k} href={i.href} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">{i.v}</a>
    : <span key={k}>{i.v}</span>)}</>
}

export function DocumentView({ docType }: { docType: string }) {
  const [doc, setDoc] = useState<{ title: string; version: string; body: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setDoc(null); setErr(null)
    portalFetch<{ document: { title: string; version: string; body: string } }>(`/api/affiliate/documents/${encodeURIComponent(docType)}`).then(r => {
      if (!live) return
      if (r.ok && r.data) setDoc(r.data.document); else setErr(r.error ?? 'Could not load the document.')
    })
    return () => { live = false }
  }, [docType])
  if (err) return <p role="alert" className="mt-3 text-[12px] text-[#991B1B]">{err}</p>
  if (!doc) return <p role="status" className="mt-3 text-[12px] text-[#6B6B66]">Loading…</p>
  const blocks = parseMarkdownLite(doc.body)
  return (
    <article className="mt-3 max-h-[420px] overflow-y-auto rounded-[10px] bg-[#FAFAF8] p-4 text-[13px] leading-[1.6]">
      <p className="mb-2 text-[11px] text-[#8A8A85]">{doc.title} · version {doc.version}</p>
      {blocks.map((b, i) => b.t === 'h' ? <h3 key={i} className="mb-1 mt-3 font-medium"><Inlines items={b.inline} /></h3>
        : b.t === 'p' ? <p key={i} className="mb-2"><Inlines items={b.inline} /></p>
        : b.t === 'ul' ? <ul key={i} className="mb-2 list-disc pl-5">{b.items.map((it, j) => <li key={j}><Inlines items={it} /></li>)}</ul>
        : <ol key={i} className="mb-2 list-decimal pl-5">{b.items.map((it, j) => <li key={j}><Inlines items={it} /></li>)}</ol>)}
    </article>
  )
}
