// Renders an affiliate document from typed blocks as TEXT NODES only. No HTML is ever injected.
import { parseDocument, type DocInline } from '@/lib/affiliate-program-docs'

function Inline({ parts }: { parts: DocInline[] }) {
  return <>{parts.map((p, i) => p.bold ? <strong key={i} className="font-normal text-kvrn-text">{p.text}</strong> : <span key={i}>{p.text}</span>)}</>
}

export function DocumentBody({ body }: { body: string }) {
  const blocks = parseDocument(body)
  return (
    <div className="space-y-4 text-[14px] text-kvrn-muted leading-relaxed">
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          const cls = b.level === 1 ? 'text-[22px] font-light text-kvrn-text pt-4' : b.level === 2 ? 'text-[16px] font-light text-kvrn-text pt-3' : 'text-[14px] text-kvrn-text pt-2'
          return b.level === 1 ? <h2 key={i} className={cls}><Inline parts={b.inline} /></h2>
            : b.level === 2 ? <h3 key={i} className={cls}><Inline parts={b.inline} /></h3>
            : <h4 key={i} className={cls}><Inline parts={b.inline} /></h4>
        }
        if (b.type === 'list') {
          return <ul key={i} className="list-disc pl-5 space-y-1.5">{b.items.map((it, j) => <li key={j}><Inline parts={it} /></li>)}</ul>
        }
        return <p key={i}><Inline parts={b.inline} /></p>
      })}
    </div>
  )
}
