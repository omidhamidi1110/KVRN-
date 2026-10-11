'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'

type ChatItem = {
  id: number; who: 'owner' | 'chief'; text: string; worker?: string
  modelUsed?: boolean; model?: string; evidenceTopics?: string[]; unavailableTopics?: string[]
}
type ChiefReadiness = {
  paidAvailable: boolean; status: string; blockers: string[]
  models: { cheap: string; business: string; finance: string; video: string }
  videoRouting?: { agent: string; provider: string; model: string; apiVersion: string; configured: boolean; videoRequestTested: boolean } | null
  budgetMode?: string
}

const readOnlyNotice = 'Read-only. Chief cannot send messages, change orders, modify inventory, issue refunds, publish content, or deploy code from this chat.'
const detailText = 'Chief can inspect authorized read-only records and queue the existing QA registry monitor. Chat cannot launch browser tests, send marketing, issue refunds, edit products, or deploy. Conversation history remains in this browser tab and is not stored as a chat transcript. Do not enter secrets or customer personal information.'
const suggested = [
  'Audit all 11 AI agents and recent failures',
  'Review workforce, model routing, budget and QA readiness',
  'What requires my attention in finance and inventory?',
]

function EyeIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>
  </svg>
}

/** Hover on desktop, keyboard focus or tap on mobile. Uses native details (no dependency). */
function Reveal({ label, children }: { label: string; children: ReactNode }) {
  return <details className="group relative inline-flex shrink-0 items-center">
    <summary title={label} aria-label={label} className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-lg border border-black/[0.08] bg-white text-black/40 transition hover:border-black/20 hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/30 [&::-webkit-details-marker]:hidden">
      <EyeIcon/>
    </summary>
    <div role="note" className="invisible absolute right-0 top-full z-30 w-[min(310px,80vw)] rounded-xl border border-black/[0.10] bg-white p-3 text-left text-[11px] font-normal leading-5 text-black/65 opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 group-open:visible group-open:opacity-100">
      {children}
    </div>
  </details>
}

function cleanReply(value: string) {
  return value.replace(new RegExp(`\\n*${readOnlyNotice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '').trim()
}

export function ChiefChatClient() {
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [reasoning, setReasoning] = useState(false)
  const [modelRole, setModelRole] = useState<'cheap' | 'business'>('cheap')
  const [readiness, setReadiness] = useState<ChiefReadiness | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const bottom = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    let active = true
    fetch('/api/admin/ai/chief/readiness', { cache: 'no-store' })
      .then(res => res.ok ? res.json() : null)
      .then((data: ChiefReadiness | null) => { if (active && data) setReadiness(data) })
      .catch(() => {})
    return () => { active = false }
  }, [])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [items.length, busy])

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const message = input.trim()
    if (message.length < 2 || busy) return
    const stamp = Date.now()
    const history = items.slice(-6).map(item => ({ who: item.who, text: item.text.slice(0, 1200) }))
    setItems(old => [...old, { id: stamp, who: 'owner', text: message }])
    setInput(''); setBusy(true); setError('')
    try {
      const res = await fetch('/api/admin/ai/chief/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ mode: 'message', message, reasoning, modelRole, history }),
      })
      const body = await res.json()
      if (!res.ok) throw Error(body.error || 'Chief could not load a verified report.')
      setItems(old => [...old, {
        id: stamp + 1, who: 'chief', text: String(body.reply),
        worker: body.worker, modelUsed: Boolean(body.modelUsed),
        model: typeof body.model === 'string' ? body.model : undefined,
        evidenceTopics: Array.isArray(body.evidenceTopics) ? body.evidenceTopics : undefined,
        unavailableTopics: Array.isArray(body.unavailableTopics) ? body.unavailableTopics : undefined,
      }])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Chief chat failed.')
      // The owner should not lose a long audit prompt if the network/request fails.
      setInput(current => current || message)
    } finally { setBusy(false) }
  }

  async function queueMonitor(monitor: 'qa' | 'inventory' | 'finance') {
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/admin/ai/chief/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ mode: 'queue_readonly_monitor', monitor }),
      })
      const body = await res.json()
      if (!res.ok) throw Error(body.error || 'Unable to queue the monitor.')
      setItems(old => [...old, { id: Date.now(), who: 'chief', worker: 'Engineering, QA & Security', text: body.message, modelUsed: false }])
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Unable to queue the monitor.') }
    finally { setBusy(false) }
  }

  return <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-4 py-5 sm:px-7 sm:py-8 lg:px-10">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.18em] text-black/35">KVRN AI Operating System</p>
        <h1 className="text-[26px] font-medium tracking-[-0.035em] text-[#171717] sm:text-[30px]">Chat with Chief</h1>
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden text-[10px] font-medium text-black/35 sm:inline">Read-only</span>
        <Reveal label="View chat permissions and safety details">{detailText}</Reveal>
        <Link className="inline-flex h-9 items-center rounded-lg border border-black/[0.09] bg-white px-3 text-[11px] font-medium text-black/65 transition hover:border-black/20" href="/admin/ai">AI Operations</Link>
      </div>
    </header>

    {readiness && !readiness.paidAvailable && <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[11px] text-amber-900">
      <span>Paid reasoning is unavailable. Deterministic read-only reports are still available.</span>
      <Reveal label="View paid reasoning blockers">{readiness.blockers.join(' · ') || 'Paid inference has not been verified.'}</Reveal>
    </div>}

    <section className="flex min-h-[560px] flex-col overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-[0_3px_24px_rgba(0,0,0,0.025)] sm:min-h-[630px]" aria-label="Chief conversation">
      <div className="flex items-center justify-between gap-3 border-b border-black/[0.06] px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#161616] text-[13px] font-medium tracking-[-0.07em] text-white" aria-hidden="true">K</span>
          <div className="min-w-0"><h2 className="text-[13px] font-semibold text-[#171717]">Chief Operator</h2><p className="text-[10px] text-black/40">KVRN operations · Verified evidence</p></div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${readiness?.paidAvailable ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden="true"/>
          <span className="text-[10px] text-black/45">{readiness?.paidAvailable ? 'AI ready' : readiness ? 'Reports only' : 'Checking'}</span>
          <Reveal label="AI model, routing and availability details">
            <p>Paid reasoning: {readiness?.paidAvailable ? 'Available' : 'Unavailable or unverified'}</p>
            <p>Default: {readiness?.models?.cheap ?? 'Claude Haiku 5.5'}</p>
            <p>Business: {readiness?.models?.business ?? 'Claude Sonnet 5.5'}</p>
            <p>Readiness does not test provider responses or data freshness.</p>
            {readiness?.videoRouting && <p>Video routing: {readiness.videoRouting.provider} / {readiness.videoRouting.model}, configured: {readiness.videoRouting.configured ? 'yes' : 'no'}, live video tested: {readiness.videoRouting.videoRequestTested ? 'yes' : 'no'}</p>}
          </Reveal>
        </div>
      </div>

      <div className="h-[min(54vh,590px)] min-h-[305px] flex-1 space-y-4 overflow-y-auto bg-[#FAFAF9] px-3 py-5 sm:px-6 sm:py-6" role="log" aria-label="Chief conversation" aria-live="polite">
        {items.length === 0 && <div className="mx-auto flex h-full max-w-[490px] flex-col items-center justify-center py-8 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-black/[0.08] bg-white text-[18px] font-medium tracking-[-0.08em]">K</div>
          <h3 className="text-[17px] font-medium tracking-tight text-black/80">What should Chief review?</h3>
          <p className="mt-2 max-w-[370px] text-[12px] leading-5 text-black/45">Ask about your agents, finances, inventory, QA, or the state of the business. Chief only uses authorized reports.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {suggested.map(prompt => <button key={prompt} type="button" onClick={() => { setInput(prompt); inputRef.current?.focus() }} className="rounded-full border border-black/[0.08] bg-white px-3 py-2 text-left text-[10px] text-black/65 transition hover:border-black/25 hover:text-black">{prompt}</button>)}
          </div>
        </div>}
        {items.map(item => <div key={item.id} className={`flex ${item.who === 'owner' ? 'justify-end' : 'justify-start'}`}>
          <div className={`min-w-0 max-w-[95%] rounded-2xl px-4 py-3 sm:max-w-[85%] sm:px-5 ${item.who === 'owner' ? 'rounded-br-md bg-[#171717] text-white' : 'rounded-bl-md border border-black/[0.07] bg-white text-[#171717]'}`}>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className={`text-[10px] font-medium ${item.who === 'owner' ? 'text-white/65' : 'text-black/50'}`}>{item.who === 'owner' ? 'You' : 'Chief'}</span>
              {item.who === 'chief' && <Reveal label="View model and evidence sources">
                <p>Route: {item.worker ?? 'Executive'}</p>
                <p>Response: {item.modelUsed ? `Paid AI (${item.model || 'verified model'})` : 'Deterministic, no model used'}</p>
                <p>Sources: {item.evidenceTopics?.join(', ') || 'Not supplied'}</p>
                {!!item.unavailableTopics?.length && <p>Unavailable: {item.unavailableTopics.join(', ')}</p>}
                <p>{readOnlyNotice}</p>
              </Reveal>}
            </div>
            <div className="whitespace-pre-wrap break-words text-[12px] leading-[1.85] sm:text-[13px]">{item.who === 'chief' ? cleanReply(item.text) : item.text}</div>
          </div>
        </div>)}
        {busy && <div className="flex items-center gap-2 px-1 text-[11px] text-black/40"><span className="h-2 w-2 animate-pulse rounded-full bg-black/40"/>Chief is reviewing the records…</div>}
        <div ref={bottom} />
      </div>

      <form onSubmit={send} className="border-t border-black/[0.06] bg-white px-3 py-3 sm:px-5 sm:py-4">
        {error && <div role="alert" className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[11px] text-red-700">{error}</div>}
        <label htmlFor="chief-message" className="sr-only">Message Chief</label>
        <textarea ref={inputRef} id="chief-message" rows={2} maxLength={3500} value={input} onChange={e => setInput(e.target.value)} placeholder="Message Chief…" className="max-h-44 min-h-[64px] w-full resize-y rounded-xl border border-black/[0.09] bg-[#FAFAF9] px-3.5 py-3 text-[12px] leading-5 text-black/85 outline-none placeholder:text-black/30 focus:border-black/25 focus:ring-2 focus:ring-black/[0.03] sm:text-[13px]" />
        <div className="mt-2.5 flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 text-[11px] font-medium text-black/65">
              <input type="checkbox" checked={reasoning} onChange={e => setReasoning(e.target.checked)} disabled={!readiness?.paidAvailable} className="accent-[#171717]" />Paid reasoning
            </label>
            {reasoning && <label className="flex items-center gap-1.5 text-[11px] text-black/45"><span className="sr-only">AI model</span>
              <select aria-label="Chief model" value={modelRole} onChange={e => setModelRole(e.target.value === 'business' ? 'business' : 'cheap')} className="rounded-lg border border-black/[0.09] bg-white px-2 py-1.5 text-[11px] text-black/70">
                <option value="cheap">Haiku 5.5</option><option value="business">Sonnet 5.5</option>
              </select>
            </label>}
            <Reveal label="Paid model and chat safeguards">
              {reasoning ? 'Paid reasoning sends this prompt, recent bounded conversation and read-only aggregated evidence through the configured AI Gateway. Spending limits and owner lock remain enforced.' : 'No paid AI reasoning. Chief returns deterministic read-only reports.'}
            </Reveal>
            <Reveal label="Request a safe departmental monitoring task">
              <p className="mb-2 font-medium text-black/75">Request a department check</p>
              <p className="mb-2">Requests are queued for the next worker cycle. They check existing business data, may record AI actions and alerts, but do not mutate financial or inventory records, send messages or execute browser tests.</p>
              <div className="grid gap-1.5">
                <button type="button" disabled={busy} onClick={() => queueMonitor('qa')} className="rounded-lg border border-black/10 px-2 py-1.5 text-left hover:bg-black/[0.03] disabled:opacity-40">Engineering · QA registry</button>
                <button type="button" disabled={busy} onClick={() => queueMonitor('inventory')} className="rounded-lg border border-black/10 px-2 py-1.5 text-left hover:bg-black/[0.03] disabled:opacity-40">Inventory · stock health</button>
                <button type="button" disabled={busy} onClick={() => queueMonitor('finance')} className="rounded-lg border border-black/10 px-2 py-1.5 text-left hover:bg-black/[0.03] disabled:opacity-40">Finance · payment exceptions</button>
              </div>
            </Reveal>
          </div>
          <div className="flex items-center gap-3">
            {input.length > 2500 && <span className="text-[10px] tabular-nums text-black/35">{input.length}/3500</span>}
            <button disabled={busy || input.trim().length < 2} type="submit" className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-[#171717] px-4 py-2 text-[11px] font-medium text-white transition hover:bg-black/85 disabled:opacity-40">{busy ? 'Working…' : 'Send'}<span aria-hidden="true">↗</span></button>
          </div>
        </div>
      </form>
    </section>
  </div>
}
