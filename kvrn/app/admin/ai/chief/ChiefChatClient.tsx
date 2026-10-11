'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'

type ChatItem = { id: number; who: 'owner' | 'chief'; text: string; worker?: string; modelUsed?: boolean }

export function ChiefChatClient() {
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [reasoning, setReasoning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const message = input.trim()
    if (!message || busy) return
    const stamp = Date.now()
    setItems(old => [...old, { id: stamp, who: 'owner', text: message }])
    setInput(''); setBusy(true); setError('')
    try {
      const res = await fetch('/api/admin/ai/chief/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ mode: 'message', message, reasoning, history: items.slice(-6).map(item => ({ who: item.who, text: item.text.slice(0,1200) })) }),
      })
      const body = await res.json()
      if (!res.ok) throw Error(body.error || 'Chief could not load a verified report.')
      setItems(old => [...old, { id: stamp + 1, who: 'chief', text: String(body.reply),
        worker: body.worker, modelUsed: Boolean(body.modelUsed) }])
    } catch (err: any) {
      setError(String(err?.message || 'Chief chat failed.'))
    } finally { setBusy(false) }
  }

  async function queueQa() {
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/admin/ai/chief/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ mode: 'queue_qa_monitor' }),
      })
      const body = await res.json()
      if (!res.ok) throw Error(body.error || 'Unable to queue the monitor.')
      setItems(old => [...old, { id: Date.now(), who: 'chief', worker: 'Engineering, QA & Security', text: body.message, modelUsed: false }])
    } catch (err: any) { setError(String(err?.message || 'Unable to queue the monitor.')) }
    finally { setBusy(false) }
  }

  return <div className="mx-auto max-w-[1200px] px-5 py-8 sm:px-7 lg:px-10 lg:py-10">
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.18em] text-black/35">KVRN AI Operating System</p>
        <h1 className="text-[30px] font-medium tracking-[-0.035em] text-[#171717]">Chat with Chief</h1>
        <p className="mt-2 max-w-2xl text-[12px] leading-5 text-black/50">Ask Chief about site QA, inventory, finance, marketing consent and operations. Chief routes read-only reports to the matching department.</p>
      </div>
      <Link className="rounded-lg border border-black/10 bg-white px-4 py-2.5 text-[11px] font-medium" href="/admin/ai">Back to AI Operations</Link>
    </div>
    <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-[12px] leading-5 text-amber-900">
      <strong>Read-only phase.</strong> Chief can inspect canonical status and request the existing QA registry monitor. Chat cannot run browser tests, issue refunds, change data, send messages, publish, or deploy. Conversations are only retained in this tab and are not saved to the database. Do not enter passwords, tokens or customer personal data.
    </div>
    <section className="overflow-hidden rounded-xl border border-black/[0.07] bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.06] px-5 py-4">
        <div><h2 className="text-[15px] font-medium">Chief Operator</h2><p className="mt-1 text-[11px] text-black/40">Worker routing • Verified read-only evidence</p></div>
        <button type="button" onClick={queueQa} disabled={busy} className="rounded-lg border border-black/10 px-3 py-2 text-[11px] font-medium disabled:opacity-50">Queue QA health check</button>
      </div>
      <div className="min-h-[260px] max-h-[550px] space-y-4 overflow-y-auto bg-[#FAFAF9] p-4 sm:p-6" role="log" aria-label="Chief conversation" aria-live="polite">
        {items.length === 0 && <div className="max-w-xl text-[12px] leading-6 text-black/50">Ask “What is the status of my 25 QA features?”, “Any inventory issues?”, or “What needs my attention?” A QA registry check only inspects recorded results; it does not launch a browser runner.</div>}
        {items.map(item => <div key={item.id} className={`flex ${item.who === 'owner' ? 'justify-end' : 'justify-start'}`}>
          <div className={`max-w-[95%] rounded-xl p-4 sm:max-w-[82%] ${item.who === 'owner' ? 'bg-[#171717] text-white' : 'border border-black/[0.07] bg-white text-[#171717]'}`}>
            <p className={`mb-2 text-[10px] font-medium ${item.who === 'owner' ? 'text-white/60' : 'text-black/45'}`}>{item.who === 'owner' ? 'You' : `Chief → ${item.worker ?? 'Executive'}`}{item.who === 'chief' && !item.modelUsed ? ' · Deterministic report' : item.modelUsed ? ' · Paid AI reasoning' : ''}</p>
            <p className="whitespace-pre-wrap break-words text-[12px] leading-6">{item.text}</p>
          </div>
        </div>)}
        {busy && <p className="text-[11px] text-black/40">Chief is checking canonical reports…</p>}
      </div>
      <form onSubmit={send} className="space-y-3 border-t border-black/[0.06] p-4 sm:p-5">
        {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-[11px] text-red-700">{error}</div>}
        <label htmlFor="chief-message" className="block text-[11px] font-medium text-black/70">Message Chief</label>
        <textarea id="chief-message" rows={3} maxLength={1000} value={input} onChange={e => setInput(e.target.value)} placeholder="Ask a question or describe what you want an agent to investigate…" className="w-full rounded-lg border border-black/10 px-3 py-2.5 text-[12px] outline-none focus:ring-2 focus:ring-black/10" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-[11px] text-black/60"><input type="checkbox" checked={reasoning} onChange={e => setReasoning(e.target.checked)} />Use paid AI reasoning when configured (sends this message, recent chat and read-only aggregate evidence to your configured AI provider)</label>
          <button disabled={busy || input.trim().length < 2} type="submit" className="rounded-lg bg-[#171717] px-5 py-2.5 text-[11px] font-medium text-white disabled:opacity-40">{busy ? 'Working…' : 'Send to Chief'}</button>
        </div>
      </form>
    </section>
  </div>
}
